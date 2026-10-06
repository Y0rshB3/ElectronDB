import { join } from 'node:path'
import {
  CANCELLED_MESSAGE,
  JOB_LOG_FLUSH_MS,
  SKIPPED_MESSAGE,
  formatElapsed,
  formatSize,
  objectLine,
  oneLine,
  plural,
  resultLine,
  runStartLine,
  stampLine,
  stepHeading,
  stepLabel,
  summaryLines,
  type StepInfo
} from '@shared/jobLog'
import type {
  BackupCreateResult,
  Job,
  JobRun,
  JobTask,
  JobTaskRun,
  ProgressDetail,
  ProgressEvent
} from '@shared/types'
import type { BackupService } from '../backup/index'
import type { AppContext } from '../context'
import type { SessionFactory } from '../mysql/types'
import { newId, nowIso } from '../storage/ids'
import { RunLog } from './runLog'

/** Collaborators the runner needs; resolved lazily by the automation service. */
export interface RunnerDeps {
  backups: BackupService
  sessions: SessionFactory
  /** Wall clock for log timestamps and durations (tests). */
  now?: () => Date
}

export interface StartedJob {
  /** Snapshot of the run right after it was created (status `running`). */
  run: JobRun
  /** Resolves with the final run once every task finished. Never rejects. */
  done: Promise<JobRun>
}

export class JobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`El trabajo "${jobId}" no existe.`)
  }
}

export function jobNameSlug(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'job'
}

/**
 * Splits a SQL script into statements on `;` at end of line (or end of
 * input). Good enough for batch scripts without procedures/delimiters.
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split(/;[ \t]*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !isOnlyComments(s))
}

function isOnlyComments(statement: string): boolean {
  return statement
    .split(/\r?\n/)
    .every(
      (line) => line.trim() === '' || line.trim().startsWith('--') || line.trim().startsWith('#')
    )
}

export function runLogPath(ctx: AppContext, runId: string): string {
  return join(ctx.logDir, 'jobs', `${runId}.log`)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function requireConnectionName(ctx: AppContext, task: JobTask): string {
  const conn = ctx.connections.get(task.connectionId)
  if (!conn) {
    throw new Error(
      `La conexión del paso "${task.referenceName}" no existe (id ${task.connectionId}).`
    )
  }
  return conn.name
}

type BackupProgress = Omit<ProgressEvent, 'operationId' | 'kind'>

class RunExecution {
  private readonly log: RunLog
  private readonly now: () => Date
  /** Lines not yet streamed through event:jobLog. */
  private pending: string[] = []
  /** Index of the next streamed line (event:jobLog `seq`). */
  private seq = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private readonly startedMs: number

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: RunnerDeps,
    private readonly job: Job,
    readonly run: JobRun,
    private readonly signal: AbortSignal | undefined
  ) {
    this.log = new RunLog(run.logPath)
    this.now = deps.now ?? (() => new Date())
    this.startedMs = this.now().getTime()
  }

  private publish(): void {
    this.ctx.runs.upsert(structuredClone(this.run))
    this.ctx.emit('event:jobRun', structuredClone(this.run))
  }

  private get aborted(): boolean {
    return this.signal?.aborted === true
  }

  /** Writes one line to the run log and queues it for event:jobLog. */
  private say(body: string): void {
    const line = stampLine(this.now(), body)
    this.log.write(line)
    this.pending.push(line)
    this.flushTimer ??= setTimeout(() => this.flush(), JOB_LOG_FLUSH_MS)
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (!this.pending.length) return
    const lines = this.pending
    this.pending = []
    const seq = this.seq
    this.seq += lines.length
    try {
      this.ctx.emit('event:jobLog', { runId: this.run.id, seq, lines })
    } catch {
      /* no window to notify: the log file still has every line */
    }
  }

  private elapsedSince(startMs: number): number {
    return this.now().getTime() - startMs
  }

  private stepInfo(task: JobTask): StepInfo {
    return {
      type: task.type,
      schema: task.schema,
      connectionName: this.ctx.connections.get(task.connectionId)?.name ?? 'conexión desconocida',
      referenceName: task.referenceName
    }
  }

  async execute(): Promise<JobRun> {
    try {
      await this.executeTasks()
    } catch (err) {
      // Infrastructure failure (repo, log...): never leave a run stuck in `running`.
      this.run.status = this.aborted ? 'cancelled' : 'failed'
      this.run.finishedAt = nowIso()
      for (const t of this.run.tasks) {
        if (t.status === 'queued' || t.status === 'running') t.status = 'cancelled'
      }
      this.say(`Error inesperado: ${oneLine(errorMessage(err))}`)
      this.writeSummary()
      this.flush()
      try {
        this.publish()
      } catch {
        /* nothing else to do */
      }
    }
    return this.run
  }

  private async executeTasks(): Promise<void> {
    this.say(
      runStartLine({
        jobName: this.job.name,
        trigger: this.run.trigger,
        steps: this.job.tasks.length,
        at: this.now()
      })
    )
    this.ctx.jobs.touchLastRun(this.job.id, this.run.startedAt)
    this.publish()

    let stopRemaining = false
    let anyFailed = false
    for (let i = 0; i < this.job.tasks.length; i++) {
      const task = this.job.tasks[i]
      const taskRun = this.run.tasks[i]
      if (stopRemaining || this.aborted) {
        taskRun.status = 'cancelled'
        taskRun.message = this.aborted ? CANCELLED_MESSAGE : SKIPPED_MESSAGE
        this.say(stepHeading(i + 1, this.job.tasks.length, this.stepInfo(task)))
        this.say(resultLine(this.aborted ? 'CANCELADO' : 'OMITIDO', [taskRun.message]))
        continue
      }
      const ok = await this.runTask(task, taskRun, i)
      if (!ok) {
        anyFailed = true
        if (this.aborted || !this.job.continueOnError) stopRemaining = true
      }
    }

    this.run.status = this.aborted ? 'cancelled' : anyFailed ? 'failed' : 'success'
    this.run.finishedAt = nowIso()
    this.writeSummary()
    this.flush()
    this.publish()
  }

  private writeSummary(): void {
    const total = this.job.tasks.length
    const lines = summaryLines({
      status: this.run.status,
      durationMs: this.elapsedSince(this.startedMs),
      steps: this.run.tasks.map((t, i) => ({
        index: i + 1,
        label: this.job.tasks[i] ? stepLabel(this.stepInfo(this.job.tasks[i])) : t.referenceName,
        status: t.status,
        message: t.message
      }))
    })
    if (total === 0) lines.splice(1, 0, '  El trabajo no tiene pasos.')
    for (const line of lines) this.say(line)
  }

  /** Progress shared by every event of one step. */
  private stepDetail(index: number, task: JobTask): ProgressDetail {
    return {
      jobName: this.job.name,
      step: index + 1,
      steps: this.job.tasks.length,
      stepLabel: task.type === 'backupschema' ? task.schema : task.referenceName
    }
  }

  private emitProgress(index: number, task: JobTask, event: BackupProgress): void {
    this.ctx.emit('event:progress', {
      ...event,
      operationId: this.run.id,
      kind: 'job',
      detail: { ...event.detail, ...this.stepDetail(index, task) }
    })
  }

  private async runTask(task: JobTask, taskRun: JobTaskRun, index: number): Promise<boolean> {
    const stepStart = this.now().getTime()
    taskRun.status = 'running'
    taskRun.startedAt = nowIso()
    this.say(stepHeading(index + 1, this.job.tasks.length, this.stepInfo(task)))
    this.emitProgress(index, task, {
      phase: 'step',
      current: index,
      total: this.job.tasks.length,
      message: task.referenceName,
      done: false
    })
    this.publish()
    try {
      if (task.type === 'backupschema') {
        const result = await this.runBackup(task, index)
        taskRun.outputPath = result.path
        this.say(`  Archivo: ${result.path}`)
        this.say(
          resultLine('OK', [
            plural(result.objects, 'objeto', 'objetos'),
            plural(result.rows, 'fila', 'filas'),
            formatSize(result.sizeBytes),
            formatElapsed(this.elapsedSince(stepStart))
          ])
        )
      } else if (task.type === 'runquery') {
        const count = await this.runQuery(task, index)
        this.say(
          resultLine('OK', [
            plural(count, 'sentencia', 'sentencias'),
            formatElapsed(this.elapsedSince(stepStart))
          ])
        )
      } else {
        throw new Error(`Tipo de paso desconocido: ${String(task.type)}`)
      }
      taskRun.status = 'success'
      taskRun.message = null
    } catch (err) {
      const elapsed = formatElapsed(this.elapsedSince(stepStart))
      if (this.aborted) {
        taskRun.status = 'cancelled'
        taskRun.message = CANCELLED_MESSAGE
        this.say(resultLine('CANCELADO', [CANCELLED_MESSAGE, elapsed]))
      } else {
        taskRun.status = 'failed'
        taskRun.message = errorMessage(err)
        this.say(resultLine('ERROR', [taskRun.message, elapsed]))
      }
    }
    taskRun.finishedAt = nowIso()
    this.flush()
    this.publish()
    return taskRun.status === 'success'
  }

  /** Turns structured backup events into log lines (names and counts only). */
  private logBackupEvent(event: BackupProgress): void {
    const d = event.detail
    if (event.phase === 'list') this.say(`  Encontrados ${event.message}`)
    else if (event.phase === 'objectDone' && d?.objectName)
      this.say(
        objectLine({ type: d.objectType, name: d.objectName, count: d.rows ?? null, status: 'ok' })
      )
    else if (event.phase === 'objectError' && d?.objectName)
      this.say(
        objectLine({
          type: d.objectType,
          name: d.objectName,
          count: null,
          status: 'error',
          error: d.error
        })
      )
  }

  private async runBackup(task: JobTask, index: number): Promise<BackupCreateResult> {
    requireConnectionName(this.ctx, task)
    return this.deps.backups.create(
      {
        connectionId: task.connectionId,
        schema: task.schema,
        includeData: task.includeData ?? true,
        label: jobNameSlug(this.job.name)
      },
      (event) => {
        this.logBackupEvent(event)
        this.emitProgress(index, task, event)
      },
      this.signal
    )
  }

  private async runQuery(task: JobTask, index: number): Promise<number> {
    requireConnectionName(this.ctx, task)
    const statements = splitStatements(task.sql ?? '')
    if (statements.length === 0) {
      throw new Error(`El paso "${task.referenceName}" no contiene ninguna sentencia SQL.`)
    }
    const session = await this.deps.sessions.acquire(task.connectionId, task.schema || null)
    try {
      let executed = 0
      for (const statement of statements) {
        if (this.aborted) throw new Error(CANCELLED_MESSAGE)
        const name = `${executed + 1}/${statements.length}`
        const detail: ProgressDetail = {
          objectType: 'Statement',
          objectName: name,
          objectIndex: executed + 1,
          objects: statements.length,
          objectsDone: executed
        }
        this.emitProgress(index, task, {
          phase: 'object',
          current: index,
          total: this.job.tasks.length,
          message: `Sentencia ${name}`,
          done: false,
          detail
        })
        let affected: number | null = null
        try {
          // SQL text is never logged: it may contain data.
          const result = await session.execute(statement)
          affected = typeof result?.affectedRows === 'number' ? result.affectedRows : null
        } catch (err) {
          if (!this.aborted)
            this.say(
              objectLine({
                type: 'Statement',
                name,
                count: null,
                status: 'error',
                error: errorMessage(err)
              })
            )
          throw err
        }
        executed++
        this.say(
          objectLine({
            type: 'Statement',
            name,
            count: affected,
            unit: ['fila afectada', 'filas afectadas'],
            status: 'ok'
          })
        )
      }
      return executed
    } finally {
      await session.release().catch(() => undefined)
    }
  }
}

/**
 * Creates and persists a `running` JobRun synchronously, then executes its
 * tasks in the background. Use `done` to await the final state.
 */
export function startJob(
  ctx: AppContext,
  deps: RunnerDeps,
  jobId: string,
  trigger: JobRun['trigger'],
  signal?: AbortSignal
): StartedJob {
  const job = ctx.jobs.get(jobId)
  if (!job) throw new JobNotFoundError(jobId)
  const runId = newId()
  const run: JobRun = {
    id: runId,
    jobId: job.id,
    jobName: job.name,
    status: 'running',
    trigger,
    startedAt: nowIso(),
    finishedAt: null,
    tasks: job.tasks.map((t) => ({
      taskId: t.id,
      referenceName: t.referenceName,
      status: 'queued',
      startedAt: null,
      finishedAt: null,
      message: null,
      outputPath: null
    })),
    logPath: runLogPath(ctx, runId),
    pid: process.pid
  }
  // Snapshot before execute(): it runs synchronously up to its first await.
  const snapshot = structuredClone(run)
  const done = new RunExecution(ctx, deps, structuredClone(job), run, signal).execute()
  return { run: snapshot, done }
}

/** Runs a job to completion and returns the final JobRun. */
export function runJob(
  ctx: AppContext,
  deps: RunnerDeps,
  jobId: string,
  trigger: JobRun['trigger'],
  signal?: AbortSignal
): Promise<JobRun> {
  return startJob(ctx, deps, jobId, trigger, signal).done
}
