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
  restoreLabel,
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
import {
  ownPackageEntries,
  packageRestoreTasks,
  packageSourceLabel,
  packageTargetsProblem,
  restorePackageProblem,
  restoresWholePackage,
  selectPackageEntries,
  splitByEngine,
  type PackageEntry
} from '@shared/restorePackage'
import { packageDate } from '@shared/backupPackages'
import { existsSync } from 'node:fs'
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
  type ReplaceHooks,
  type ReplaceRequest,
  type ReplaceResult,
  type SchemaCharset
} from '../backup/replace'
import { engineOf, isMysqlFamilyEngine } from '@shared/engines'
import { backupFamilyName, backupFamilyOf, jobStepEngineProblem } from '@shared/jobEngines'
import type { AppContext } from '../context'
import { needsTypedConfirm, typedConfirmEnvironments } from '../ipc/productionGuard'
import { CAPABILITY_MESSAGES, requireConnectionCapability } from '../db/errors'
import type { SessionFactory } from '../mysql/types'
import { newId, nowIso } from '../storage/ids'
import { findLatestJobBackup } from './latestBackup'
import { latestJobPackage } from './jobPackages'
import { RunLog } from './runLog'
import { MISSING_JOB_PASSWORD, jobBackupPassword } from './backupKeys'
import { pickBackupPassword } from '../backup/passwords'
import { mariadbDialect } from '@shared/dialects/mariadb'
import { isMariaDbSession } from '../mysql/mariadb'

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
  /**
   * «Restaurar todo»: password the user typed for encrypted .vqb copies the
   * job's stored password does not open. Kept in memory only.
   */
  backupPassword?: string | null
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

/**
 * Statements of a MariaDB step: split like the query tab of a MariaDB
 * connection (MariaDB executable comments are code; quotes, comments and DELIMITER are respected).
 */
export function splitMariaDbStatements(sql: string): string[] {
  return mariadbDialect
    .splitStatements(sql)
    .map((s) => s.sql.trim())
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
  } else if (task.type === 'restorepackage') {
    info.packageName = packageSourceLabel(task, (id) => ctx.jobs.get(id)?.name)
    if (task.includeData === false) info.structureOnly = true
  }
  return info
}

/** Run entry of a step when the run starts (restores of a package step get `packageStepId`). */
export function newTaskRun(t: JobTask, tasks: JobTask[], packageStepId?: string): JobTaskRun {
  return {
    taskId: t.id,
    referenceName: t.referenceName,
    status: 'queued',
    startedAt: null,
    finishedAt: null,
    message: null,
    outputPath: null,
    type: t.type,
    connectionId: t.connectionId,
    schema: t.type === 'restoreschema' ? restoreTargetSchema(t, tasks) : t.schema,
    ...(t.type === 'backupschema' ? { includeData: t.includeData !== false } : {}),
    ...(t.type === 'backupschema' && (t.format === 'sql' || t.format === 'vqb')
      ? { format: t.format }
      : {}),
    ...(t.type === 'backupschema' && t.format === 'vqb' && t.encrypt ? { encrypted: true } : {}),
    ...(packageStepId ? { packageStepId } : {})
  }
}

function requireConnectionName(ctx: AppContext, task: JobTask): string {
  const conn = ctx.connections.get(task.connectionId)
  if (!conn) {
    throw new Error(
      `La conexión del paso "${task.referenceName}" no existe (id ${task.connectionId}).`
    )
  }
  requireConnectionCapability(conn, 'supportsAutomation', CAPABILITY_MESSAGES.automation)
  return conn.name
}

/** MySQL and MariaDB connections (sessions, .nb3, .sql); the other engines go through the backup service. */
function isMysqlFamilyTask(ctx: AppContext, task: JobTask): boolean {
  return isMysqlFamilyEngine(ctx.connections.get(task.connectionId)?.engine)
}

/** Per-engine rule of a step (jobs edited by hand or saved before the rule): throws. */
function requireEngineRules(ctx: AppContext, tasks: JobTask[], task: JobTask): void {
  const problem = jobStepEngineProblem(
    task,
    tasks,
    (id) => ctx.connections.get(id),
    `paso «${task.referenceName}»`
  )
  if (problem) throw new Error(problem)
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
  /** Summary note of successful steps, by step id («Solo estructura: …»). */
  private readonly notes = new Map<string, string>()
  /**
   * Restores a «Restaurar paquete» step became that read another job's package:
   * restore id -> that job (its stored password opens encrypted copies).
   */
  private readonly packageFiles = new Map<string, string>()

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
      if (task.type === 'restorepackage') {
        // The step becomes one restore per database, placed where it was: run them next.
        if (await this.expandPackage(task, taskRun, i)) i--
        else {
          anyFailed = true
          if (this.aborted || !this.job.continueOnError) stopRemaining = true
        }
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
        note: (this.job.tasks[i] && this.notes.get(this.job.tasks[i].id)) ?? null
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
            : task.referenceName || 'paquete'
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

  /**
   * «Restaurar paquete»: resolves the package (this run's copies, or the newest
   * package of another job), checks it before anything is touched, and
   * replaces the step in the job and the run by one ordinary restore per
   * database. False when the step failed (nothing was restored).
   */
  private async expandPackage(task: JobTask, taskRun: JobTaskRun, index: number): Promise<boolean> {
    const stepStart = this.now().getTime()
    taskRun.status = 'running'
    taskRun.startedAt = nowIso()
    this.say(stepHeading(index + 1, this.job.tasks.length, this.stepInfo(task)))
    this.publish()
    try {
      const targetName = requireConnectionName(this.ctx, task)
      const label = `paso «${task.referenceName || 'Restaurar paquete'}»`
      const problem = restorePackageProblem(
        task,
        this.job.tasks,
        (id) => this.ctx.connections.get(id),
        label,
        {
          typedEnvironments: typedConfirmEnvironments(this.ctx),
          jobId: this.job.id,
          jobExists: (id) => !!this.ctx.jobs.get(id)
        }
      )
      if (problem) throw new Error(problem)
      const target = this.ctx.connections.get(task.connectionId)!
      // Defence in depth: a package step never writes where the typed name is needed.
      if (needsTypedConfirm(this.ctx, target))
        throw new Error(
          `«${target.name}» es una conexión de ${environmentPhrase(target.environment)}: un paso de una tarea no puede reemplazar sus bases de datos.`
        )
      const source = task.packageSource!
      let entries: PackageEntry[]
      let packageJobId: string | null = null
      let from: string
      if (source.kind === 'own') {
        entries = ownPackageEntries(task, this.job.tasks)
        from = 'esta tarea'
        this.say(
          `  Paquete de esta tarea: las copias de ${plural(entries.length, 'paso anterior', 'pasos anteriores')} de esta ejecución`
        )
      } else {
        const job = this.ctx.jobs.get(source.jobId)
        from = `«${job?.name ?? source.jobName ?? 'otra tarea'}»`
        const latest = latestJobPackage(this.ctx, source.jobId)
        if (!latest)
          throw new Error(
            `${from} aún no tiene ningún paquete de copias .vqb o .nb3 terminado: ejecútala antes; no se restaura nada.`
          )
        packageJobId = source.jobId
        entries = latest.copies.map((c) => ({
          schema: c.schema,
          connectionId: c.connectionId,
          structureOnly: c.structureOnly,
          path: c.path
        }))
        this.say(
          `  Último paquete de ${from}: ejecución del ${packageDate(latest.run.startedAt)}, ${plural(entries.length, 'copia', 'copias')}`
        )
        if (latest.run.status !== 'success')
          this.say(
            '  Aviso: esa ejecución terminó con errores; solo se restauran las copias que llegó a hacer.'
          )
      }
      const picked = selectPackageEntries(task, entries)
      const { missing, skipped } = picked
      let selected = picked.selected
      // Picked by name, a structure-only copy would leave the target's tables empty.
      const bare =
        task.includeData !== false && !restoresWholePackage(task)
          ? selected.find((e) => e.structureOnly)
          : undefined
      if (bare)
        throw new Error(
          `La copia de «${bare.schema}» del paquete de ${from} es solo de estructura (sin datos): las tablas de destino quedarían vacías; no se restaura nada. Quítala de la lista, marca «Solo estructura» en este paso o incluye datos en esa copia.`
        )
      if (restoresWholePackage(task)) {
        // «Todas»: the copies of the target's engine (a package may span engines).
        const split = splitByEngine(task, selected, (id) => this.ctx.connections.get(id))
        selected = split.same
        for (const entry of split.other)
          this.say(
            `  Aviso: «${entry.schema}» no se restaura: es una copia de «${connectionName(this.ctx, entry.connectionId)}», de otro motor que «${targetName}»`
          )
      }
      for (const entry of skipped)
        this.say(
          `  Aviso: «${entry.schema}» no se restaura: su copia es solo de estructura y este paso restaura datos`
        )
      if (missing.length)
        throw new Error(
          `El paquete de ${from} no tiene ${missing.map((n) => `«${n}»`).join(', ')}; no se restaura nada. Quítala${missing.length === 1 ? '' : 's'} de la lista del paso o vuelve a ejecutar la tarea que la copia.`
        )
      if (!selected.length)
        throw new Error(`El paquete de ${from} no tiene ninguna copia que restaurar con este paso.`)
      const targetsProblem = packageTargetsProblem(task, selected, target, label)
      if (targetsProblem) throw new Error(targetsProblem)
      // Copies of another job: their engine is known now (MySQL and MariaDB share one).
      const family = backupFamilyOf(engineOf(target).id)
      for (const entry of selected) {
        const conn = entry.connectionId ? this.ctx.connections.get(entry.connectionId) : null
        const fromFamily = conn ? backupFamilyOf(engineOf(conn).id) : null
        if (fromFamily && fromFamily !== family)
          throw new Error(
            `El paquete de ${from} tiene una copia de ${backupFamilyName(fromFamily)} («${entry.schema}» de «${conn!.name}») y «${target.name}» es ${backupFamilyName(family)}: una copia solo se restaura en una conexión del mismo motor; no se restaura nada.`
          )
      }
      const restores = packageRestoreTasks(task, selected, (entry, targetSchema) =>
        restoreLabel({
          type: 'restoreschema',
          schema: targetSchema,
          connectionName: targetName,
          referenceName: '',
          sourceSchema: entry.schema,
          sourceConnectionName: connectionName(this.ctx, entry.connectionId),
          structureOnly: task.includeData === false || entry.structureOnly
        })
      )
      await this.preflightPackage(restores, packageJobId, label)
      for (const r of restores)
        if (packageJobId && r.restoreSource?.kind === 'file')
          this.packageFiles.set(r.id, packageJobId)
      this.say(
        `  ${plural(restores.length, 'base de datos', 'bases de datos')} -> ${targetName} ${task.safetyBackup !== false ? 'con' : 'sin'} copia previa: ${restores.map((r) => r.schema).join(', ')}`
      )
      const total = this.job.tasks.length - 1 + restores.length
      this.say(
        resultLine('OK', [
          restores.length === 1
            ? `se restaura en el paso ${index + 1} de ${total}`
            : `se restaura en los pasos ${index + 1} a ${index + restores.length} de ${total}`,
          formatElapsed(this.elapsedSince(stepStart))
        ])
      )
      this.job.tasks.splice(index, 1, ...restores)
      this.run.tasks.splice(
        index,
        1,
        ...restores.map((r) => newTaskRun(r, this.job.tasks, task.id))
      )
      this.flush()
      this.publish()
      return true
    } catch (err) {
      const elapsed = formatElapsed(this.elapsedSince(stepStart))
      taskRun.status = this.aborted ? 'cancelled' : 'failed'
      taskRun.message = this.aborted ? CANCELLED_MESSAGE : errorMessage(err)
      this.say(resultLine(this.aborted ? 'CANCELADO' : 'ERROR', [taskRun.message, elapsed]))
      taskRun.finishedAt = nowIso()
      this.flush()
      this.publish()
      return false
    }
  }

  /**
   * Everything each restore of a package will need, checked before the first
   * database is replaced: the restore rules (self-restore, guarded targets,
   * system databases), the copy itself (made in this run, or still on disk)
   * and a password that opens it when it is encrypted.
   */
  private async preflightPackage(
    restores: JobTask[],
    packageJobId: string | null,
    label: string
  ): Promise<void> {
    const all = [...this.job.tasks, ...restores]
    const ownKey = jobBackupPassword(this.ctx, this.job.id)
    const sourceKey = packageJobId ? jobBackupPassword(this.ctx, packageJobId) : null
    for (const r of restores) {
      const problem = restoreTaskProblem(r, all, (id) => this.ctx.connections.get(id), label, {
        typedEnvironments: typedConfirmEnvironments(this.ctx),
        packageFile: true
      })
      if (problem) throw new Error(`${problem} No se restaura nada.`)
      const source = r.restoreSource!
      let path: string
      if (source.kind === 'task') {
        const refRun = this.run.tasks.find((t) => t.taskId === source.taskId)
        if (!refRun || refRun.status !== 'success' || !refRun.outputPath)
          throw new Error(
            `La copia de «${r.schema}» no se hizo en esta ejecución (su paso de copia no terminó bien); no se restaura nada del paquete.`
          )
        path = refRun.outputPath
      } else if (source.kind === 'file') {
        path = source.path
        if (!existsSync(path))
          throw new Error(
            `La copia de «${source.schema}» del paquete ya no está en disco (${path}); no se restaura nada.`
          )
      } else continue
      try {
        await pickBackupPassword(path, [sourceKey, ownKey])
      } catch (err) {
        throw new Error(
          `La copia de «${r.schema}» no se puede abrir: ${errorMessage(err)} No se restaura nada del paquete.`
        )
      }
    }
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
          this.notes.set(task.id, summary)
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
    requireEngineRules(this.ctx, this.job.tasks, task)
    let password: string | null = null
    if (task.format === 'vqb' && task.encrypt) {
      password = jobBackupPassword(this.ctx, this.job.id)
      if (!password) throw new Error(MISSING_JOB_PASSWORD)
      this.say('  Copia .vqb cifrada con la contraseña de la tarea')
    }
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
        label: jobNameSlug(this.job.name),
        // Absent = .nb3: jobs saved before .vqb keep writing the format they always did.
        ...(task.format === 'vqb' ? { format: 'vqb' as const } : {}),
        ...(password ? { password } : {})
      },
      onProgress,
      this.signal
    )
  }

  /**
   * Finds the backup (.vqb or .nb3) a restore step restores, the schema it
   * must contain and the passwords that may open it (encrypted .vqb).
   */
  private async restoreSource(task: JobTask): Promise<{
    path: string
    schema: string
    connectionId: string | null
    passwords: (string | null)[]
  }> {
    const source = task.restoreSource
    if (!source) throw new Error(`El paso "${task.referenceName}" no indica qué copia restaurar.`)
    const ownKey = jobBackupPassword(this.ctx, this.job.id)
    const packageJob = this.packageFiles.get(task.id)
    if (source.kind === 'file' && packageJob) {
      // A copy of another job's package: opened with that job's password.
      if (!existsSync(source.path))
        throw new Error(
          `La copia de «${source.schema}» del paquete ya no está en disco (${source.path}); no se restaura.`
        )
      return { ...source, passwords: [jobBackupPassword(this.ctx, packageJob), ownKey] }
    }
    if (source.kind === 'file')
      return { ...source, passwords: [this.options.backupPassword ?? null, ownKey] }
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
      return {
        path: refRun.outputPath,
        schema: ref.schema,
        connectionId: ref.connectionId,
        passwords: [ownKey]
      }
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
    return {
      path: latest.path,
      schema: source.schema,
      connectionId: source.connectionId,
      // A copy of another job is opened with that job's password.
      passwords: [jobBackupPassword(this.ctx, latest.jobId), ownKey]
    }
  }

  private async runRestore(
    task: JobTask,
    taskRun: JobTaskRun,
    index: number
  ): Promise<ReplaceResult> {
    requireConnectionName(this.ctx, task)
    requireEngineRules(this.ctx, this.job.tasks, task)
    const problem = restoreTaskProblem(
      task,
      this.job.tasks,
      (id) => this.ctx.connections.get(id),
      `paso "${task.referenceName}"`,
      {
        rollback: this.options.allowProductionRestore === true || this.run.kind === 'rollback',
        typedEnvironments: typedConfirmEnvironments(this.ctx),
        packageFile: this.packageFiles.has(task.id)
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
    // An encrypted .vqb: pick the password before anything is touched (never logged).
    const password = await pickBackupPassword(source.path, source.passwords)
    if (password) this.say('  Copia .vqb cifrada: se abre con la contraseña guardada')
    // PostgreSQL, SQLite and MongoDB replace through their own engine (backup service);
    // MySQL/MariaDB keep the session-based replace (with the injectable charset reader).
    const replace = isMysqlFamilyTask(this.ctx, task)
      ? (request: ReplaceRequest, hooks: ReplaceHooks, signal?: AbortSignal) =>
          replaceSchemaFromBackup(
            {
              connections: this.ctx.connections,
              sessions: this.deps.sessions,
              backups: this.deps.backups,
              backupCharset: this.deps.backupCharset
            },
            request,
            hooks,
            signal
          )
      : (request: ReplaceRequest, hooks: ReplaceHooks, signal?: AbortSignal) =>
          this.deps.backups.replace(request, hooks, signal)
    return replace(
      {
        backupPath: source.path,
        expectedSchema: source.schema,
        connectionId: task.connectionId,
        targetSchema: restoreTargetSchema(task, this.job.tasks),
        safetyBackup: task.safetyBackup !== false,
        includeData: task.includeData !== false,
        continueOnError: this.options.restoreContinueOnError ?? this.job.continueOnError,
        confirmProduction: this.options.allowProductionRestore === true,
        ...(password ? { password } : {})
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
    requireEngineRules(this.ctx, this.job.tasks, task)
    let statements = splitStatements(task.sql ?? '')
    if (statements.length === 0) {
      throw new Error(`El paso "${task.referenceName}" no contiene ninguna sentencia SQL.`)
    }
    const session = await this.deps.sessions.acquire(task.connectionId, task.schema || null)
    try {
      // MariaDB (engine or server): the same splitting as its query tab. MySQL keeps
      // the line-based splitting jobs always had.
      if (
        this.ctx.connections.get(task.connectionId)?.engine === 'mariadb' ||
        isMariaDbSession(session)
      )
        statements = splitMariaDbStatements(task.sql ?? '')
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
    tasks: job.tasks.map((t) => newTaskRun(t, job.tasks)),
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
