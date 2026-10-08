import { performance } from 'node:perf_hooks'
import type { ConnectionConfig, RestoreOptions, RestoreResult } from '@shared/types'
import { CAPABILITY_MESSAGES, requireConnectionCapability } from '../db/errors'
import { describeError } from '../mysql/errors'
import type { MysqlSession, SessionFactory } from '../mysql/types'
import type { ProgressReporter } from './index'
import { openMysqlRestoreArchive, type RestoreArchive } from './archive'
import { setSequenceValueSql } from '../mysql/mariadb'
import { isCancelled } from './nb3/reader'
import type { Nb3ManifestObject, Nb3ObjectMeta } from './nb3/format'

/**
 * Restores a .nb3 or MySQL .vqb backup into a target schema (both are read
 * through RestoreArchive, see archive.ts). Order: tables (DDL, rows,
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

/**
 * Spanish advice for MySQL errors that typically appear when a backup from
 * another server (staging 5.7) is restored into a local 8.x; null otherwise.
 */
export function restoreErrorHint(err: unknown): string | null {
  const errno = (err as { errno?: unknown })?.errno
  switch (typeof errno === 'number' ? errno : null) {
    case 1418: // ER_BINLOG_UNSAFE_ROUTINE
    case 1419: // ER_BINLOG_CREATE_ROUTINE_NEED_SUPER
      return 'Pista: el servidor de destino tiene el binlog activado y no acepta rutinas sin DETERMINISTIC, NO SQL o READS SQL DATA. Ejecuta en el destino SET GLOBAL log_bin_trust_function_creators = 1 (o añade esa característica a la rutina en el origen) y vuelve a restaurar.'
    case 1227: // ER_SPECIFIC_ACCESS_DENIED_ERROR
      return 'Pista: el usuario de la conexión de destino no tiene privilegios suficientes (SUPER, o SET_USER_ID/SYSTEM_USER para objetos con otro DEFINER); restaura con un usuario administrador.'
    case 1449: // ER_NO_SUCH_USER
      return 'Pista: el DEFINER del objeto no existe en el servidor de destino; crea ese usuario o restaura con un usuario que pueda leer mysql.user.'
    case 1273: // ER_UNKNOWN_COLLATION
    case 1115: // ER_UNKNOWN_CHARACTER_SET
      return 'Pista: el servidor de destino no conoce esa colación o juego de caracteres (por ejemplo utf8mb4_0900_ai_ci no existe en MySQL 5.7).'
    case 1146: // ER_NO_SUCH_TABLE
      return 'Pista: el objeto usa una tabla que no está en la copia ni en el destino.'
    default:
      return null
  }
}

/** describeError plus the restore hint, if any. */
export function describeRestoreError(err: unknown): string {
  const message = describeError(err)
  const hint = restoreErrorHint(err)
  return hint ? `${message}. ${hint}` : message
}

/** `AUTO_INCREMENT=N` table option of SHOW CREATE TABLE (after ENGINE, or right after the column list). */
const TABLE_AUTO_INCREMENT_RE = /(\)\s*(?:ENGINE\s*=\s*\w+\s+)?)AUTO_INCREMENT\s*=\s*\d+\s*/i

/**
 * Removes the `AUTO_INCREMENT=N` table option so the table counter starts
 * fresh. The column attribute `AUTO_INCREMENT` (no `=`) is kept.
 */
export function stripAutoIncrementOption(ddl: string): string {
  const stripped = ddl.replace(TABLE_AUTO_INCREMENT_RE, (_, head: string) => head)
  return stripped === ddl ? ddl : stripped.trimEnd()
}

/** Removes `DEFINER=user@host` so the object is created with the current user as definer. */
export function stripDefiner(ddl: string): string {
  return ddl.replace(DEFINER_RE, '')
}

// MariaDB sequences go first: a table may take its default from NEXTVAL(seq).
const PHASE_RANK: Record<string, number> = {
  sequence: 0,
  table: 1,
  function: 2,
  procedure: 2,
  view: 3,
  event: 4
}
const rankOf = (type: string): number => PHASE_RANK[type.toLowerCase()] ?? 5

const DROP_KEYWORD: Record<string, string> = {
  table: 'TABLE',
  view: 'VIEW',
  function: 'FUNCTION',
  procedure: 'PROCEDURE',
  event: 'EVENT',
  trigger: 'TRIGGER',
  sequence: 'SEQUENCE'
}

function validate(options: RestoreOptions): void {
  if (!options || typeof options !== 'object')
    throw new Error('Opciones de restauración no válidas.')
  if (!options.backupPath) throw new Error('Selecciona el archivo de la copia a restaurar.')
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

const unquoteAccountPart = (part: string): string => {
  const q = part[0]
  if ((q === '`' || q === "'") && part.endsWith(q) && part.length >= 2)
    return part.slice(1, -1).replace(q === '`' ? /``/g : /\\(.)/g, q === '`' ? '`' : '$1')
  return part
}

/** `DEFINER=user@host` of a DDL statement, unquoted; null when there is none. */
export function definerOf(ddl: string): { user: string; host: string } | null {
  const m =
    /\sDEFINER\s*=\s*(`(?:[^`]|``)*`|'(?:[^'\\]|\\.)*'|[^\s@]+)\s*@\s*(`(?:[^`]|``)*`|'(?:[^'\\]|\\.)*'|[^\s(]+)/i.exec(
      ddl
    )
  return m ? { user: unquoteAccountPart(m[1]), host: unquoteAccountPart(m[2]) } : null
}

/**
 * Remembers whether DEFINER accounts exist on the target server. A backup
 * from another server (staging 5.7 -> local 8.4) usually names accounts the
 * target lacks: MySQL accepts such objects but every use fails with "The
 * user specified as a definer does not exist", so their DEFINER is dropped
 * (the restoring user becomes the definer). Unknown (no privilege to read
 * mysql.user) keeps the DDL as it is.
 */
export class DefinerAccounts {
  private readonly known = new Map<string, boolean | null>()

  constructor(private readonly session: MysqlSession) {}

  async exists(user: string, host: string): Promise<boolean | null> {
    const key = `${user}@${host}`
    if (this.known.has(key)) return this.known.get(key)!
    let found: boolean | null = null
    try {
      const rows = await this.session.query<{ n: unknown }>(
        'SELECT COUNT(*) AS n FROM mysql.user WHERE User = ? AND Host = ?',
        [user, host]
      )
      found = rows.length ? Number(rows[0].n) > 0 : null
    } catch {
      found = null
    }
    this.known.set(key, found)
    return found
  }
}

/**
 * Runs one DDL statement; a DEFINER whose account does not exist on the
 * target is removed up front, and any failure is retried once without it.
 */
export async function executeDdl(
  session: MysqlSession,
  ddl: string,
  definers?: DefinerAccounts
): Promise<void> {
  const definer = definers ? definerOf(ddl) : null
  if (definer && (await definers!.exists(definer.user, definer.host)) === false) {
    await session.execute(stripDefiner(ddl))
    return
  }
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
  /** The time zone was changed for the archive's TIMESTAMP text. */
  timeZone: boolean
  /** MariaDB system_versioning_insert_history was turned on (history rows of a .vqb). */
  insertHistory?: boolean
  /** End value of current versioned rows on this server (see currentRowEnd); null = unknown. */
  currentEnd?: string | null
}

async function prepareSession(
  session: MysqlSession,
  timeZone: string | null = null
): Promise<SavedSessionState> {
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
  if (timeZone) await session.execute('SET time_zone = ?', [timeZone])
  return { sqlMode, timeZone: !!timeZone }
}

async function resetSession(session: MysqlSession, saved: SavedSessionState): Promise<void> {
  const quiet = (sql: string, params?: unknown[]): Promise<unknown> =>
    session.execute(sql, params).catch(() => undefined)
  await quiet('SET FOREIGN_KEY_CHECKS = 1')
  await quiet('SET UNIQUE_CHECKS = 1')
  if (saved.sqlMode !== null) await quiet('SET SQL_MODE = ?', [saved.sqlMode])
  if (saved.timeZone) await quiet('SET time_zone = DEFAULT')
  if (saved.insertHistory) await quiet('SET @@session.system_versioning_insert_history = DEFAULT')
}

/**
 * Lets the session insert history rows (period columns) into system-versioned
 * tables: MariaDB 10.11+. False when the server refuses it (older MariaDB).
 */
async function allowHistoryInsert(
  session: MysqlSession,
  saved: SavedSessionState
): Promise<boolean> {
  if (saved.insertHistory) return true
  try {
    await session.execute('SET @@session.system_versioning_insert_history = 1')
    saved.insertHistory = true
    return true
  } catch {
    return false
  }
}

/**
 * End value MariaDB gives the current rows of a system-versioned table, as text in the session
 * time zone: the largest TIMESTAMP, 2106-02-07 06:28:15.999999 UTC on MariaDB 11.5+ (where
 * FROM_UNIXTIME reaches it), 2038-01-19 03:14:07.999999 UTC before. Asked once per restore.
 */
async function currentRowEnd(
  session: MysqlSession,
  saved: SavedSessionState
): Promise<string | undefined> {
  if (saved.currentEnd === undefined) {
    try {
      const rows = await session.query<{ e: unknown }>(
        'SELECT CAST(COALESCE(FROM_UNIXTIME(4294967295.999999), FROM_UNIXTIME(2147483647.999999)) AS CHAR) AS e'
      )
      const e = rows[0]?.e
      saved.currentEnd = e === null || e === undefined ? null : String(e)
    } catch {
      saved.currentEnd = null
    }
  }
  return saved.currentEnd ?? undefined
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
  requireConnectionCapability(connection, 'supportsBackupsNb3', CAPABILITY_MESSAGES.backups)
  // Guard before touching the file or the server.
  assertRestoreAllowed(connection, options)

  const started = performance.now()
  const cancelled = (): boolean => signal?.aborted === true
  if (cancelled()) throw new Error(RESTORE_CANCELLED)

  // Opening checks the format, the engine and (encrypted .vqb) the password before the server.
  const reader = await openMysqlRestoreArchive(options.backupPath, options.password)
  try {
    return await restoreFrom(deps, reader, options, progress, signal, started)
  } finally {
    await reader.close()
  }
}

async function restoreFrom(
  deps: RestoreDeps,
  reader: RestoreArchive,
  options: RestoreOptions,
  progress: ProgressReporter,
  signal: AbortSignal | undefined,
  started: number
): Promise<RestoreResult> {
  const cancelled = (): boolean => signal?.aborted === true
  const manifest = await reader.manifest()

  const wanted = new Set((options.objects ?? []).filter(Boolean))
  const selected = manifest.Objects.filter((o) => wanted.size === 0 || wanted.has(o.Name))
  if (wanted.size > 0 && selected.length === 0) {
    throw new Error('Ninguno de los objetos seleccionados está en la copia.')
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
    saved = await prepareSession(session, reader.timeZone)
    const definers = new DefinerAccounts(session)

    const total = plan.length
    let index = 0
    let done = 0
    let stop = false
    const detailOf = (item: PlannedObject) => ({
      objectType: item.summary.Type,
      objectName: item.summary.Name,
      objectIndex: Math.min(total, index + 1),
      objects: total
    })
    const fail = (item: PlannedObject, err: unknown): void => {
      const message = describeRestoreError(err)
      result.errors.push({ object: item.summary.Name, message })
      // Structured per-object failure: automation logs print one line per object.
      progress({
        phase: 'objectError',
        current: index,
        total,
        message: `Error al restaurar ${item.summary.Name}`,
        done: false,
        detail: { ...detailOf(item), objectsDone: done, error: message }
      })
      if (!options.continueOnError) stop = true
    }

    const regular = plan.filter((p) => p.summary.Type.toLowerCase() !== 'view')
    const views = plan.filter((p) => p.summary.Type.toLowerCase() === 'view')
    const runOne = async (item: PlannedObject): Promise<void> => {
      const name = item.summary.Name
      const isTable = item.summary.Type.toLowerCase() === 'table'
      const estimate = isTable && /^\d+$/.test(item.summary.Rows) ? Number(item.summary.Rows) : null
      progress({
        phase: 'object',
        current: index,
        total,
        message: `Restaurando ${name}`,
        done: false,
        detail: {
          ...detailOf(item),
          objectsDone: done,
          rows: isTable && options.includeData ? 0 : null,
          rowsEstimate: options.includeData ? estimate : null
        }
      })
      let rows: number | null = null
      if (isTable) {
        rows = await restoreTable(
          session,
          reader,
          item.meta,
          name,
          options,
          definers,
          saved!,
          signal,
          (count) =>
            progress({
              phase: 'rows',
              current: index,
              total,
              message: `Restaurando ${name}: ${count} filas`,
              done: false,
              detail: {
                ...detailOf(item),
                objectsDone: done,
                rows: count,
                rowsEstimate: options.includeData ? estimate : null
              }
            }),
          (message) => progress({ phase: 'warning', current: index, total, message, done: false })
        )
        result.rowsInserted += rows
        if (!options.includeData) rows = null
      } else if (options.includeStructure) {
        await restoreDdlObject(
          session,
          item.summary.Type,
          name,
          item.meta,
          options.dropObjectsFirst,
          definers
        )
        if (options.includeData) await setSequenceValue(session, reader, item.meta, name)
      } else if (options.includeData && reader.sequenceState?.(item.meta)) {
        // Data only: a sequence's value is its data.
        await setSequenceValue(session, reader, item.meta, name)
      } else {
        // Data-only restore: nothing is executed for views/routines/events.
        return
      }
      result.objectsRestored++
      done++
      progress({
        phase: 'objectDone',
        current: index + 1,
        total,
        message: `${name} restaurado`,
        done: false,
        detail: { ...detailOf(item), objectsDone: done, rows }
      })
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
        fail(item, err)
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
          fail(f.item, f.err)
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
        fail(item, err)
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
  dropFirst: boolean,
  definers: DefinerAccounts
): Promise<void> {
  const keyword = DROP_KEYWORD[type.toLowerCase()]
  if (dropFirst && keyword)
    await session.execute(`DROP ${keyword} IF EXISTS ${session.escapeId(name)}`)
  if (!meta.DDL.trim()) throw new Error(`La copia no contiene la definición de ${name}`)
  await executeDdl(session, meta.DDL, definers)
  for (const sub of meta.SubDDL) if (sub.trim()) await executeDdl(session, sub, definers)
}

/** MariaDB sequence of a .vqb: SETVAL to where the backed up one was (no-op otherwise). */
async function setSequenceValue(
  session: MysqlSession,
  reader: RestoreArchive,
  meta: Nb3ObjectMeta,
  name: string
): Promise<void> {
  const state = reader.sequenceState?.(meta)
  if (state) await session.execute(setSequenceValueSql(session.escapeId(name), state))
}

async function restoreTable(
  session: MysqlSession,
  reader: RestoreArchive,
  meta: Nb3ObjectMeta,
  name: string,
  options: RestoreOptions,
  definers: DefinerAccounts,
  saved: SavedSessionState,
  signal: AbortSignal | undefined,
  onRows: (rows: number) => void,
  onWarning: (message: string) => void
): Promise<number> {
  const table = session.escapeId(name)
  if (options.includeStructure) {
    if (options.dropObjectsFirst) await session.execute(`DROP TABLE IF EXISTS ${table}`)
    if (!meta.DDL.trim()) throw new Error(`La copia no contiene la definición de la tabla ${name}`)
    const ddl = options.skipAutoIncrement ? stripAutoIncrementOption(meta.DDL) : meta.DDL
    await executeDdl(session, ddl, definers)
    for (const sub of meta.SubDDL) if (sub.trim()) await executeDdl(session, sub, definers)
  }
  let inserted = 0
  if (options.includeData && meta.Data.length > 0) {
    // A system-versioned table of a .vqb carries its history in the two last (period)
    // columns; where the server cannot take history rows only the current ones go in.
    const versioned = reader.versioning?.(meta) ?? null
    const currentOnly = !!versioned && !(await allowHistoryInsert(session, saved))
    const currentEnd = versioned && !currentOnly ? await currentRowEnd(session, saved) : undefined
    const fields = currentOnly ? meta.Fields.slice(0, -2) : meta.Fields
    const columns =
      fields.length > 0 ? ` (${fields.map((f) => session.escapeId(f)).join(', ')})` : ''
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
      signal,
      currentOnly ? { currentOnly: true } : currentEnd ? { currentEnd } : undefined
    )
    await batcher.flush()
    inserted = batcher.inserted
    if (currentOnly)
      onWarning(
        `${name}: el servidor de destino no admite insertar historial (MariaDB 10.11 o posterior), así que solo se han restaurado las filas actuales de la tabla versionada.`
      )
  }
  if (options.includeStructure) {
    for (const ddl of meta.IndexDDL) if (ddl.trim()) await executeDdl(session, ddl, definers)
    for (const ddl of meta.TriggerDDL) if (ddl.trim()) await executeDdl(session, ddl, definers)
    if (!options.skipAutoIncrement && /^\d+$/.test(meta.AutoIncrement.trim())) {
      await session.execute(`ALTER TABLE ${table} AUTO_INCREMENT = ${meta.AutoIncrement.trim()}`)
    }
  }
  return inserted
}
