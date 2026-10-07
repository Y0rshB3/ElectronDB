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
  structureOnlySummary,
  summaryLines,
  type SafetyCopy,
  type StepInfo
} from '@shared/jobLog'
import {
  restoreSourceOf,
  restoreTargetSchema,
  restoreTaskProblem,
  sqlCopyRefusal
} from '@shared/restoreTask'
import { environmentPhrase } from '@shared/typedConfirm'
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
import {
  ReplaceIncompleteError,
  incompleteNotice,
  replaceSchemaFromBackup,
  type ReplaceResult,
  type SchemaCharset
} from '../backup/replace'
import type { AppContext } from '../context'
import { needsTypedConfirm, typedConfirmEnvironments } from '../ipc/productionGuard'
import { CAPABILITY_MESSAGES, requireConnectionCapability } from '../db/errors'
import type { SessionFactory } from '../mysql/types'
import { newId, nowIso } from '../storage/ids'
import { findLatestJobBackup } from './latestBackup'
import { RunLog } from './runLog'

/** Collaborators the runner needs; resolved lazily by the automation service. */
export interface RunnerDeps {
  backups: BackupService
  sessions: SessionFactory
  /** Wall clock for log timestamps and durations (tests). */
  now?: () => Date
  /** Charset/collation of a backup's schema (tests); read from the .nb3 otherwise. */
  backupCharset?: (path: string) => Promise<SchemaCharset | null>
}

/** How one run is executed (rollbacks from the run history). */
export interface RunOptions {
  signal?: AbortSignal
  kind?: JobRun['kind']
  /** Source run of a rollback. */
  rollbackOf?: string
  /**
   * Restore steps may write to a connection that needs the typed confirmation
   * (production, or an environment listed in Ajustes › Seguridad): only
   * «Restaurar todo» after the user typed the connection name (main checked
   * confirmProduction). Saved jobs never set it: nobody confirms scheduled or
   * launchd runs, so they can never write to production.
   */
  allowProductionRestore?: boolean
  /** continueOnError of the objects inside each restore (defaults to the job's). */
  restoreContinueOnError?: boolean
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

const connectionName = (ctx: AppContext, id: string | null | undefined): string =>
  (id ? ctx.connections.get(id)?.name : undefined) ?? 'conexión desconocida'

/** Safety copies taken by the restore steps of a run (what the summary lists for undo). */
export function safetyCopiesOf(ctx: AppContext, run: JobRun): SafetyCopy[] {
  return run.tasks
    .filter((t) => t.type === 'restoreschema' && !!t.outputPath)
    .map((t) => ({
      schema: t.schema ?? '?',
      connectionName: connectionName(ctx, t.connectionId),
      path: t.outputPath!
    }))
}

/** "f_score, users y 2 más" */
function namesOf(errors: { object: string }[]): string {
  const names = errors.slice(0, 3).map((e) => e.object)
  const more = errors.length - names.length
  return more > 0 ? `${names.join(', ')} y ${more} más` : names.join(', ')
}

/** Step message of a REPLACE restore that finished with object errors. */
export function partialRestoreMessage(schema: string, result: ReplaceResult): string {
  const restored = result.restore
  const counts = [
    plural(restored.objectsRestored, 'objeto', 'objetos'),
    plural(restored.rowsInserted, 'fila', 'filas')
  ]
  const first = restored.errors[0]
  const firstText = first.message.trim().replace(/[.]$/, '')
  return [
    `${plural(restored.errors.length, 'objeto', 'objetos')} con error al restaurar «${schema}»: ${namesOf(restored.errors)} (${counts.join(', ')} restaurados).`,
    `Error en ${first.object}: ${firstText}.`,
    incompleteNotice(
      schema,
      result.connectionName,
      result.safetyBackup?.path ?? null,
      result.existed
    )
  ].join(' ')
}

/** Heading/summary description of a step (restore steps also name their source). */
export function describeStep(ctx: AppContext, tasks: JobTask[], task: JobTask): StepInfo {
  const info: StepInfo = {
    type: task.type,
    schema: task.schema,
    connectionName: connectionName(ctx, task.connectionId),
    referenceName: task.referenceName
  }
  if (task.type === 'restoreschema') {
    const source = restoreSourceOf(task, tasks)
    info.schema = restoreTargetSchema(task, tasks)
    info.sourceSchema = source?.schema
    info.sourceConnectionName = source?.connectionId
      ? connectionName(ctx, source.connectionId)
      : 'backup'
    if (task.includeData === false) info.structureOnly = true
  }
  return info
}

function requireConnectionName(ctx: AppContext, task: JobTask): string {
  const conn = ctx.connections.get(task.connectionId)
  if (!conn) {
    throw new Error(
      `La conexión del paso "${task.referenceName}" no existe (id ${task.connectionId}).`
    )
  }
  // Jobs stay MySQL-only (section 11): a stored job can still point at another engine.
  requireConnectionCapability(conn, 'supportsAutomation', CAPABILITY_MESSAGES.automation)
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
  /** Summary note of successful steps, by step index («Solo estructura: …»). */
  private readonly notes = new Map<number, string>()

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: RunnerDeps,
    private readonly job: Job,
    readonly run: JobRun,
    private readonly options: RunOptions
  ) {
    this.log = new RunLog(run.logPath)
    this.now = deps.now ?? (() => new Date())
    this.startedMs = this.now().getTime()
  }

  private publish(): void {
    this.ctx.runs.upsert(structuredClone(this.run))
    this.ctx.emit('event:jobRun', structuredClone(this.run))
  }

  private get signal(): AbortSignal | undefined {
    return this.options.signal
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
    return describeStep(this.ctx, this.job.tasks, task)
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
    // A rollback restores another run's backups: the job itself did not run.
    if (this.run.kind !== 'rollback') this.ctx.jobs.touchLastRun(this.job.id, this.run.startedAt)
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
      safetyCopies: safetyCopiesOf(this.ctx, this.run),
      steps: this.run.tasks.map((t, i) => ({
        index: i + 1,
        label: this.job.tasks[i] ? stepLabel(this.stepInfo(this.job.tasks[i])) : t.referenceName,
        status: t.status,
        message: t.message,
        note: this.notes.get(i) ?? null
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
      stepLabel:
        task.type === 'backupschema'
          ? task.schema
          : task.type === 'restoreschema'
            ? restoreTargetSchema(task, this.job.tasks)
            : task.referenceName
    }
  }

  private emitProgress(
    index: number,
    task: JobTask,
    event: BackupProgress,
    phaseLabel?: string
  ): void {
    const step = this.stepDetail(index, task)
    if (phaseLabel) step.stepLabel = `${step.stepLabel} · ${phaseLabel}`
    this.ctx.emit('event:progress', {
      ...event,
      operationId: this.run.id,
      kind: 'job',
      detail: { ...event.detail, ...step }
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
      } else if (task.type === 'restoreschema') {
        const result = await this.runRestore(task, taskRun, index)
        const restored = result.restore
        const counts = [
          plural(restored.objectsRestored, 'objeto', 'objetos'),
          plural(restored.rowsInserted, 'fila', 'filas')
        ]
        if (restored.errors.length)
          throw new Error(partialRestoreMessage(restoreTargetSchema(task, this.job.tasks), result))
        if (result.includeData !== false) {
          this.say(resultLine('OK', [...counts, formatElapsed(this.elapsedSince(stepStart))]))
        } else {
          const summary = structureOnlySummary(restored.objectsRestored)
          this.notes.set(index, summary)
          this.say(resultLine('OK', [summary, formatElapsed(this.elapsedSince(stepStart))]))
        }
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
        // A replace cancelled after the DROP says the database is incomplete and how to undo.
        taskRun.message =
          err instanceof ReplaceIncompleteError
            ? `${CANCELLED_MESSAGE} ${err.message}`
            : CANCELLED_MESSAGE
        this.say(resultLine('CANCELADO', [taskRun.message, elapsed]))
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
    else if (event.phase === 'warning') this.say(`  Aviso: ${event.message}`)
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

  private async runBackup(
    task: JobTask,
    index: number
  ): Promise<Pick<BackupCreateResult, 'path' | 'objects' | 'rows' | 'sizeBytes'>> {
    requireConnectionName(this.ctx, task)
    const onProgress = (event: BackupProgress): void => {
      this.logBackupEvent(event)
      this.emitProgress(index, task, event)
    }
    if (task.format === 'sql') {
      // Plain .sql for other managers (restore steps refuse it, see restoreTask.ts).
      return this.deps.backups.exportSql(
        {
          connectionId: task.connectionId,
          schema: task.schema,
          includeStructure: true,
          includeData: task.includeData ?? true,
          includeCreateDatabase: false,
          label: jobNameSlug(this.job.name)
        },
        onProgress,
        this.signal
      )
    }
    return this.deps.backups.create(
      {
        connectionId: task.connectionId,
        schema: task.schema,
        includeData: task.includeData ?? true,
        label: jobNameSlug(this.job.name)
      },
      onProgress,
      this.signal
    )
  }

  /** Finds the .nb3 a restore step restores and the schema it must contain. */
  private async restoreSource(
    task: JobTask
  ): Promise<{ path: string; schema: string; connectionId: string | null }> {
    const source = task.restoreSource
    if (!source) throw new Error(`El paso "${task.referenceName}" no indica qué copia restaurar.`)
    if (source.kind === 'file') return source
    if (source.kind === 'task') {
      const ref = this.job.tasks.find((t) => t.id === source.taskId)
      const refRun = this.run.tasks.find((t) => t.taskId === source.taskId)
      if (!ref || !refRun)
        throw new Error(`El paso de origen de "${task.referenceName}" no existe.`)
      // Jobs saved before the rule (or edited by hand): never read a .sql as an .nb3.
      const sqlProblem = sqlCopyRefusal(`paso «${task.referenceName}»`, ref)
      if (sqlProblem) throw new Error(sqlProblem)
      if (refRun.status !== 'success' || !refRun.outputPath) {
        throw new Error(
          `El paso de origen «${ref.referenceName}» no generó ninguna copia en esta ejecución; no se restaura nada.`
        )
      }
      return { path: refRun.outputPath, schema: ref.schema, connectionId: ref.connectionId }
    }
    const name = connectionName(this.ctx, source.connectionId)
    // Only complete copies (all objects, with data) made by a job step of that very
    // connection: never a structure-only, partial, manual, Navicat or safety copy.
    const latest = await findLatestJobBackup(this.ctx, source.connectionId, source.schema)
    if (!latest)
      throw new Error(
        `No hay ninguna copia completa (con datos) de «${source.schema}» de ${name} hecha por una tarea de Vortaq. Ejecuta antes una tarea que la copie con «Incluir datos»; no se restaura nada.`
      )
    this.say(`  Copia más reciente con datos: tarea «${latest.jobName}», ${latest.fileName}`)
    return { path: latest.path, schema: source.schema, connectionId: source.connectionId }
  }

  private async runRestore(
    task: JobTask,
    taskRun: JobTaskRun,
    index: number
  ): Promise<ReplaceResult> {
    requireConnectionName(this.ctx, task)
    const problem = restoreTaskProblem(
      task,
      this.job.tasks,
      (id) => this.ctx.connections.get(id),
      `paso "${task.referenceName}"`,
      {
        rollback: this.options.allowProductionRestore === true || this.run.kind === 'rollback',
        typedEnvironments: typedConfirmEnvironments(this.ctx)
      }
    )
    if (problem) throw new Error(problem)
    const target = this.ctx.connections.get(task.connectionId)!
    // Defence in depth: only a confirmed rollback may replace databases in production or in an
    // environment that needs the typed name.
    if (needsTypedConfirm(this.ctx, target) && this.options.allowProductionRestore !== true) {
      throw new Error(
        `«${target.name}» es una conexión de ${environmentPhrase(target.environment)}: este paso no puede reemplazar sus bases de datos sin escribir antes el nombre de la conexión.`
      )
    }
    const source = await this.restoreSource(task)
    return replaceSchemaFromBackup(
      {
        connections: this.ctx.connections,
        sessions: this.deps.sessions,
        backups: this.deps.backups,
        backupCharset: this.deps.backupCharset
      },
      {
        backupPath: source.path,
        expectedSchema: source.schema,
        connectionId: task.connectionId,
        targetSchema: restoreTargetSchema(task, this.job.tasks),
        safetyBackup: task.safetyBackup !== false,
        includeData: task.includeData !== false,
        continueOnError: this.options.restoreContinueOnError ?? this.job.continueOnError,
        confirmProduction: this.options.allowProductionRestore === true
      },
      {
        line: (body) => this.say(body),
        progress: (stage, event) => {
          // Object lines are logged for the restore only; the safety copy is one line.
          if (stage === 'restore') this.logBackupEvent(event)
          this.emitProgress(index, task, event, stage === 'safety' ? 'copia previa' : 'restaurando')
        },
        safetyBackupDone: (result) => {
          taskRun.outputPath = result.path
          this.publish()
        }
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
  return startJobWith(ctx, deps, job, trigger, { signal })
}

/** Like startJob for a job definition that is not (necessarily) stored, e.g. a rollback. */
export function startJobWith(
  ctx: AppContext,
  deps: RunnerDeps,
  job: Job,
  trigger: JobRun['trigger'],
  options: RunOptions = {}
): StartedJob {
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
      outputPath: null,
      type: t.type,
      connectionId: t.connectionId,
      schema: t.type === 'restoreschema' ? restoreTargetSchema(t, job.tasks) : t.schema,
      ...(t.type === 'backupschema' ? { includeData: t.includeData !== false } : {}),
      ...(t.type === 'backupschema' && t.format === 'sql' ? { format: 'sql' as const } : {})
    })),
    logPath: runLogPath(ctx, runId),
    pid: process.pid
  }
  if (options.kind && options.kind !== 'job') run.kind = options.kind
  if (options.rollbackOf) run.rollbackOf = options.rollbackOf
  // Snapshot before execute(): it runs synchronously up to its first await.
  const snapshot = structuredClone(run)
  const { signal, ...rest } = options
  const done = new RunExecution(ctx, deps, structuredClone(job), run, {
    ...rest,
    signal
  }).execute()
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
