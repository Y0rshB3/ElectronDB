import { restoreLabel } from '@shared/jobLog'
import { SQL_COPY_NOT_RESTORABLE, isSystemSchema, systemSchemaRefusal } from '@shared/restoreTask'
import { environmentPhrase } from '@shared/typedConfirm'
import { MANUAL_ROLLBACKS_JOB_ID, MANUAL_ROLLBACKS_NAME } from '@shared/backupPackages'
import type {
  BackupMeta,
  BackupRunRef,
  ConnectionConfig,
  Job,
  JobRun,
  RollbackFilesSource,
  RollbackPlan,
  RollbackPlanItem,
  RollbackRequest
} from '@shared/types'
import { stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { readBackupMeta } from '../backup/index'
import { isBackupFileName } from '../backup/naming'
import { ENCRYPTED_MESSAGE } from '../backup/nb3/reader'
import type { AppContext } from '../context'
import { describeError } from '../mysql/errors'
import type { SessionFactory } from '../mysql/types'
import { nowIso } from '../storage/ids'
import { backupPathKey, backupRunIndex, restorableTasks } from './backupRuns'
import { needsTypedConfirm } from '../ipc/productionGuard'
import type { RunOptions } from './runner'

export { restorableTasks } from './backupRuns'

/**
 * «Restaurar todo en Local»: restores every backup a finished run produced
 * into another connection with REPLACE semantics (see backup/replace.ts).
 * The restore itself is an ordinary run of a synthetic job made of
 * 'restoreschema' steps, so it gets the same live log, summary and history.
 */

/** What the plan needs from disk and from the target server; injectable for tests. */
export interface RollbackInspector {
  readMeta(path: string): Promise<BackupMeta>
  fileSize(path: string): Promise<number | null>
  /** Databases of the target connection. */
  targetSchemas(connectionId: string): Promise<string[]>
}

type RollbackContext = Pick<AppContext, 'runs' | 'jobs' | 'connections' | 'settings'>

/** Real disk and server access for rollback plans (manifests through the index cache). */
export function createRollbackInspector(
  ctx: Pick<AppContext, 'userDataPath'>,
  sessions: () => Promise<SessionFactory> | SessionFactory
): RollbackInspector {
  return {
    readMeta: (path) => readBackupMeta(ctx.userDataPath, path),
    fileSize: async (path) => (await stat(path)).size,
    targetSchemas: async (connectionId) => {
      const session = await (await sessions()).acquire(connectionId, null)
      try {
        const rows = await session.query<{ name: unknown }>(
          'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA'
        )
        return rows.map((r) => String(r.name))
      } finally {
        await session.release().catch(() => undefined)
      }
    }
  }
}

const isLive = (run: JobRun): boolean => run.status === 'running' || run.status === 'queued'

function requireSourceRun(ctx: RollbackContext, runId: string): JobRun {
  const run = ctx.runs.get(runId)
  if (!run) throw new Error('La ejecución ya no existe en el historial.')
  if (run.kind === 'rollback')
    throw new Error(
      'Esta ejecución ya es una restauración; elige la ejecución que hizo las copias de seguridad.'
    )
  if (isLive(run))
    throw new Error('La ejecución sigue en curso; espera a que termine para restaurar sus copias.')
  return run
}

/** Facts of one backup to restore, before reading its manifest. */
interface PlanCandidate {
  taskId: string
  referenceName: string
  path: string
  /** Schema the file must contain (null: whatever its manifest says). */
  expected: string | null
  /** Schema to assume when the manifest cannot be read (folder name). */
  fallbackSchema: string | null
  sourceConnectionId: string | null
  structureOnly: boolean
}

async function targetInfo(
  ctx: RollbackContext,
  targetConnectionId: string | null,
  inspector: RollbackInspector
): Promise<{
  target: ConnectionConfig | null
  existing: Set<string> | null
  targetError: string | null
}> {
  const target = targetConnectionId ? ctx.connections.get(targetConnectionId) : null
  if (targetConnectionId && !target) throw new Error('La conexión de destino ya no existe.')
  let existing: Set<string> | null = null
  let targetError: string | null = null
  if (target) {
    try {
      existing = new Set(await inspector.targetSchemas(target.id))
    } catch (err) {
      targetError = `No se pudo consultar «${target.name}»: ${describeError(err)}`
    }
  }
  return { target, existing, targetError }
}

async function planItem(
  ctx: RollbackContext,
  c: PlanCandidate,
  target: ConnectionConfig | null,
  existing: Set<string> | null,
  inspector: RollbackInspector
): Promise<RollbackPlanItem> {
  let schema = c.expected ?? ''
  let problem: string | null = null
  let objects: number | null = null
  let rows: number | null = null
  let tables = 0
  // A .sql output of a backup step («Formato: .sql»): listed, never restored.
  if (!isBackupFileName(c.path)) {
    problem = SQL_COPY_NOT_RESTORABLE
    schema = schema || c.fallbackSchema || ''
  } else
    try {
      const meta = await inspector.readMeta(c.path)
      if (meta.encryption && meta.encryption !== 'None') problem = ENCRYPTED_MESSAGE
      else if (c.expected && meta.schema !== c.expected)
        problem = `El archivo contiene la base de datos «${meta.schema}», no «${c.expected}».`
      schema = meta.schema || schema
      objects = meta.objects.length
      tables = meta.objects.filter((o) => String(o.type).toLowerCase() === 'table').length
      rows = meta.objects.reduce((sum, o) => sum + (typeof o.rows === 'number' ? o.rows : 0), 0)
    } catch (err) {
      problem = describeError(err)
      schema = schema || c.fallbackSchema || ''
    }
  if (!schema && !problem) problem = 'No se sabe qué base de datos contiene el backup.'
  if (!problem && isSystemSchema(schema)) problem = systemSchemaRefusal(schema)
  const where = target ? `«${schema}» en «${target.name}»` : `«${schema}» en el destino`
  const warning = c.structureOnly
    ? `Copia solo de estructura (sin datos): las tablas de ${where} quedarán vacías.`
    : tables > 0 && rows === 0
      ? `La copia no tiene ninguna fila: las tablas de ${where} quedarán vacías.`
      : null
  return {
    taskId: c.taskId,
    referenceName: c.referenceName,
    sourceConnectionId: c.sourceConnectionId,
    sourceConnectionName:
      (c.sourceConnectionId ? ctx.connections.get(c.sourceConnectionId)?.name : null) ??
      'conexión desconocida',
    schema,
    targetSchema: schema,
    backupPath: c.path,
    sizeBytes: await inspector.fileSize(c.path).catch(() => null),
    targetExists: existing ? existing.has(schema) : null,
    problem,
    objects,
    rows,
    structureOnly: c.structureOnly,
    warning
  }
}

export async function buildRollbackPlan(
  ctx: RollbackContext,
  runId: string,
  targetConnectionId: string | null,
  inspector: RollbackInspector
): Promise<RollbackPlan> {
  const run = requireSourceRun(ctx, runId)
  const job = ctx.jobs.get(run.jobId)
  const tasks = restorableTasks(run, job)
  if (!tasks.length)
    throw new Error('Esta ejecución no generó ninguna copia de seguridad que se pueda restaurar.')

  const { target, existing, targetError } = await targetInfo(ctx, targetConnectionId, inspector)
  const items: RollbackPlanItem[] = []
  for (const t of tasks) {
    const def = job?.tasks.find((x) => x.id === t.taskId)
    items.push(
      await planItem(
        ctx,
        {
          taskId: t.taskId,
          referenceName: t.referenceName,
          path: t.outputPath!,
          expected: t.schema ?? def?.schema ?? null,
          fallbackSchema: null,
          sourceConnectionId: t.connectionId ?? def?.connectionId ?? null,
          structureOnly: (t.includeData ?? def?.includeData) === false
        },
        target,
        existing,
        inspector
      )
    )
  }
  return {
    source: 'run',
    runId: run.id,
    jobId: run.jobId,
    jobName: run.jobName,
    runStartedAt: run.startedAt,
    targetConnectionId: target?.id ?? null,
    items,
    targetError
  }
}

/* ---------- File-based restores (packages of the backups list) ---------- */

/** Most files one restore accepts (a batch of every database of a server). */
const MAX_FILES = 500
const MAX_TITLE = 120

const inside = (dir: string, path: string): string | null => {
  const rel = relative(resolve(dir), path)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null
}

/**
 * Connection whose backup folder (backupDir or a Navicat folder) holds `path`
 * at the depth the backups list shows (`<dir>/<file>` or `<dir>/<schema>/<file>`),
 * preferring `preferredId`. Null when no known connection owns it.
 */
export function owningConnection(
  ctx: Pick<AppContext, 'connections'>,
  path: string,
  preferredId: string | null
): { connection: ConnectionConfig; schemaFolder: string | null } | null {
  const abs = resolve(path)
  const all = ctx.connections.list()
  const ordered = [
    ...all.filter((c) => c.id === preferredId),
    ...all.filter((c) => c.id !== preferredId)
  ]
  for (const connection of ordered) {
    for (const dir of [connection.backupDir, ...(connection.extraBackupDirs ?? [])]) {
      if (!dir) continue
      const rel = inside(dir, abs)
      if (!rel) continue
      const parts = rel.split(/[\\/]/)
      if (parts.length > 2) continue
      return { connection, schemaFolder: parts.length === 2 ? parts[0] : null }
    }
  }
  return null
}

/** Throws unless every path is a .nb3 inside a known backup folder; returns them resolved. */
export function validateBackupPaths(
  ctx: Pick<AppContext, 'connections'>,
  source: Pick<RollbackFilesSource, 'backupPaths' | 'sourceConnectionId'>
): { path: string; connection: ConnectionConfig; schemaFolder: string | null }[] {
  const paths = Array.isArray(source?.backupPaths) ? source.backupPaths : []
  if (!paths.length) throw new Error('Selecciona al menos una copia de seguridad para restaurar.')
  if (paths.length > MAX_FILES)
    throw new Error(`Demasiadas copias seleccionadas (máximo ${MAX_FILES}).`)
  const seen = new Set<string>()
  return paths.map((raw) => {
    if (typeof raw !== 'string' || !raw.trim() || !isAbsolute(raw))
      throw new Error('Ruta de copia de seguridad no válida.')
    const path = resolve(raw)
    if (!isBackupFileName(path))
      throw new Error(`${basename(path)} no es una copia de seguridad .nb3.`)
    if (seen.has(path)) throw new Error(`La copia ${basename(path)} está repetida en la selección.`)
    seen.add(path)
    const owner = owningConnection(ctx, path, source.sourceConnectionId ?? null)
    if (!owner)
      throw new Error(
        `${path} no está en la carpeta de copias de seguridad de ninguna conexión; solo se pueden restaurar copias de la lista de copias de seguridad.`
      )
    return { path, ...owner }
  })
}

/** Job a file-based restore is recorded under: the one job whose runs wrote every file, or the manual list. */
function attachJob(
  ctx: RollbackContext,
  refs: (BackupRunRef | undefined)[]
): { jobId: string; runId: string } {
  const jobIds = new Set(refs.map((r) => r?.jobId ?? ''))
  const runIds = new Set(refs.map((r) => r?.runId ?? ''))
  const only = jobIds.size === 1 ? [...jobIds][0] : ''
  if (only && ctx.jobs.get(only))
    return { jobId: only, runId: runIds.size === 1 ? [...runIds][0] : '' }
  return { jobId: MANUAL_ROLLBACKS_JOB_ID, runId: '' }
}

export async function buildFilesRollbackPlan(
  ctx: RollbackContext,
  source: RollbackFilesSource,
  targetConnectionId: string | null,
  inspector: RollbackInspector
): Promise<RollbackPlan> {
  const files = validateBackupPaths(ctx, source)
  const runs = backupRunIndex(ctx)
  const refs = files.map((f) => runs.get(backupPathKey(f.path)))
  const { target, existing, targetError } = await targetInfo(ctx, targetConnectionId, inspector)

  const items: RollbackPlanItem[] = []
  for (const [i, f] of files.entries()) {
    const ref = refs[i]
    items.push(
      await planItem(
        ctx,
        {
          // The path identifies the item: request.backupPaths selects them.
          taskId: f.path,
          referenceName: basename(f.path),
          path: f.path,
          expected: null,
          fallbackSchema: f.schemaFolder ?? (basename(dirname(f.path)) || null),
          sourceConnectionId: f.connection.id,
          structureOnly: ref ? !ref.includeData : false
        },
        target,
        existing,
        inspector
      )
    )
  }
  // One backup per database: the user has to pick which copy wins.
  const bySchema = new Map<string, string[]>()
  for (const item of items) {
    if (!item.schema) continue
    const list = bySchema.get(item.schema) ?? []
    list.push(basename(item.backupPath))
    bySchema.set(item.schema, list)
  }
  for (const [schema, names] of bySchema)
    if (names.length > 1)
      throw new Error(
        `Hay ${names.length} copias de «${schema}» en la selección (${names.join(', ')}); selecciona solo una por base de datos.`
      )

  const attached = attachJob(ctx, refs)
  const title = typeof source.title === 'string' ? source.title.trim().slice(0, MAX_TITLE) : ''
  const job = attached.jobId === MANUAL_ROLLBACKS_JOB_ID ? null : ctx.jobs.get(attached.jobId)
  const runDates = refs.map((r) => r?.startedAt ?? '')
  const newest = runDates.every(Boolean) ? runDates.sort().pop() : undefined
  return {
    source: 'files',
    runId: attached.runId,
    jobId: attached.jobId,
    jobName: title || job?.name || MANUAL_ROLLBACKS_NAME,
    runStartedAt: newest ?? (await newestFileDate(files.map((f) => f.path))),
    targetConnectionId: target?.id ?? null,
    items,
    targetError
  }
}

/** Newest modification date of the files (ISO); now when none can be read. */
async function newestFileDate(paths: string[]): Promise<string> {
  let best = 0
  for (const p of paths) {
    try {
      best = Math.max(best, (await stat(p)).mtimeMs)
    } catch {
      /* missing: reported per item */
    }
  }
  return best ? new Date(best).toISOString() : nowIso()
}

/** Plan of either source of «Restaurar todo»: a run id or backup files. */
export function buildAnyRollbackPlan(
  ctx: RollbackContext,
  source: string | RollbackFilesSource,
  targetConnectionId: string | null,
  inspector: RollbackInspector
): Promise<RollbackPlan> {
  if (typeof source === 'string')
    return buildRollbackPlan(ctx, source, targetConnectionId, inspector)
  if (!source || typeof source !== 'object' || source.source !== 'files')
    throw new Error('Restauración no válida.')
  return buildFilesRollbackPlan(ctx, source, targetConnectionId, inspector)
}

export const isFilesRequest = (
  request: RollbackRequest
): request is Extract<RollbackRequest, { source: 'files' }> =>
  !!request && typeof request === 'object' && request.source === 'files'

export interface PreparedRollback {
  job: Job
  options: RunOptions
}

/**
 * Turns a confirmed request into the synthetic job that performs it. The
 * caller has already enforced the typed confirmation; `confirmed` says
 * whether the target may be a connection that needs it (production or an
 * environment listed in Ajustes › Seguridad).
 */
export function prepareRollback(
  ctx: RollbackContext,
  plan: RollbackPlan,
  request: RollbackRequest,
  target: ConnectionConfig,
  confirmed: boolean
): PreparedRollback {
  const files = isFilesRequest(request)
  const ids = files ? (request.backupPaths ?? []).map((p) => resolve(p)) : (request.taskIds ?? [])
  const wanted = new Set(ids)
  if (!wanted.size) throw new Error('Selecciona al menos una base de datos para restaurar.')
  const items = plan.items.filter((i) => wanted.has(i.taskId))
  if (items.length !== wanted.size)
    throw new Error(
      files
        ? 'Alguna de las copias seleccionadas ya no está disponible.'
        : 'Alguna de las bases de datos seleccionadas ya no está en la ejecución.'
    )
  const system = items.find((i) => isSystemSchema(i.targetSchema))
  if (system) throw new Error(systemSchemaRefusal(system.targetSchema))
  const blocked = items.find((i) => i.problem)
  if (blocked)
    throw new Error(
      `«${blocked.schema || blocked.referenceName}» no se puede restaurar: ${blocked.problem}`
    )
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.targetSchema))
      throw new Error(
        `Hay más de una copia de «${item.targetSchema}» seleccionada; elige solo una por base de datos.`
      )
    seen.add(item.targetSchema)
  }
  const guarded = needsTypedConfirm(ctx, target)
  if (guarded && !confirmed)
    throw new Error(
      `«${target.name}» es una conexión de ${environmentPhrase(target.environment)}: confirma el reemplazo escribiendo su nombre.`
    )

  const sourceJob = ctx.jobs.get(plan.jobId)
  const now = nowIso()
  const job: Job = {
    id: plan.jobId,
    name: `Rollback a ${target.name} · ${plan.jobName}`,
    // One database failing never stops the others: each is independent.
    continueOnError: true,
    tasks: items.map((item, i) => ({
      // File items are keyed by path: number them instead.
      id: files ? `rollback-file-${i + 1}` : `rollback-${item.taskId}`,
      type: 'restoreschema',
      connectionId: target.id,
      schema: item.targetSchema,
      referenceName: restoreLabel({
        type: 'restoreschema',
        schema: item.targetSchema,
        connectionName: target.name,
        referenceName: '',
        sourceSchema: item.schema,
        sourceConnectionName: item.sourceConnectionName
      }),
      restoreSource: {
        kind: 'file',
        path: item.backupPath,
        schema: item.schema,
        connectionId: item.sourceConnectionId
      },
      safetyBackup: request.safetyBackup !== false,
      // «Solo estructura» only when asked explicitly (absent = structure and data).
      includeData: request.includeData !== false
    })),
    schedule: { enabled: false, cron: '', launchAgent: false },
    createdAt: now,
    updatedAt: now,
    lastRunAt: null
  }
  return {
    job,
    options: {
      kind: 'rollback',
      ...(plan.runId ? { rollbackOf: plan.runId } : {}),
      allowProductionRestore: guarded && confirmed,
      // Objects inside each database follow the source job's «Continuar en caso de error».
      restoreContinueOnError: sourceJob?.continueOnError ?? false
    }
  }
}
