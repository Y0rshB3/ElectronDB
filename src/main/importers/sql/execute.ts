import { performance } from 'node:perf_hooks'
import { MysqlStatementStream, trimAscii } from '@shared/dialects/mysqlStream'
import type { SqlStatement } from '@shared/dialects/types'
import {
  SQL_IMPORT_CANCELLED,
  type SqlDumpError,
  type SqlDumpImportOptions,
  type SqlDumpImportResult
} from '@shared/importers'
import { isSystemSchema, systemSchemaRefusal } from '@shared/restoreTask'
import { replaceSafetyPlan } from '../../mysql/mariadb'
import type { BackupCreateOptions, ConnectionConfig, ProgressDetail } from '@shared/types'
import type { BackupService, ProgressReporter } from '../../backup/index'
import {
  DefinerAccounts,
  definerOf,
  describeRestoreError,
  stripDefiner
} from '../../backup/restore'
import { CAPABILITY_MESSAGES, requireConnectionCapability } from '../../db/errors'
import { describeError } from '../../mysql/errors'
import type { MysqlSession, SessionFactory } from '../../mysql/types'
import {
  classifyStatement,
  excerpt,
  redirectAlterDatabase,
  type DumpObjectKind,
  type StatementInfo
} from './classify'
import { emptyCounts } from './inspect'
import { dumpFileInfo, readDumpChunks } from './reader'

/**
 * Runs a SQL dump statement by statement on one session, reading the file as
 * a stream (gzip supported). Statements go through the text protocol
 * (`MysqlSession.execute` uses `query`), so DELIMITER bodies, LOCK TABLES and
 * conditional comments run exactly as the mysql client would send them.
 */

export interface SqlImportDeps {
  connections: { get(id: string): ConnectionConfig | null }
  sessions: SessionFactory
  /** Safety copies before a database is replaced. */
  backups: Pick<BackupService, 'create'>
  /**
   * Format of those safety copies: the one chosen in Ajustes (defaultBackupFormat;
   * `.sql` is not restorable by «Deshacer», so it means `.vqb`). Absent: `.nb3`.
   */
  safetyFormat?(): 'vqb' | 'nb3'
}

/** Safety-copy format for a «Nueva copia» default ('sql' and absent mean .vqb, the default). */
export function safetyFormatOf(defaultFormat: string | undefined): 'vqb' | 'nb3' {
  return defaultFormat === 'nb3' ? 'nb3' : 'vqb'
}

export const IMPORT_SAFETY_LABEL = 'previo-importacion'
export const IMPORT_PRODUCTION_MESSAGE =
  'La conexión de destino es de producción; confirma explícitamente la importación.'

const PROGRESS_EVERY_MS = 200
const ERROR_STATEMENT_CHARS = 160
const EVENT_STATEMENT_CHARS = 80

const CREATED_MESSAGE: Record<DumpObjectKind, (name: string) => string> = {
  Table: (n) => `Tabla ${n} creada`,
  View: (n) => `Vista ${n} creada`,
  Procedure: (n) => `Procedimiento ${n} creado`,
  Function: (n) => `Función ${n} creada`,
  Trigger: (n) => `Trigger ${n} creado`,
  Event: (n) => `Evento ${n} creado`,
  Database: (n) => `Base de datos ${n} creada`
}

const COUNT_KEY: Record<DumpObjectKind, keyof ReturnType<typeof emptyCounts>> = {
  Table: 'tables',
  View: 'views',
  Procedure: 'routines',
  Function: 'routines',
  Trigger: 'triggers',
  Event: 'events',
  Database: 'databases'
}

function validate(options: SqlDumpImportOptions): void {
  if (!options || typeof options !== 'object')
    throw new Error('Opciones de importación no válidas.')
  if (!options.path) throw new Error('Elige el archivo .sql a importar.')
  if (!options.connectionId) throw new Error('Selecciona la conexión de destino.')
  if (options.mode !== 'asFile' && options.mode !== 'intoSchema')
    throw new Error(
      'Elige cómo importar: respetando las bases de datos del archivo o en un esquema.'
    )
  const target = options.targetSchema?.trim() ?? ''
  if (options.mode === 'intoSchema' && !target) throw new Error('Indica el esquema de destino.')
  if (target && isSystemSchema(target)) throw new Error(systemSchemaRefusal(target))
  if (options.replaceSchema && options.mode !== 'intoSchema')
    throw new Error('Reemplazar la base de datos solo es posible al importar todo en un esquema.')
}

/** Session state changed for the import and put back before the session is released. */
async function saveSqlMode(session: MysqlSession): Promise<string | null> {
  try {
    const rows = await session.query<{ mode: unknown }>('SELECT @@SESSION.sql_mode AS mode')
    const mode = rows[0]?.mode
    return mode === undefined || mode === null ? null : String(mode)
  } catch {
    return null
  }
}

async function resetSession(session: MysqlSession, sqlMode: string | null): Promise<void> {
  const quiet = (sql: string, params?: unknown[]): Promise<unknown> =>
    session.execute(sql, params).catch(() => undefined)
  await quiet('SET FOREIGN_KEY_CHECKS = 1')
  await quiet('SET UNIQUE_CHECKS = 1')
  if (sqlMode !== null) await quiet('SET SQL_MODE = ?', [sqlMode])
}

async function schemaCharset(
  session: MysqlSession,
  schema: string
): Promise<{ charset: string; collation: string } | null> {
  const rows = await session.query<{ cs: unknown; co: unknown }>(
    'SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS co FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
    [schema]
  )
  if (!rows.length) return null
  return { charset: String(rows[0].cs ?? ''), collation: String(rows[0].co ?? '') }
}

/** 5.7 dumps set sql_mode with NO_AUTO_CREATE_USER, which 8.x refuses (error 1231). */
const NO_AUTO_CREATE_USER_RE = /,?\s*NO_AUTO_CREATE_USER\s*,?/i
function withoutNoAutoCreateUser(sql: string): string | null {
  if (!/sql_mode/i.test(sql) || !/NO_AUTO_CREATE_USER/i.test(sql)) return null
  return sql.replace(/'([^']*)'/g, (whole, value: string) =>
    NO_AUTO_CREATE_USER_RE.test(value)
      ? `'${value
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v && v.toUpperCase() !== 'NO_AUTO_CREATE_USER')
          .join(',')}'`
      : whole
  )
}

const errnoOf = (err: unknown): number | null => {
  const errno = (err as { errno?: unknown })?.errno
  return typeof errno === 'number' ? errno : null
}

export async function importSqlDump(
  deps: SqlImportDeps,
  options: SqlDumpImportOptions,
  progress: ProgressReporter = () => {},
  signal?: AbortSignal
): Promise<SqlDumpImportResult> {
  validate(options)
  const connection = deps.connections.get(options.connectionId)
  if (!connection) throw new Error('La conexión de destino ya no existe.')
  requireConnectionCapability(connection, 'supportsBackupsNb3', CAPABILITY_MESSAGES.backups)
  if (connection.environment === 'production' && options.confirmProduction !== true)
    throw new Error(IMPORT_PRODUCTION_MESSAGE)
  const cancelled = (): boolean => signal?.aborted === true
  if (cancelled()) throw new Error(SQL_IMPORT_CANCELLED)

  const info = await dumpFileInfo(options.path)
  const started = performance.now()
  const target = options.targetSchema?.trim() || null
  const intoSchema = options.mode === 'intoSchema'
  const total = info.sizeBytes
  const result: SqlDumpImportResult = {
    statements: 0,
    executed: 0,
    rowsAffected: 0,
    created: emptyCounts(),
    errors: [],
    skipped: 0,
    databases: [],
    bytesRead: 0,
    bytesTotal: total,
    durationMs: 0,
    safetyBackupPath: null
  }
  let bytes = 0
  const emit = (phase: string, message: string, detail?: ProgressDetail): void =>
    progress({ phase, current: bytes, total, message, done: false, ...(detail ? { detail } : {}) })

  emit('start', 'Leyendo archivo')
  const session = await deps.sessions.acquire(options.connectionId, null)
  let sqlMode: string | null = null
  let sessionPrepared = false
  try {
    // Replace: safety copy first (nothing is touched when it fails), then DROP + CREATE.
    if (intoSchema && options.replaceSchema && target) {
      const existing = await schemaCharset(session, target)
      if (existing && options.safetyBackup !== false) {
        // MariaDB: sequences and versioned tables need a .vqb copy; history no copy can hold
        // (transaction-precise versioning) is never dropped behind the user.
        let plan
        try {
          plan = await replaceSafetyPlan(session, target)
        } catch (err) {
          throw new Error(
            `No se pudo comprobar qué objetos tiene ${target}; no se ha tocado nada: ${describeError(err)}`
          )
        }
        if (plan.refusal) throw new Error(plan.refusal)
        const backupOptions: BackupCreateOptions = {
          connectionId: options.connectionId,
          schema: target,
          includeData: true,
          label: IMPORT_SAFETY_LABEL,
          ...(plan.vqb || deps.safetyFormat?.() === 'vqb' ? { format: 'vqb' as const } : {})
        }
        let copy
        try {
          copy = await deps.backups.create(
            backupOptions,
            (event) =>
              progress({
                ...event,
                phase: 'safety',
                current: 0,
                total,
                message: `Copia previa · ${event.message}`,
                done: false
              }),
            signal
          )
        } catch (err) {
          if (cancelled()) throw new Error(SQL_IMPORT_CANCELLED)
          throw new Error(
            `No se pudo hacer la copia previa de ${target}; no se ha tocado nada: ${describeError(err)}`
          )
        }
        result.safetyBackupPath = copy.path
        emit('safety', `Copia previa · guardada en ${copy.path}`)
      }
      if (cancelled()) throw new Error(SQL_IMPORT_CANCELLED)
      const charset = existing?.charset
        ? ` CHARACTER SET ${existing.charset}${existing.collation ? ` COLLATE ${existing.collation}` : ''}`
        : ''
      await session.execute(`DROP DATABASE IF EXISTS ${session.escapeId(target)}`)
      await session.execute(`CREATE DATABASE ${session.escapeId(target)}${charset}`)
    } else if (target && options.createSchema) {
      await session.execute(`CREATE DATABASE IF NOT EXISTS ${session.escapeId(target)}`)
    }
    if (target) {
      try {
        await session.useSchema(target)
      } catch (err) {
        throw new Error(`No se pudo seleccionar la base de datos ${target}: ${describeError(err)}`)
      }
    }
    sqlMode = await saveSqlMode(session)
    sessionPrepared = true
    await session.execute('SET NAMES utf8mb4')

    // Byte-exact path: the file is read one character per byte and sent unchanged
    // (raw BLOB bytes in mysqldump output); names are converted for messages.
    const binary = typeof session.executeRaw === 'function'
    const toWire = (sql: string): string =>
      binary ? Buffer.from(sql, 'utf8').toString('latin1') : sql
    const toText = (sql: string): string =>
      binary ? Buffer.from(sql, 'latin1').toString('utf8') : sql
    const run = (sql: string): Promise<{ affectedRows: number }> =>
      binary ? session.executeRaw!(sql) : session.execute(sql)

    let current: string | null = target
    if (current) {
      result.databases.push(current)
      emit('database', `Base de datos ${current}`, { objectType: 'Database', objectName: current })
    }
    const dumpDatabases = new Set<string>()
    let multiWarned = false
    const definers = new DefinerAccounts(session)
    const strippedDefiners = new Set<string>()
    let lastProgress = 0
    let lastLine = 0
    let stop = false

    const setCurrent = (name: string): void => {
      if (current === name) return
      current = name
      if (!result.databases.includes(name)) result.databases.push(name)
      emit('database', `Base de datos ${name}`, { objectType: 'Database', objectName: name })
    }

    const noteDumpDatabase = (name: string): void => {
      dumpDatabases.add(name)
      if (intoSchema && !multiWarned && dumpDatabases.size > 1) {
        multiWarned = true
        emit(
          'warning',
          `El archivo contiene varias bases de datos (${[...dumpDatabases].join(', ')}): todo se importa en ${target}. Los nombres calificados con otra base de datos no se cambian.`
        )
      }
    }

    /** Runs a CREATE that names a DEFINER: dropped when the account is missing, retried without on failure. */
    const runDefinerDdl = async (sql: string): Promise<{ affectedRows: number }> => {
      const found = definerOf(sql)
      if (!found) return run(sql)
      const definer = { user: toText(found.user), host: toText(found.host) }
      const account = `${definer.user}@${definer.host}`
      const noteStripped = (): void => {
        if (strippedDefiners.has(account)) return
        strippedDefiners.add(account)
        emit(
          'warning',
          `El DEFINER ${account} no existe o no se puede usar en el destino: los objetos se crean con el usuario de la conexión.`
        )
      }
      if ((await definers.exists(definer.user, definer.host)) === false) {
        const res = await run(stripDefiner(sql))
        noteStripped()
        return res
      }
      try {
        return await run(sql)
      } catch (err) {
        const stripped = stripDefiner(sql)
        if (stripped === sql) throw err
        const res = await run(stripped)
        noteStripped()
        return res
      }
    }

    // mysqldump creates a placeholder (a table in 5.7, a dummy view in 8.x) before each
    // view: count every object once, and a view replacing a placeholder table as a view.
    const createdNames = new Map<string, DumpObjectKind>()
    const countCreated = (object: DumpObjectKind, name: string): void => {
      const key = `${object === 'Table' || object === 'View' ? 'relation' : object}:${current ?? ''}:${name}`
      const before = createdNames.get(key)
      if (before === object) return
      if (before) result.created[COUNT_KEY[before]]--
      createdNames.set(key, object)
      result.created[COUNT_KEY[object]]++
    }

    const runOne = async (statement: SqlStatement): Promise<void> => {
      result.statements++
      lastLine = statement.startLine
      let sql = statement.sql
      const classified = classifyStatement(sql)
      const stmt: StatementInfo =
        'name' in classified ? { ...classified, name: toText(classified.name) } : classified
      if (stmt.kind === 'create' && stmt.object === 'Database') noteDumpDatabase(stmt.name)
      if (stmt.kind === 'use') noteDumpDatabase(stmt.name)
      if (intoSchema) {
        if (stmt.kind === 'create' && stmt.object === 'Database') {
          result.skipped++
          return
        }
        if (stmt.kind === 'use') sql = toWire(`USE ${session.escapeId(target!)}`)
        else if (stmt.kind === 'alterDatabase')
          sql = redirectAlterDatabase(sql, toWire(session.escapeId(target!)))
      }
      try {
        let res: { affectedRows: number }
        try {
          res =
            stmt.kind === 'create' && stmt.object !== 'Table' && stmt.object !== 'Database'
              ? await runDefinerDdl(sql)
              : await run(sql)
        } catch (err) {
          const retry = errnoOf(err) === 1231 ? withoutNoAutoCreateUser(sql) : null
          if (!retry) throw err
          res = await run(retry)
        }
        result.executed++
        if (stmt.kind === 'write') result.rowsAffected += res.affectedRows
        if (stmt.kind === 'use') setCurrent(intoSchema ? target! : stmt.name)
        if (stmt.kind === 'create') {
          countCreated(stmt.object, stmt.name)
          emit('object', CREATED_MESSAGE[stmt.object](stmt.name), {
            objectType: stmt.object,
            objectName: stmt.name
          })
        }
      } catch (err) {
        if (cancelled()) throw new Error(SQL_IMPORT_CANCELLED)
        const message = describeRestoreError(err)
        const head = toText(statement.sql.slice(0, 2000))
        const error: SqlDumpError = {
          line: statement.startLine,
          statement: excerpt(head, ERROR_STATEMENT_CHARS),
          message
        }
        result.errors.push(error)
        emit('objectError', `Error en la línea ${statement.startLine}`, {
          error: message,
          objectName: excerpt(head, EVENT_STATEMENT_CHARS)
        })
        if (!options.continueOnError) stop = true
      }
      const now = Date.now()
      if (now - lastProgress >= PROGRESS_EVERY_MS) {
        lastProgress = now
        emit('statement', `Línea ${lastLine} · ${result.statements} sentencias`, {
          objectsDone: result.executed,
          rows: result.rowsAffected
        })
      }
    }

    const splitter = new MysqlStatementStream(binary ? { trim: trimAscii } : {})
    const chunks = readDumpChunks(info, signal, binary ? 'binary' : 'utf8')
    try {
      for await (const chunk of chunks) {
        if (cancelled()) throw new Error(SQL_IMPORT_CANCELLED)
        bytes = chunk.bytesRead
        for (const statement of splitter.push(chunk.text)) {
          if (cancelled()) throw new Error(SQL_IMPORT_CANCELLED)
          await runOne(statement)
          if (stop) break
        }
        if (stop) break
      }
      if (cancelled()) throw new Error(SQL_IMPORT_CANCELLED)
      if (!stop) {
        for (const statement of splitter.end()) {
          if (cancelled()) throw new Error(SQL_IMPORT_CANCELLED)
          await runOne(statement)
          if (stop) break
        }
        bytes = total
      }
    } finally {
      await chunks.return(undefined)
    }
    emit('statement', `Línea ${lastLine} · ${result.statements} sentencias`, {
      objectsDone: result.executed,
      rows: result.rowsAffected
    })
    emit('finish', 'Importación terminada')
  } finally {
    if (sessionPrepared) await resetSession(session, sqlMode)
    await session.release().catch(() => undefined)
  }
  result.bytesRead = bytes
  result.durationMs = Math.round(performance.now() - started)
  return result
}
