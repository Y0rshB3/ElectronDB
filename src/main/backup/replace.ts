import {
  STRUCTURE_ONLY_LABEL,
  describeObjectCounts,
  formatSize,
  labelLine,
  plural,
  undoHint,
  type SafetyCopy
} from '@shared/jobLog'
import { SAFETY_BACKUP_LABEL, isSystemSchema, systemSchemaRefusal } from '@shared/restoreTask'
import type { BackupCreateResult, BackupMeta, ConnectionConfig, RestoreResult } from '@shared/types'
import { CAPABILITY_MESSAGES, requireConnectionCapability } from '../db/errors'
import { describeError } from '../mysql/errors'
import type { MysqlSession, SessionFactory } from '../mysql/types'
import type { BackupService, ProgressReporter } from './index'
import { ENCRYPTED_MESSAGE, Nb3Reader } from './nb3/reader'
import { NB3_ENCRYPTION_NONE } from './nb3/format'

/**
 * REPLACE restore ("rollback"): the target database ends up equal to the
 * backup. Per database, strictly in this order:
 *
 *   1. verify the .nb3 (exists, readable, not encrypted, manifest schema is
 *      the expected one, and every entry's checksum and gzip stream: a full
 *      read of the file) — nothing is touched when it fails;
 *   2. if the target database exists and the safety backup is on, back it up
 *      into the target connection's backupDir/<schema>/ labelled
 *      'previo-rollback' — when this fails the database is NOT touched;
 *   3. DROP DATABASE + CREATE DATABASE with the backup's charset/collation
 *      when the target server knows them (server default otherwise);
 *   4. restore every object with its data, or with empty tables when
 *      `includeData` is false («Solo estructura»: same tables, indexes,
 *      foreign keys, views, routines, events and triggers, no rows, and the
 *      backup's AUTO_INCREMENT values are not applied so counters start fresh).
 *
 * Once the database has been dropped any failure or cancellation throws a
 * ReplaceIncompleteError that says the database is incomplete and how to
 * get the previous state back (the safety copy).
 */

export const SAFETY_LABEL = SAFETY_BACKUP_LABEL
export const REPLACE_CANCELLED = 'Restauración cancelada'
export const REPLACE_PRODUCTION_MESSAGE =
  'La conexión de destino es de producción; confirma explícitamente el reemplazo de la base de datos.'

export interface SchemaCharset {
  charset: string
  collation: string | null
}

export interface ReplaceDeps {
  connections: { get(id: string): ConnectionConfig | null }
  sessions: SessionFactory
  backups: Pick<BackupService, 'create' | 'restore' | 'readMeta' | 'verify'>
  /** Default charset/collation of the backed up schema; injectable for tests. */
  backupCharset?: (path: string) => Promise<SchemaCharset | null>
}

export interface ReplaceRequest {
  backupPath: string
  /** Schema the backup must contain (its manifest `Schema`). */
  expectedSchema: string
  /** Target connection and database (replaced). */
  connectionId: string
  targetSchema: string
  /** Back up the target database before dropping it. */
  safetyBackup: boolean
  /** Keep restoring the remaining objects after one fails. */
  continueOnError: boolean
  /** Required when the target connection is flagged production. */
  confirmProduction?: boolean
  /** Restore the rows too (default true); false = «Solo estructura». */
  includeData?: boolean
}

export interface ReplaceHooks {
  /** One human log line (names, counts, sizes and paths only). */
  line?(body: string): void
  /** Progress of the safety backup ('safety') and of the restore ('restore'). */
  progress?(stage: 'safety' | 'restore', event: Parameters<ProgressReporter>[0]): void
  /** Called as soon as the safety backup file exists (before anything is dropped). */
  safetyBackupDone?(result: BackupCreateResult): void
}

export interface ReplaceResult {
  /** The target database existed (and was replaced). */
  existed: boolean
  /** Target connection name (for messages). */
  connectionName: string
  safetyBackup: BackupCreateResult | null
  /** Charset/collation used for CREATE DATABASE; null = server default. */
  charset: SchemaCharset | null
  /** False when only the structure was restored (empty tables). */
  includeData: boolean
  restore: RestoreResult
}

const IDENT_RE = /^[A-Za-z0-9_]+$/

/**
 * Thrown once the target database has been dropped: it is now missing or
 * only partly restored. The message says so and how to undo.
 */
export class ReplaceIncompleteError extends Error {
  constructor(
    message: string,
    readonly schema: string,
    readonly connectionName: string,
    readonly safetyBackupPath: string | null
  ) {
    super(message)
    this.name = 'ReplaceIncompleteError'
  }
}

/** "«auth» ha quedado incompleta en «Local». <how to undo>" */
export function incompleteNotice(
  schema: string,
  connectionName: string,
  safetyPath: string | null,
  existed = true
): string {
  const state = `«${schema}» ha quedado incompleta en «${connectionName}».`
  if (safetyPath) {
    const copy: SafetyCopy = { schema, connectionName, path: safetyPath }
    return `${state} ${undoHint(copy)}`
  }
  return existed
    ? `${state} No había copia previa: vuelve a restaurar el backup para completarla.`
    : `${state} Vuelve a restaurar el backup para completarla.`
}

/** "No se ha modificado X." appended to every failure that happens before the DROP. */
const untouched = (schema: string, connection: string): string =>
  `«${schema}» no se ha modificado en «${connection}».`

/** Ends `text` with a full stop (once) so another sentence can follow. */
const sentence = (text: string): string =>
  /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`

/**
 * Step 1: the backup exists, is a readable unencrypted .nb3 and holds
 * `expectedSchema`. Throws an actionable message otherwise.
 */
export async function verifyBackupSource(
  backups: Pick<BackupService, 'readMeta'>,
  path: string,
  expectedSchema: string
): Promise<BackupMeta> {
  let meta: BackupMeta
  try {
    meta = await backups.readMeta(path)
  } catch (err) {
    throw new Error(`No se puede usar el backup ${path}: ${describeError(err)}`)
  }
  if (meta.encryption && meta.encryption !== NB3_ENCRYPTION_NONE)
    throw new Error(`No se puede usar el backup ${path}: ${ENCRYPTED_MESSAGE}`)
  if (meta.schema !== expectedSchema) {
    throw new Error(
      `El backup ${path} contiene la base de datos «${meta.schema || '?'}», no «${expectedSchema}».`
    )
  }
  return meta
}

const CHARSET_RE =
  /\bDEFAULT\s+(?:CHARSET|CHARACTER\s+SET)\s*=?\s*(\w+)(?:\s+COLLATE\s*=?\s*(\w+))?/i
/** Table DDLs read to guess the schema default (each read is one small gz entry). */
const MAX_TABLES_SAMPLED = 50

/**
 * Charset/collation the backed up schema most likely had: the most common
 * table default in the backup's CREATE TABLE statements (Navicat's format
 * does not store the schema default itself). Null when there are no tables.
 */
export async function readBackupCharset(path: string): Promise<SchemaCharset | null> {
  const reader = await Nb3Reader.open(path)
  const manifest = await reader.manifest()
  const counts = new Map<string, { value: SchemaCharset; n: number }>()
  const tables = manifest.Objects.filter((o) => o.Type.toLowerCase() === 'table').slice(
    0,
    MAX_TABLES_SAMPLED
  )
  for (const table of tables) {
    const meta = await reader.objectMeta(table.UUID)
    const m = CHARSET_RE.exec(meta.DDL)
    if (!m) continue
    const value = { charset: m[1].toLowerCase(), collation: m[2]?.toLowerCase() ?? null }
    const key = `${value.charset}/${value.collation ?? ''}`
    const entry = counts.get(key) ?? { value, n: 0 }
    entry.n++
    counts.set(key, entry)
  }
  let best: { value: SchemaCharset; n: number } | null = null
  for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry
  return best?.value ?? null
}

/**
 * Keeps only what the target server supports: a collation unknown there (e.g.
 * utf8mb4_0900_ai_ci on 5.7) falls back to the charset's default collation,
 * an unknown charset to the server default.
 */
export async function resolveCharset(
  session: MysqlSession,
  wanted: SchemaCharset | null
): Promise<SchemaCharset | null> {
  if (!wanted || !IDENT_RE.test(wanted.charset)) return null
  const charsets = await session.query<{ name: unknown }>(
    'SELECT CHARACTER_SET_NAME AS name FROM information_schema.CHARACTER_SETS WHERE CHARACTER_SET_NAME = ?',
    [wanted.charset]
  )
  if (!charsets.length) return null
  if (!wanted.collation || !IDENT_RE.test(wanted.collation))
    return { charset: wanted.charset, collation: null }
  const collations = await session.query<{ name: unknown }>(
    'SELECT COLLATION_NAME AS name FROM information_schema.COLLATIONS WHERE COLLATION_NAME = ? AND CHARACTER_SET_NAME = ?',
    [wanted.collation, wanted.charset]
  )
  return { charset: wanted.charset, collation: collations.length ? wanted.collation : null }
}

export async function schemaExists(session: MysqlSession, schema: string): Promise<boolean> {
  const rows = await session.query<{ name: unknown }>(
    'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
    [schema]
  )
  return rows.length > 0
}

function createDatabaseSql(
  session: MysqlSession,
  schema: string,
  charset: SchemaCharset | null
): string {
  let sql = `CREATE DATABASE ${session.escapeId(schema)}`
  if (charset) sql += ` CHARACTER SET ${charset.charset}`
  if (charset?.collation) sql += ` COLLATE ${charset.collation}`
  return sql
}

function validate(request: ReplaceRequest): void {
  if (!request || typeof request !== 'object') throw new Error('Restauración no válida.')
  if (!request.backupPath) throw new Error('Falta el archivo de backup a restaurar.')
  if (!request.expectedSchema?.trim()) throw new Error('Falta la base de datos del backup.')
  if (!request.connectionId) throw new Error('Falta la conexión de destino.')
  if (!request.targetSchema?.trim()) throw new Error('Falta la base de datos de destino.')
  // Never DROP DATABASE mysql/sys/...: same rule as dropDatabase in the tree.
  if (isSystemSchema(request.targetSchema))
    throw new Error(systemSchemaRefusal(request.targetSchema))
}

/** Replaces `targetSchema` with the content of the backup (see the module comment). */
export async function replaceSchemaFromBackup(
  deps: ReplaceDeps,
  request: ReplaceRequest,
  hooks: ReplaceHooks = {},
  signal?: AbortSignal
): Promise<ReplaceResult> {
  validate(request)
  const say = (body: string): void => hooks.line?.(body)
  const cancelled = (): boolean => signal?.aborted === true
  const connection = deps.connections.get(request.connectionId)
  if (!connection) throw new Error('La conexión de destino ya no existe.')
  requireConnectionCapability(connection, 'supportsBackupsNb3', CAPABILITY_MESSAGES.backups)
  if (connection.environment === 'production' && request.confirmProduction !== true)
    throw new Error(REPLACE_PRODUCTION_MESSAGE)
  const target = request.targetSchema.trim()
  const keep = untouched(target, connection.name)
  const includeData = request.includeData !== false

  // 1. Source integrity, before touching the server.
  let meta: BackupMeta
  try {
    meta = await verifyBackupSource(deps.backups, request.backupPath, request.expectedSchema)
  } catch (err) {
    throw new Error(`${sentence(describeError(err))} ${keep}`)
  }
  say(`  Origen: ${request.backupPath}`)
  say(`  Contiene ${describeObjectCounts(meta.objects.map((o) => String(o.type)))}`)
  say(
    includeData
      ? '  Contenido: estructura y datos'
      : `  Contenido: ${STRUCTURE_ONLY_LABEL.toLowerCase()} (tablas vacías con sus claves e índices; sin filas y con AUTO_INCREMENT desde el principio)`
  )
  // The manifest alone does not prove the data is readable: read every entry now,
  // while dropping is still avoidable (a damaged chunk would fail after the DROP).
  const integrityLabel = 'Comprobar integridad del backup'
  try {
    const checked = await deps.backups.verify(request.backupPath, signal)
    say(
      labelLine({
        label: integrityLabel,
        value: plural(checked.rows, 'fila', 'filas'),
        status: 'ok'
      })
    )
  } catch (err) {
    if (cancelled()) throw new Error(REPLACE_CANCELLED)
    const message = describeError(err)
    say(labelLine({ label: integrityLabel, status: 'error', error: message }))
    throw new Error(
      `${sentence(`No se puede usar el backup ${request.backupPath}: ${message}`)} ${keep}`
    )
  }
  if (cancelled()) throw new Error(REPLACE_CANCELLED)
  const wanted = await (deps.backupCharset ?? readBackupCharset)(request.backupPath).catch(
    () => null
  )
  if (cancelled()) throw new Error(REPLACE_CANCELLED)

  // 2-3. Safety backup, then DROP + CREATE on one session.
  let existed = false
  let safety: BackupCreateResult | null = null
  let applied: SchemaCharset | null = null
  let session: MysqlSession
  try {
    session = await deps.sessions.acquire(request.connectionId, null)
  } catch (err) {
    throw new Error(
      `${sentence(`No se pudo conectar con «${connection.name}»: ${describeError(err)}`)} ${keep}`
    )
  }
  try {
    try {
      existed = await schemaExists(session, target)
    } catch (err) {
      throw new Error(
        `${sentence(`No se pudo comprobar si «${target}» existe en «${connection.name}»: ${describeError(err)}`)} ${keep}`
      )
    }
    if (!existed) {
      say(`  «${target}» no existe en ${connection.name}: se creará`)
    } else if (!request.safetyBackup) {
      say(`  Copia previa desactivada: «${target}» se reemplaza sin copia`)
    } else {
      const label = `Copia previa de ${target}`
      try {
        safety = await deps.backups.create(
          {
            connectionId: request.connectionId,
            schema: target,
            includeData: true,
            label: SAFETY_LABEL,
            comment: `Copia automática antes de restaurar ${request.backupPath}`
          },
          (event) => hooks.progress?.('safety', event),
          signal
        )
      } catch (err) {
        if (cancelled()) throw new Error(REPLACE_CANCELLED)
        const message = describeError(err)
        say(labelLine({ label, status: 'error', error: message }))
        throw new Error(
          `${sentence(`No se pudo hacer la copia de seguridad previa de «${target}»: ${message}`)} ${keep}`
        )
      }
      hooks.safetyBackupDone?.(safety)
      say(
        labelLine({
          label,
          value: `${plural(safety.objects, 'objeto', 'objetos')} · ${formatSize(safety.sizeBytes)}`,
          status: 'ok'
        })
      )
      say(`  Copia previa: ${safety.path}`)
    }
    if (cancelled()) throw new Error(REPLACE_CANCELLED)

    applied = await resolveCharset(session, wanted).catch(() => null)
    const recreate = existed
      ? `Reemplazar base de datos ${target}`
      : `Crear base de datos ${target}`
    const charsetText = applied ? (applied.collation ?? applied.charset) : 'por defecto'
    let dropped = false
    try {
      if (existed) {
        await session.execute(`DROP DATABASE ${session.escapeId(target)}`)
        dropped = true
      }
      await session.execute(createDatabaseSql(session, target, applied))
    } catch (err) {
      const message = describeError(err)
      say(labelLine({ label: recreate, status: 'error', error: message }))
      if (!dropped)
        throw new Error(`${sentence(`No se pudo recrear «${target}»: ${message}`)} ${keep}`)
      throw new ReplaceIncompleteError(
        `${sentence(`No se pudo crear de nuevo «${target}» después de borrarla: ${message}`)} ${incompleteNotice(target, connection.name, safety?.path ?? null)}`,
        target,
        connection.name,
        safety?.path ?? null
      )
    }
    say(labelLine({ label: recreate, value: charsetText, status: 'ok' }))
    if (wanted && applied?.collation !== wanted.collation && wanted.collation) {
      say(
        `  La colación ${wanted.collation} no existe en ${connection.name}: se usa ${applied ? `${applied.charset} con su colación por defecto` : 'la del servidor'}`
      )
    }
  } finally {
    await session.release().catch(() => undefined)
  }

  // From here on the target is new/empty: every failure leaves it incomplete.
  const safetyPath = safety?.path ?? null
  const incomplete = (reason: string): ReplaceIncompleteError =>
    new ReplaceIncompleteError(
      `${sentence(reason)} ${incompleteNotice(target, connection.name, safetyPath, existed)}`,
      target,
      connection.name,
      safetyPath
    )
  if (cancelled()) throw incomplete(REPLACE_CANCELLED)

  // 4. Every object (with its data unless «Solo estructura») into the fresh database.
  let restore: RestoreResult
  try {
    restore = await deps.backups.restore(
      {
        backupPath: request.backupPath,
        connectionId: request.connectionId,
        targetSchema: target,
        createSchema: false,
        dropObjectsFirst: false,
        includeStructure: true,
        includeData,
        ...(includeData ? {} : { skipAutoIncrement: true }),
        continueOnError: request.continueOnError,
        ...(request.confirmProduction ? { confirmProduction: true } : {})
      },
      (event) => hooks.progress?.('restore', event),
      signal
    )
  } catch (err) {
    if (cancelled()) throw incomplete(REPLACE_CANCELLED)
    throw incomplete(`No se pudo terminar de restaurar «${target}»: ${describeError(err)}`)
  }
  return {
    existed,
    connectionName: connection.name,
    safetyBackup: safety,
    charset: applied,
    includeData,
    restore: includeData ? restore : { ...restore, structureOnly: true }
  }
}
