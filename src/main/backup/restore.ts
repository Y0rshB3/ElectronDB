import { performance } from 'node:perf_hooks'
import type { ConnectionConfig, RestoreOptions, RestoreResult } from '@shared/types'
import { describeError } from '../mysql/errors'
import type { MysqlSession, SessionFactory } from '../mysql/types'
import type { ProgressReporter } from './index'
import { ENCRYPTED_MESSAGE, Nb3Reader, isCancelled } from './nb3/reader'
import { isEncrypted, type Nb3ManifestObject, type Nb3ObjectMeta } from './nb3/format'

/**
 * Restores a .nb3 backup into a target schema. Order: tables (DDL, rows,
 * IndexDDL, TriggerDDL, AUTO_INCREMENT), functions/procedures, views (retried
 * in passes so views depending on views resolve), events, anything else.
 */

export const PRODUCTION_GUARD_MESSAGE =
  'La conexión de destino es de producción; confirma explícitamente la restauración.'
export const RESTORE_CANCELLED = 'Restauración cancelada'

export const BATCH_MAX_ROWS = 500
export const BATCH_MAX_BYTES = 1024 * 1024

export interface RestoreDeps {
  connections: { get(id: string): ConnectionConfig | null }
  sessions: SessionFactory
}

interface PlannedObject {
  summary: Nb3ManifestObject
  meta: Nb3ObjectMeta
}

const DEFINER_RE =
  /\s+DEFINER\s*=\s*(?:`(?:[^`]|``)*`|'(?:[^'\\]|\\.)*'|[^\s@]+)\s*@\s*(?:`(?:[^`]|``)*`|'(?:[^'\\]|\\.)*'|[^\s(]+)/i

/** Removes `DEFINER=user@host` so the object is created with the current user as definer. */
export function stripDefiner(ddl: string): string {
  return ddl.replace(DEFINER_RE, '')
}

const PHASE_RANK: Record<string, number> = {
  table: 0,
  function: 1,
  procedure: 1,
  view: 2,
  event: 3
}
const rankOf = (type: string): number => PHASE_RANK[type.toLowerCase()] ?? 4

const DROP_KEYWORD: Record<string, string> = {
  table: 'TABLE',
  view: 'VIEW',
  function: 'FUNCTION',
  procedure: 'PROCEDURE',
  event: 'EVENT',
  trigger: 'TRIGGER'
}

function validate(options: RestoreOptions): void {
  if (!options || typeof options !== 'object')
    throw new Error('Opciones de restauración no válidas.')
  if (!options.backupPath) throw new Error('Selecciona el archivo de backup a restaurar.')
  if (!options.connectionId) throw new Error('Selecciona la conexión de destino.')
  if (!options.targetSchema || !options.targetSchema.trim())
    throw new Error('Indica la base de datos de destino.')
  if (!options.includeStructure && !options.includeData) {
    throw new Error('Elige restaurar la estructura, los datos o ambos.')
  }
}

/** Throws unless a write to this connection is allowed (production needs explicit confirmation). */
export function assertRestoreAllowed(
  connection: ConnectionConfig,
  options: Pick<RestoreOptions, 'confirmProduction'>
): void {
  if (connection.environment === 'production' && options.confirmProduction !== true) {
    throw new Error(PRODUCTION_GUARD_MESSAGE)
  }
}

/** Runs one DDL statement; on failure retries once without the DEFINER clause. */
export async function executeDdl(session: MysqlSession, ddl: string): Promise<void> {
  try {
    await session.execute(ddl)
  } catch (err) {
    const stripped = stripDefiner(ddl)
    if (stripped === ddl) throw err
    await session.execute(stripped)
  }
}

/** Accumulates row tuples into multi-row INSERT statements bounded by row count and bytes. */
export class InsertBatcher {
  private tuples: string[] = []
  private bytes = 0
  inserted = 0

  constructor(
    private readonly session: MysqlSession,
    private readonly prefix: string,
    private readonly maxRows = BATCH_MAX_ROWS,
    private readonly maxBytes = BATCH_MAX_BYTES
  ) {}

  async add(tuple: string): Promise<void> {
    const size = Buffer.byteLength(tuple, 'utf8') + 1
    if (
      this.tuples.length > 0 &&
      (this.tuples.length >= this.maxRows || this.bytes + size > this.maxBytes)
    ) {
      await this.flush()
    }
    this.tuples.push(tuple)
    this.bytes += size
  }

  async flush(): Promise<void> {
    if (this.tuples.length === 0) return
    const sql = `${this.prefix} ${this.tuples.join(',')}`
    const count = this.tuples.length
    this.tuples = []
    this.bytes = 0
    await this.session.execute(sql)
    this.inserted += count
  }
}

/** Session state we change for the restore and put back before the pooled connection is reused. */
interface SavedSessionState {
  sqlMode: string | null
}

async function prepareSession(session: MysqlSession): Promise<SavedSessionState> {
  let sqlMode: string | null = null
  try {
    const rows = await session.query<{ mode: unknown }>('SELECT @@SESSION.sql_mode AS mode')
    sqlMode = rows[0]?.mode === undefined || rows[0]?.mode === null ? null : String(rows[0].mode)
  } catch {
    sqlMode = null
  }
  await session.execute('SET NAMES utf8mb4')
  await session.execute('SET FOREIGN_KEY_CHECKS = 0')
  await session.execute('SET UNIQUE_CHECKS = 0')
  await session.execute("SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO'")
  return { sqlMode }
}

async function resetSession(session: MysqlSession, saved: SavedSessionState): Promise<void> {
  const quiet = (sql: string, params?: unknown[]): Promise<unknown> =>
    session.execute(sql, params).catch(() => undefined)
  await quiet('SET FOREIGN_KEY_CHECKS = 1')
  await quiet('SET UNIQUE_CHECKS = 1')
  if (saved.sqlMode !== null) await quiet('SET SQL_MODE = ?', [saved.sqlMode])
}

export async function restoreBackup(
  deps: RestoreDeps,
  options: RestoreOptions,
  progress: ProgressReporter = () => {},
  signal?: AbortSignal
): Promise<RestoreResult> {
  validate(options)
  const connection = deps.connections.get(options.connectionId)
  if (!connection) throw new Error('La conexión de destino ya no existe.')
  // Guard before touching the file or the server.
  assertRestoreAllowed(connection, options)

  const started = performance.now()
  const cancelled = (): boolean => signal?.aborted === true
  if (cancelled()) throw new Error(RESTORE_CANCELLED)

  const reader = await Nb3Reader.open(options.backupPath)
  const manifest = await reader.manifest()
  if (isEncrypted(manifest)) throw new Error(ENCRYPTED_MESSAGE)

  const wanted = new Set((options.objects ?? []).filter(Boolean))
  const selected = manifest.Objects.filter((o) => wanted.size === 0 || wanted.has(o.Name))
  if (wanted.size > 0 && selected.length === 0) {
    throw new Error('Ninguno de los objetos seleccionados está en el backup.')
  }
  const plan: PlannedObject[] = []
  for (const summary of selected)
    plan.push({ summary, meta: await reader.objectMeta(summary.UUID) })
  // Stable sort keeps the backup's own order inside each phase.
  plan.sort((a, b) => rankOf(a.summary.Type) - rankOf(b.summary.Type))

  const schema = options.targetSchema.trim()
  const session = await deps.sessions.acquire(options.connectionId, null)
  const result: RestoreResult = { objectsRestored: 0, rowsInserted: 0, errors: [], durationMs: 0 }
  let saved: SavedSessionState | null = null
  try {
    if (options.createSchema) {
      await session.execute(`CREATE DATABASE IF NOT EXISTS ${session.escapeId(schema)}`)
    }
    try {
      await session.useSchema(schema)
    } catch (err) {
      throw new Error(`No se pudo seleccionar la base de datos ${schema}: ${describeError(err)}`)
    }
    saved = await prepareSession(session)

    const total = plan.length
    let index = 0
    let stop = false
    const fail = (name: string, err: unknown): void => {
      result.errors.push({ object: name, message: describeError(err) })
      if (!options.continueOnError) stop = true
    }

    const regular = plan.filter((p) => p.summary.Type.toLowerCase() !== 'view')
    const views = plan.filter((p) => p.summary.Type.toLowerCase() === 'view')
    const runOne = async (item: PlannedObject): Promise<void> => {
      const name = item.summary.Name
      progress({
        phase: 'object',
        current: index,
        total,
        message: `Restaurando ${name}`,
        done: false
      })
      if (item.summary.Type.toLowerCase() === 'table') {
        result.rowsInserted += await restoreTable(
          session,
          reader,
          item.meta,
          name,
          options,
          signal,
          (rows) =>
            progress({
              phase: 'rows',
              current: index,
              total,
              message: `Restaurando ${name}: ${rows} filas`,
              done: false
            })
        )
      } else if (options.includeStructure) {
        await restoreDdlObject(
          session,
          item.summary.Type,
          name,
          item.meta,
          options.dropObjectsFirst
        )
      } else {
        // Data-only restore: nothing is executed for views/routines/events.
        return
      }
      result.objectsRestored++
    }

    const tablesAndRoutines = regular.filter((p) => rankOf(p.summary.Type) < PHASE_RANK.view)
    const afterViews = regular.filter((p) => rankOf(p.summary.Type) > PHASE_RANK.view)

    for (const item of tablesAndRoutines) {
      if (stop) break
      if (cancelled()) throw new Error(RESTORE_CANCELLED)
      try {
        await runOne(item)
      } catch (err) {
        if (cancelled() || isCancelled(err)) throw new Error(RESTORE_CANCELLED)
        fail(item.summary.Name, err)
      }
      index++
    }

    // Views may reference other views: retry failed ones while each pass makes progress.
    let pending = stop ? [] : views
    while (pending.length > 0 && !stop) {
      const failed: { item: PlannedObject; err: unknown }[] = []
      for (const item of pending) {
        if (cancelled()) throw new Error(RESTORE_CANCELLED)
        try {
          await runOne(item)
          index++
        } catch (err) {
          failed.push({ item, err })
        }
      }
      if (failed.length === pending.length) {
        for (const f of failed) {
          fail(f.item.summary.Name, f.err)
          index++
          if (stop) break
        }
        break
      }
      pending = failed.map((f) => f.item)
    }

    for (const item of afterViews) {
      if (stop) break
      if (cancelled()) throw new Error(RESTORE_CANCELLED)
      try {
        await runOne(item)
      } catch (err) {
        if (cancelled() || isCancelled(err)) throw new Error(RESTORE_CANCELLED)
        fail(item.summary.Name, err)
      }
      index++
    }
    progress({
      phase: 'finish',
      current: total,
      total,
      message: 'Restauración terminada',
      done: false
    })
  } finally {
    if (saved) await resetSession(session, saved)
    await session.release().catch(() => undefined)
  }
  result.durationMs = Math.round(performance.now() - started)
  return result
}

async function restoreDdlObject(
  session: MysqlSession,
  type: string,
  name: string,
  meta: Nb3ObjectMeta,
  dropFirst: boolean
): Promise<void> {
  const keyword = DROP_KEYWORD[type.toLowerCase()]
  if (dropFirst && keyword)
    await session.execute(`DROP ${keyword} IF EXISTS ${session.escapeId(name)}`)
  if (!meta.DDL.trim()) throw new Error(`El backup no contiene la definición de ${name}`)
  await executeDdl(session, meta.DDL)
  for (const sub of meta.SubDDL) if (sub.trim()) await executeDdl(session, sub)
}

async function restoreTable(
  session: MysqlSession,
  reader: Nb3Reader,
  meta: Nb3ObjectMeta,
  name: string,
  options: RestoreOptions,
  signal: AbortSignal | undefined,
  onRows: (rows: number) => void
): Promise<number> {
  const table = session.escapeId(name)
  if (options.includeStructure) {
    if (options.dropObjectsFirst) await session.execute(`DROP TABLE IF EXISTS ${table}`)
    if (!meta.DDL.trim()) throw new Error(`El backup no contiene la definición de la tabla ${name}`)
    await executeDdl(session, meta.DDL)
    for (const sub of meta.SubDDL) if (sub.trim()) await executeDdl(session, sub)
  }
  let inserted = 0
  if (options.includeData && meta.Data.length > 0) {
    const columns =
      meta.Fields.length > 0 ? ` (${meta.Fields.map((f) => session.escapeId(f)).join(', ')})` : ''
    const batcher = new InsertBatcher(session, `INSERT INTO ${table}${columns} VALUES`)
    let lastReported = 0
    await reader.rows(
      meta,
      async (tuple) => {
        await batcher.add(tuple)
        if (batcher.inserted - lastReported >= 5000) {
          lastReported = batcher.inserted
          onRows(batcher.inserted)
        }
      },
      signal
    )
    await batcher.flush()
    inserted = batcher.inserted
  }
  if (options.includeStructure) {
    for (const ddl of meta.IndexDDL) if (ddl.trim()) await executeDdl(session, ddl)
    for (const ddl of meta.TriggerDDL) if (ddl.trim()) await executeDdl(session, ddl)
    if (/^\d+$/.test(meta.AutoIncrement.trim())) {
      await session.execute(`ALTER TABLE ${table} AUTO_INCREMENT = ${meta.AutoIncrement.trim()}`)
    }
  }
  return inserted
}
