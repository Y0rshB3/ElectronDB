import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describeObjectCounts } from '@shared/jobLog'
import type { BackupCreateOptions, BackupCreateResult, ConnectionConfig } from '@shared/types'
import { APP_VERSION } from '../appVersion'
import { APP_NAME } from '../brand'
import { CAPABILITY_MESSAGES, requireConnectionCapability } from '../db/errors'
import { describeError } from '../mysql/errors'
import {
  MARIADB_SKIPPED_OBJECTS_SQL,
  describeSkippedObjects,
  isMariaDbSession,
  skippedFromTableTypes
} from '../mysql/mariadb'
import type { MysqlSession, SessionFactory } from '../mysql/types'
import type { ProgressReporter } from './index'
import { literalKindOf, renderTuple, type LiteralKind } from './mysqlLiterals'
import { formatBackupFileName } from './naming'
import { NB3_EXTENSION } from './nb3/format'
import { Nb3Writer, type ObjectDefinition } from './nb3/writer'
import { detectMysqlFlavor } from '@shared/serverFlavor'
import type { ScryptParams } from './vqb/crypto'
import { VQB_EXTENSION, type VqbObjectType } from './vqb/format'
import { mysqlCodecOf } from './vqb/mysqlValues'
import { VqbWriter } from './vqb/writer'

/**
 * Creates a backup of one MySQL schema, as a .vqb (Vortaq's own open format,
 * docs/vqb-format.md) or a Navicat-compatible .nb3: tables (DDL, fields,
 * AUTO_INCREMENT, triggers, rows), then views, functions, procedures and
 * events with their SHOW CREATE DDL. Both formats share the listing, the
 * snapshot and the progress; only the archive sink differs.
 */

export const BACKUP_CANCELLED = 'Backup cancelado'

export interface CreateDeps {
  connections: { get(id: string): ConnectionConfig | null }
  sessions: SessionFactory
  /** Clock used for the file name; injectable for tests. */
  now?: () => Date
  /** Uncompressed bytes per data chunk (tests use small values). */
  chunkLimit?: number
  /** scrypt cost of encrypted .vqb backups (tests use a cheap one). */
  scrypt?: ScryptParams
}

/** Smallest password accepted for an encrypted backup. */
export const MIN_BACKUP_PASSWORD = 8
export const SHORT_PASSWORD_MESSAGE = `La contraseña de la copia debe tener al menos ${MIN_BACKUP_PASSWORD} caracteres.`

/** Format of a new backup: absent = .nb3 (the API predates .vqb; the UI always sends one). */
export const backupFormatOf = (options: Pick<BackupCreateOptions, 'format'>): 'nb3' | 'vqb' =>
  options.format === 'vqb' ? 'vqb' : 'nb3'

/** Where the rows and DDL of one backup go (.nb3 or .vqb). */
interface ArchiveSink {
  beginTable(name: string, columns: ColumnRow[]): TableSink
  ddlObject(type: Exclude<ObjectKind, 'Table'>, name: string, ddl: string): Promise<void>
  warn(message: string): void
  finish(): Promise<{ path: string; sizeBytes: number; objects: number; rows: number }>
  abort(): Promise<void>
}

interface TableSink {
  readonly rowCount: number
  addRow(values: unknown[]): Promise<void>
  finish(definition: {
    ddl: string
    triggerDdl: string[]
    autoIncrement: string
  }): Promise<{ rows: number }>
}

function nb3Sink(writer: Nb3Writer): ArchiveSink {
  return {
    beginTable(name, columns) {
      const kinds: LiteralKind[] = columns.map((c) => literalKindOf(c.columnType))
      const object = writer.beginObject('Table', name)
      return {
        get rowCount() {
          return object.rowCount
        },
        addRow: (values) => object.addRow(renderTuple(values, kinds)),
        finish: async (d) => {
          const definition: ObjectDefinition = {
            ddl: d.ddl,
            fields: columns.map((c) => c.name),
            autoIncrement: d.autoIncrement,
            triggerDdl: d.triggerDdl,
            indexDdl: [],
            subDdl: []
          }
          return object.finish(definition)
        }
      }
    },
    ddlObject: async (type, name, ddl) => {
      await writer.beginObject(type, name).finish({ ddl })
    },
    // .nb3 has no slot for notes; the job log and the dialog show the warning.
    warn: () => undefined,
    finish: () => writer.finish(),
    abort: () => writer.abort()
  }
}

const VQB_TYPE: Record<Exclude<ObjectKind, 'Table'>, VqbObjectType> = {
  View: 'view',
  Function: 'function',
  Procedure: 'procedure',
  Event: 'event'
}

function vqbSink(writer: VqbWriter): ArchiveSink {
  return {
    beginTable(name, columns) {
      const object = writer.beginObject('table', name)
      object.setColumns(
        columns.map((c) => ({ name: c.name, type: c.columnType })),
        columns.map((c) => mysqlCodecOf(c.columnType))
      )
      return {
        get rowCount() {
          return object.rowCount
        },
        addRow: (values) => object.addRow(values),
        finish: (d) =>
          object.finish({
            ddl: d.ddl,
            meta: {
              autoIncrement: d.autoIncrement || null,
              triggers: d.triggerDdl,
              indexes: [],
              foreignKeys: []
            }
          })
      }
    },
    ddlObject: async (type, name, ddl) => {
      await writer.beginObject(VQB_TYPE[type], name).finish({ ddl })
    },
    warn: (message) => writer.warn(message),
    finish: () => writer.finish(),
    abort: () => writer.abort()
  }
}

/** Default character set and collation of a schema (recorded in .vqb manifests). */
async function schemaDefaults(
  session: MysqlSession,
  schema: string
): Promise<{ charset: string | null; collation: string | null }> {
  try {
    const rows = await session.query<{ cs: unknown; co: unknown }>(
      'SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS co FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [schema]
    )
    return { charset: text(rows[0]?.cs) || null, collation: text(rows[0]?.co) || null }
  } catch {
    return { charset: null, collation: null }
  }
}

/** Throws unless the password of an encrypted backup is acceptable. */
export function checkBackupPassword(password: string | null | undefined): string | null {
  if (password === null || password === undefined || password === '') return null
  if (typeof password !== 'string') throw new Error('Contraseña de la copia no válida.')
  if (password.length < MIN_BACKUP_PASSWORD) throw new Error(SHORT_PASSWORD_MESSAGE)
  return password
}

type ObjectKind = 'Table' | 'View' | 'Function' | 'Procedure' | 'Event'

interface SchemaObject {
  type: ObjectKind
  name: string
  /** information_schema TABLE_ROWS (an InnoDB estimate), null when unknown. */
  rowsEstimate: number | null
}

interface ColumnRow {
  name: string
  columnType: string
  extra: string
}

const ROW_PROGRESS_EVERY = 5000
/** Estimated rows worth one object in the progress weights (see objectWeight). */
const ROWS_PER_WORK_UNIT = 1000
/** A table never reports more than this share of its weight before it finishes. */
const MAX_PARTIAL_SHARE = 0.99

/**
 * Progress weight of one object: 1 unit plus its estimated rows, so the bar
 * advances with rows inside a large table and with objects across many small ones.
 */
export function objectWeight(estimate: number | null, includeData: boolean): number {
  return 1 + (includeData && estimate && estimate > 0 ? estimate / ROWS_PER_WORK_UNIT : 0)
}

/** Weighted work of a table that has written `rows` of an estimated `estimate`. */
export function partialWork(weight: number, rows: number, estimate: number | null): number {
  if (!estimate || estimate <= 0 || rows <= 0) return 0
  return weight * Math.min(MAX_PARTIAL_SHARE, rows / estimate)
}

const estimateOf = (value: unknown): number | null => {
  if (value === null || value === undefined) return null
  const n = Number(text(value))
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}

const KIND_LABEL: Record<ObjectKind, string> = {
  Table: 'tabla',
  View: 'vista',
  Function: 'función',
  Procedure: 'procedimiento',
  Event: 'evento'
}

const SHOW_CREATE: Record<Exclude<ObjectKind, 'Table'>, { stmt: string; column: string }> = {
  View: { stmt: 'SHOW CREATE VIEW', column: 'Create View' },
  Function: { stmt: 'SHOW CREATE FUNCTION', column: 'Create Function' },
  Procedure: { stmt: 'SHOW CREATE PROCEDURE', column: 'Create Procedure' },
  Event: { stmt: 'SHOW CREATE EVENT', column: 'Create Event' }
}

const TYPE_ORDER: ObjectKind[] = ['Table', 'View', 'Function', 'Procedure', 'Event']

/** information_schema may hand back Buffers for some columns depending on the driver/charset. */
const text = (value: unknown): string =>
  value === null || value === undefined
    ? ''
    : Buffer.isBuffer(value)
      ? value.toString('utf8')
      : String(value)

/** Generated columns cannot be inserted into; DEFAULT_GENERATED is a plain default and stays. */
const GENERATED_RE = /\b(VIRTUAL|STORED) GENERATED\b/i
/** Table option right after ENGINE in SHOW CREATE TABLE (and Navicat's spaced variant). */
const AUTO_INCREMENT_RE = /\)\s*ENGINE\s*=\s*\w+\s+AUTO_INCREMENT\s*=\s*(\d+)/i

export function parseAutoIncrement(ddl: string): string {
  return AUTO_INCREMENT_RE.exec(ddl)?.[1] ?? ''
}

/**
 * MySQL 8 caches information_schema statistics (TABLE_ROWS) for a day by
 * default, so a table filled since then would report no rows. Asks for fresh
 * estimates while listing; best effort (older servers and MariaDB lack it).
 */
async function withFreshStats<T>(session: MysqlSession, fn: () => Promise<T>): Promise<T> {
  let changed = false
  try {
    await session.execute('SET SESSION information_schema_stats_expiry = 0')
    changed = true
  } catch {
    /* not supported: cached estimates are still better than none */
  }
  try {
    return await fn()
  } finally {
    if (changed)
      await session
        .execute('SET SESSION information_schema_stats_expiry = DEFAULT')
        .catch(() => undefined)
  }
}

async function listObjects(
  session: MysqlSession,
  schema: string,
  freshStats: boolean,
  /** Receives the TABLE_TYPE rows of the listing (no extra query). */
  onTables?: (rows: { name: unknown; type: unknown }[]) => void
): Promise<SchemaObject[]> {
  const listTables = () =>
    session.query<{ name: unknown; type: unknown; estRows?: unknown }>(
      'SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS estRows FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [schema]
    )
  const tables = await (freshStats ? withFreshStats(session, listTables) : listTables())
  onTables?.(tables)
  const routines = await session.query<{ name: unknown; type: unknown }>(
    'SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME',
    [schema]
  )
  const events = await session.query<{ name: unknown }>(
    'SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME',
    [schema]
  )
  const objects: SchemaObject[] = []
  for (const t of tables) {
    const type = text(t.type).toUpperCase()
    if (type === 'BASE TABLE')
      objects.push({ type: 'Table', name: text(t.name), rowsEstimate: estimateOf(t.estRows) })
    else if (type === 'VIEW') objects.push({ type: 'View', name: text(t.name), rowsEstimate: null })
  }
  for (const r of routines) {
    const type = text(r.type).toUpperCase()
    if (type === 'FUNCTION')
      objects.push({ type: 'Function', name: text(r.name), rowsEstimate: null })
    else if (type === 'PROCEDURE')
      objects.push({ type: 'Procedure', name: text(r.name), rowsEstimate: null })
  }
  for (const e of events) objects.push({ type: 'Event', name: text(e.name), rowsEstimate: null })
  return objects.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type))
}

async function listTriggers(session: MysqlSession, schema: string): Promise<Map<string, string[]>> {
  const rows = await session.query<{ name: unknown; tableName: unknown }>(
    'SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tableName FROM information_schema.TRIGGERS ' +
      'WHERE TRIGGER_SCHEMA = ? ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER',
    [schema]
  )
  const byTable = new Map<string, string[]>()
  for (const r of rows) {
    const table = text(r.tableName)
    const list = byTable.get(table) ?? []
    list.push(text(r.name))
    byTable.set(table, list)
  }
  return byTable
}

async function showCreate(
  session: MysqlSession,
  stmt: string,
  name: string,
  column: string
): Promise<string> {
  const rows = await session.query<Record<string, unknown>>(`${stmt} ${session.escapeId(name)}`)
  const ddl = text(rows[0]?.[column])
  if (!ddl) {
    throw new Error(
      `No se pudo obtener la definición de ${name}: el usuario no tiene permisos suficientes para verla`
    )
  }
  return ddl
}

async function tableColumns(
  session: MysqlSession,
  schema: string,
  table: string
): Promise<ColumnRow[]> {
  const rows = await session.query<{ name: unknown; columnType: unknown; extra: unknown }>(
    'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS columnType, EXTRA AS extra FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [schema, table]
  )
  return rows.map((r) => ({
    name: text(r.name),
    columnType: text(r.columnType),
    extra: text(r.extra)
  }))
}

/** Picks `<dir>/<stamp>[-label].<ext>`, adding a numeric suffix if a file with that name already exists. */
export async function uniqueTarget(
  dir: string,
  date: Date,
  label: string | undefined,
  extension: string = NB3_EXTENSION
): Promise<string> {
  for (let i = 1; i < 1000; i++) {
    const suffix = i === 1 ? label : `${label ? `${label}-` : ''}${i}`
    const candidate = join(dir, formatBackupFileName(date, suffix, extension))
    const exists = await stat(candidate).then(
      () => true,
      () => false
    )
    const partialExists = await stat(`${candidate}.partial`).then(
      () => true,
      () => false
    )
    if (!exists && !partialExists) return candidate
  }
  throw new Error(`No se pudo elegir un nombre libre para el backup en ${dir}`)
}

function validate(options: BackupCreateOptions): void {
  if (!options || typeof options !== 'object') throw new Error('Opciones de backup no válidas.')
  if (!options.connectionId) throw new Error('Selecciona una conexión para el backup.')
  if (!options.schema || !options.schema.trim())
    throw new Error('Selecciona la base de datos a respaldar.')
  if (options.format !== undefined && options.format !== 'nb3' && options.format !== 'vqb')
    throw new Error('Formato de copia no válido: elige .vqb o .nb3.')
  if (options.password && backupFormatOf(options) !== 'vqb')
    throw new Error('Solo las copias .vqb se pueden cifrar con contraseña.')
  checkBackupPassword(options.password)
}

export async function createBackup(
  deps: CreateDeps,
  options: BackupCreateOptions,
  progress: ProgressReporter = () => {},
  signal?: AbortSignal
): Promise<BackupCreateResult> {
  validate(options)
  const started = performance.now()
  const connection = deps.connections.get(options.connectionId)
  if (!connection) throw new Error('La conexión del backup ya no existe.')
  requireConnectionCapability(connection, 'supportsBackupsNb3', CAPABILITY_MESSAGES.backups)
  const schema = options.schema
  const targetDir =
    options.targetDir?.trim() || (connection.backupDir ? join(connection.backupDir, schema) : '')
  if (!targetDir) {
    throw new Error(`La conexión ${connection.name} no tiene carpeta de backups configurada.`)
  }
  const cancelled = (): boolean => signal?.aborted === true
  if (cancelled()) throw new Error(BACKUP_CANCELLED)

  const format = backupFormatOf(options)
  const password = checkBackupPassword(options.password)
  const session = await deps.sessions.acquire(options.connectionId, schema)
  let writer: ArchiveSink | null = null
  let inTransaction = false
  let timeZone: string | null = null
  try {
    if (format === 'vqb') {
      // TIMESTAMP values are read as text in UTC and the manifest says so: no shift on restore.
      try {
        await session.execute("SET SESSION time_zone = '+00:00'")
        timeZone = '+00:00'
      } catch {
        timeZone = null
      }
    }
    // Consistent view of every InnoDB table, like mysqldump --single-transaction.
    try {
      await session.execute('START TRANSACTION WITH CONSISTENT SNAPSHOT')
      inTransaction = true
    } catch {
      inTransaction = false
    }

    const wanted = new Set((options.objects ?? []).filter(Boolean))
    // MariaDB: system-versioned tables and sequences have no .nb3 slot and are left out;
    // say so (names only) instead of skipping them silently. Read from the same listing.
    let skippedWarning = null as string | null
    const objects = (
      await listObjects(session, schema, options.includeData, (rows) => {
        if (!isMariaDbSession(session)) return
        skippedWarning = describeSkippedObjects(
          skippedFromTableTypes(rows).filter((o) => wanted.size === 0 || wanted.has(o.name))
        )
      })
    ).filter((o) => wanted.size === 0 || wanted.has(o.name))
    if (wanted.size > 0 && objects.length === 0) {
      throw new Error(`Ninguno de los objetos seleccionados existe en ${schema}.`)
    }
    const triggers = objects.some((o) => o.type === 'Table')
      ? await listTriggers(session, schema)
      : new Map()

    const date = (deps.now ?? (() => new Date()))()
    const target = await uniqueTarget(
      targetDir,
      date,
      options.label,
      format === 'vqb' ? VQB_EXTENSION : NB3_EXTENSION
    )
    if (format === 'vqb') {
      const defaults = await schemaDefaults(session, schema)
      writer = vqbSink(
        await VqbWriter.create(target, {
          manifest: {
            app: { name: APP_NAME, version: APP_VERSION },
            engine: {
              id: 'mysql',
              flavor: detectMysqlFlavor(session.serverVersion),
              serverVersion: session.serverVersion
            },
            source: {
              ...(options.omitConnectionName ? {} : { connectionName: connection.name }),
              database: schema,
              charset: defaults.charset,
              collation: defaults.collation,
              timeZone
            },
            comment: options.comment,
            options: {
              includeData: options.includeData,
              structureOnly: !options.includeData,
              partial: wanted.size > 0
            }
          },
          password,
          scrypt: deps.scrypt,
          chunkBytes: deps.chunkLimit,
          now: () => date
        })
      )
    } else {
      writer = nb3Sink(
        await Nb3Writer.create(target, {
          schema,
          comment: options.comment,
          chunkLimit: deps.chunkLimit
        })
      )
    }
    const total = objects.length
    if (skippedWarning) {
      writer.warn(skippedWarning)
      progress({ phase: 'warning', current: 0, total, message: skippedWarning, done: false })
    }
    const weights = objects.map((o) => objectWeight(o.rowsEstimate, options.includeData))
    const workTotal = weights.reduce((sum, w) => sum + w, 0)
    let workDone = 0
    progress({
      phase: 'list',
      current: 0,
      total,
      message: describeObjectCounts(objects.map((o) => o.type)),
      done: false,
      detail: { objects: total, objectsDone: 0, workDone: 0, workTotal }
    })

    for (let i = 0; i < objects.length; i++) {
      if (cancelled()) throw new Error(BACKUP_CANCELLED)
      const obj = objects[i]
      const label = `${KIND_LABEL[obj.type]} ${obj.name}`
      const rowsEstimate = obj.type === 'Table' && options.includeData ? obj.rowsEstimate : null
      const objectDetail = {
        objectType: obj.type,
        objectName: obj.name,
        objectIndex: i + 1,
        objects: total,
        rowsEstimate,
        workTotal
      }
      progress({
        phase: 'object',
        current: i,
        total,
        message: `Respaldando ${label}`,
        done: false,
        detail: {
          ...objectDetail,
          objectsDone: i,
          rows: obj.type === 'Table' ? 0 : null,
          workDone
        }
      })
      let rows: number | null = null
      try {
        if (obj.type === 'Table') {
          const written = await backupTable(
            session,
            writer,
            schema,
            obj.name,
            triggers.get(obj.name) ?? [],
            options.includeData,
            {
              cancelled,
              onRows: (count) =>
                progress({
                  phase: 'rows',
                  current: i,
                  total,
                  message: `Respaldando ${label}: ${count} filas`,
                  done: false,
                  detail: {
                    ...objectDetail,
                    objectsDone: i,
                    rows: count,
                    workDone: workDone + partialWork(weights[i], count, rowsEstimate)
                  }
                })
            }
          )
          rows = options.includeData ? written : null
        } else {
          const spec = SHOW_CREATE[obj.type]
          const ddl = await showCreate(session, spec.stmt, obj.name, spec.column)
          await writer.ddlObject(obj.type, obj.name, ddl)
        }
      } catch (err) {
        if (cancelled()) throw new Error(BACKUP_CANCELLED)
        const message = describeError(err)
        progress({
          phase: 'objectError',
          current: i,
          total,
          message: `Error al respaldar ${label}`,
          done: false,
          detail: { ...objectDetail, objectsDone: i, error: message, workDone }
        })
        throw new Error(`Error al respaldar ${label}: ${message}`)
      }
      workDone += weights[i]
      progress({
        phase: 'objectDone',
        current: i + 1,
        total,
        message: `${label} respaldada`,
        done: false,
        detail: { ...objectDetail, objectsDone: i + 1, rows, workDone }
      })
    }
    if (cancelled()) throw new Error(BACKUP_CANCELLED)
    progress({
      phase: 'finish',
      current: total,
      total,
      message: 'Cerrando archivo de backup',
      done: false
    })
    const result = await writer.finish()
    return {
      path: result.path,
      sizeBytes: result.sizeBytes,
      objects: result.objects,
      rows: result.rows,
      durationMs: Math.round(performance.now() - started)
    }
  } catch (err) {
    await writer?.abort()
    if (cancelled()) throw new Error(BACKUP_CANCELLED)
    throw err
  } finally {
    if (inTransaction) await session.execute('COMMIT').catch(() => undefined)
    if (timeZone) await session.execute('SET SESSION time_zone = DEFAULT').catch(() => undefined)
    await session.release().catch(() => undefined)
  }
}

async function backupTable(
  session: MysqlSession,
  writer: ArchiveSink,
  schema: string,
  table: string,
  triggerNames: string[],
  includeData: boolean,
  hooks: { cancelled: () => boolean; onRows: (rows: number) => void }
): Promise<number> {
  const ddl = await showCreate(session, 'SHOW CREATE TABLE', table, 'Create Table')
  const columns = (await tableColumns(session, schema, table)).filter(
    (c) => !GENERATED_RE.test(c.extra)
  )
  const triggerDdl: string[] = []
  for (const name of triggerNames) {
    triggerDdl.push(
      await showCreate(session, 'SHOW CREATE TRIGGER', name, 'SQL Original Statement')
    )
  }
  const object = writer.beginTable(table, columns)
  if (includeData && columns.length > 0) {
    const select = `SELECT ${columns.map((c) => session.escapeId(c.name)).join(', ')} FROM ${session.escapeId(table)}`
    const { rows } = await session.streamRows(select)
    try {
      for await (const row of rows as AsyncIterable<unknown[]>) {
        if (hooks.cancelled()) break
        await object.addRow(row)
        if (object.rowCount % ROW_PROGRESS_EVERY === 0) hooks.onRows(object.rowCount)
      }
    } finally {
      if (!rows.destroyed) rows.destroy()
    }
    if (hooks.cancelled()) throw new Error(BACKUP_CANCELLED)
  }
  const { rows } = await object.finish({
    ddl,
    triggerDdl,
    autoIncrement: parseAutoIncrement(ddl)
  })
  return rows
}

/**
 * Pre-backup check for the backup dialog (P1b): on a MariaDB server, the
 * warning naming the system-versioned tables and sequences a .nb3 of `schema`
 * would leave out; null otherwise. A MySQL server is never queried.
 */
export async function skippedObjectsWarning(
  sessions: SessionFactory,
  connectionId: string,
  schema: string
): Promise<string | null> {
  if (!schema?.trim()) return null
  const session = await sessions.acquire(connectionId)
  try {
    if (!isMariaDbSession(session)) return null
    const rows = await session.query<{ name: unknown; type: unknown }>(
      MARIADB_SKIPPED_OBJECTS_SQL,
      [schema]
    )
    return describeSkippedObjects(skippedFromTableTypes(rows))
  } finally {
    await session.release().catch(() => undefined)
  }
}
