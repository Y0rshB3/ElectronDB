import { rm } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'
import { quoteIdent } from '@shared/dialects/sqlite'
import { sqliteCodeTokens, tokenizeSqlite } from '@shared/dialects/sqliteLexer'
import type { ConnectionConfig, RestoreOptions, RestoreResult } from '@shared/types'
import { WorkerClient } from '../../sqlite/client'
import { NO_TAB } from '../../sqlite/connection'
import { createSqliteFile } from '../../sqlite/driver'
import { describeError } from '../../sqlite/errors'
import type { BatchStatement, QueryResult } from '../../sqlite/protocol'
import { getSqliteSpawner, type ProcessSpawner } from '../../sqlite/spawner'
import type { ProgressReporter } from '../index'
import { PRODUCTION_GUARD_MESSAGE, RESTORE_CANCELLED } from '../restore'
import { engineMismatchMessage } from './engine'
import type { VqbManifestObject, VqbObjectMeta } from './format'
import { VqbReader } from './reader'
import type { SqliteConnectionProvider } from './sqliteBackup'
import { sqliteParam } from './sqliteValues'
import type { VqbValue } from './values'

/**
 * Restores a SQLite .vqb (same engine only), either into a NEW file (created
 * here; deleted again when the restore fails) or into a database of an open
 * SQLite connection. Everything runs in ONE transaction with foreign_keys off
 * (restored afterwards): a failure rolls it back unless «Continuar en caso de
 * error» is on, which runs each object under a savepoint. Order: tables and
 * their rows, sqlite_sequence values, indexes, views, triggers.
 */

export interface SqliteRestoreDeps {
  connections: { get(id: string): ConnectionConfig | null }
  sqlite: SqliteConnectionProvider
  /** Spawner of the temporary worker that fills a new file (tests: in-process). */
  spawner?: () => ProcessSpawner
  /** Saves a connection for a restored file; returns its id. */
  createConnection?: (filePath: string) => string
}

export interface SqliteRestoreOptions extends RestoreOptions {
  /** REPLACE: drop every user object of the target database first (same transaction). */
  replaceAll?: boolean
}

/** What the restore needs from a handle (a connection session or a temporary worker). */
export interface SqliteRestoreTarget {
  query(sql: string, params?: unknown[]): Promise<QueryResult>
  batch(statements: BatchStatement[]): Promise<unknown>
}

export class SqliteRestoreRolledBackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SqliteRestoreRolledBackError'
  }
}

const MAX_PARAMS = 30000
const MAX_ROWS = 500
const MAX_BYTES = 4 * 1024 * 1024

interface Item {
  object: VqbManifestObject
  meta: VqbObjectMeta
  ddl: string
}

const CREATE_WORDS = new Set(['TEMP', 'TEMPORARY', 'UNIQUE', 'VIRTUAL'])

/**
 * The CREATE statement with its object name qualified by `schema` (an
 * existing qualifier is replaced), so it lands in that database: sqlite_schema
 * keeps the text without the schema it was created in.
 */
export function qualifyDdl(ddl: string, schema: string): string {
  const tokens = sqliteCodeTokens(tokenizeSqlite(ddl))
  const word = (i: number): string =>
    tokens[i]?.kind === 'word' ? tokens[i].value.toUpperCase() : ''
  let i = 0
  if (word(i) !== 'CREATE') return ddl
  i++
  while (CREATE_WORDS.has(word(i))) i++
  if (!['TABLE', 'INDEX', 'VIEW', 'TRIGGER'].includes(word(i))) return ddl
  i++
  if (word(i) === 'IF' && word(i + 1) === 'NOT' && word(i + 2) === 'EXISTS') i += 3
  const name = tokens[i]
  if (!name) return ddl
  const dot = tokens[i + 1]
  const qualified = dot && dot.kind === 'punct' && dot.value === '.' && tokens[i + 2]
  const start = name.start
  const end = qualified ? tokens[i + 2].end : name.end
  const objectName = qualified ? tokens[i + 2].value : name.value
  const plain = name.kind === 'string' && !qualified ? objectName.slice(1, -1) : objectName
  return `${ddl.slice(0, start)}${quoteIdent(schema, true)}.${quoteIdent(plain, true)}${ddl.slice(end)}`
}

function validate(options: SqliteRestoreOptions): void {
  if (!options || typeof options !== 'object')
    throw new Error('Opciones de restauración no válidas.')
  if (!options.backupPath) throw new Error('Selecciona el archivo de la copia a restaurar.')
  if (!options.newFilePath && !options.connectionId)
    throw new Error('Selecciona la conexión de destino o un archivo nuevo.')
  if (options.newFilePath && !isAbsolute(options.newFilePath))
    throw new Error('Elige dónde guardar el archivo restaurado.')
  if (!options.includeStructure && !options.includeData)
    throw new Error('Elige restaurar la estructura, los datos o ambos.')
  if (options.newFilePath && !options.includeStructure)
    throw new Error('Un archivo nuevo necesita la estructura: marca «Estructura».')
}

export async function restoreSqliteBackup(
  deps: SqliteRestoreDeps,
  options: SqliteRestoreOptions,
  progress: ProgressReporter = () => {},
  signal?: AbortSignal
): Promise<RestoreResult> {
  validate(options)
  const started = performance.now()
  if (signal?.aborted) throw new Error(RESTORE_CANCELLED)
  const reader = await VqbReader.open(options.backupPath, options.password)
  try {
    await reader.unlock(options.password)
    const manifest = await reader.manifest()
    if (manifest.engine.id !== 'sqlite')
      throw new Error(engineMismatchMessage(manifest.engine.id, 'sqlite'))
    const items: Item[] = []
    for (const object of manifest.objects) {
      const meta = await reader.objectMeta(object.id)
      items.push({ object, meta, ddl: await reader.ddl(meta) })
    }

    if (options.newFilePath) {
      const filePath = options.newFilePath
      const spawner = (deps.spawner ?? getSqliteSpawner)()
      await createSqliteFile(filePath, spawner)
      const client = new WorkerClient(spawner, () => undefined)
      let result: RestoreResult
      try {
        client.start()
        await client.call('open', {
          filePath,
          readOnly: false,
          foreignKeys: false,
          busyTimeoutMs: 5000,
          attached: [],
          initialStatements: [],
          queryOnly: false
        })
        result = await runRestore(
          {
            query: (sql, params = []) => client.call('query', sql, params),
            batch: (statements) => client.call('batch', statements)
          },
          reader,
          items,
          'main',
          { ...options, replaceAll: false, dropObjectsFirst: false },
          progress,
          signal,
          started
        )
      } catch (err) {
        await client.close()
        await rm(filePath, { force: true }).catch(() => undefined)
        throw err
      }
      await client.close()
      result.restoredFilePath = filePath
      if (options.createConnection && deps.createConnection)
        result.newConnectionId = deps.createConnection(filePath)
      return result
    }

    const config = deps.connections.get(options.connectionId)
    if (!config) throw new Error('La conexión de destino ya no existe.')
    if (config.environment === 'production' && options.confirmProduction !== true)
      throw new Error(PRODUCTION_GUARD_MESSAGE)
    const schema = options.targetSchema?.trim() || 'main'
    const connection = await deps.sqlite.connection(options.connectionId)
    return await connection.exclusive(async (session) => {
      connection.assertCanWrite(NO_TAB, 'Restaurar la copia')
      const lifted = await connection.liftGuard(true)
      try {
        return await runRestore(
          { query: (sql, params) => session.exec(sql, params), batch: (s) => session.batch(s) },
          reader,
          items,
          schema,
          options,
          progress,
          signal,
          started
        )
      } finally {
        await connection.restoreGuard(lifted)
      }
    })
  } finally {
    await reader.close()
  }
}

/** Every user object of `schema` (dropped by a REPLACE restore). */
async function dropAll(target: SqliteRestoreTarget, schema: string): Promise<void> {
  const q = quoteIdent(schema, true)
  const { rows } = await target.query(
    `SELECT type, name FROM ${q}.sqlite_schema
      WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`
  )
  const order = ['trigger', 'view', 'table']
  const list = rows
    .map((r) => ({ type: String(r.type), name: String(r.name) }))
    .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))
  // Shadow tables of a virtual table go with it: skip the ones already gone.
  for (const o of list) {
    const still = await target.query(
      `SELECT 1 FROM ${q}.sqlite_schema WHERE type = ? AND name = ?`,
      [o.type, o.name]
    )
    if (still.rows.length)
      await target.query(`DROP ${o.type.toUpperCase()} ${q}.${quoteIdent(o.name, true)}`)
  }
}

async function runRestore(
  target: SqliteRestoreTarget,
  reader: VqbReader,
  items: Item[],
  schema: string,
  options: SqliteRestoreOptions,
  progress: ProgressReporter,
  signal: AbortSignal | undefined,
  started: number
): Promise<RestoreResult> {
  const result: RestoreResult = { objectsRestored: 0, rowsInserted: 0, errors: [], durationMs: 0 }
  const cancelled = (): boolean => signal?.aborted === true
  const structure = options.includeStructure
  const q = quoteIdent(schema, true)
  const wanted = new Set((options.objects ?? []).filter(Boolean))
  const selected = items.filter((i) => wanted.size === 0 || wanted.has(i.object.name))
  if (wanted.size > 0 && selected.length === 0)
    throw new Error('Ninguno de los objetos seleccionados está en la copia.')
  const tables = selected.filter((i) => i.object.type === 'table')
  const views = selected.filter((i) => i.object.type === 'view')
  const total = selected.length
  let index = 0
  let fatal: { label: string; message: string } | null = null

  const attempt = async (fn: () => Promise<void>): Promise<unknown> => {
    await target.query('SAVEPOINT vqb_object')
    try {
      await fn()
      await target.query('RELEASE SAVEPOINT vqb_object')
      return null
    } catch (err) {
      await target.query('ROLLBACK TO SAVEPOINT vqb_object')
      await target.query('RELEASE SAVEPOINT vqb_object')
      return err
    }
  }
  const fail = (label: string, err: unknown): void => {
    const message = describeError(err)
    result.errors.push({ object: label, message })
    progress({
      phase: 'objectError',
      current: index,
      total,
      message: `Error al restaurar ${label}`,
      done: false,
      detail: { objectName: label, objectIndex: index + 1, objects: total, error: message }
    })
    if (!options.continueOnError) fatal ??= { label, message }
  }
  const done = (item: Item, rows: number | null): void => {
    result.objectsRestored++
    progress({
      phase: 'objectDone',
      current: index + 1,
      total,
      message: `${item.object.name} restaurado`,
      done: false,
      detail: {
        objectType: item.object.type === 'table' ? 'Table' : 'View',
        objectName: item.object.name,
        objectIndex: index + 1,
        objects: total,
        objectsDone: result.objectsRestored,
        rows
      }
    })
  }

  const insertRows = async (item: Item): Promise<number> => {
    const columns = item.meta.columns ?? []
    if (!columns.length || !item.meta.data?.length) return 0
    const head = `INSERT INTO ${q}.${quoteIdent(item.object.name, true)} (${columns
      .map((c) => quoteIdent(c.name, true))
      .join(', ')}) VALUES `
    const tuple = `(${columns.map(() => '?').join(', ')})`
    const perStatement = Math.max(1, Math.min(MAX_ROWS, Math.floor(MAX_PARAMS / columns.length)))
    let params: unknown[] = []
    let rows = 0
    let bytes = 0
    let inserted = 0
    const flush = async (): Promise<void> => {
      if (!rows) return
      await target.query(head + Array(rows).fill(tuple).join(', '), params)
      inserted += rows
      params = []
      rows = 0
      bytes = 0
    }
    await reader.rows(
      item.meta,
      async (row: VqbValue[]) => {
        for (const v of row) {
          params.push(sqliteParam(v))
          bytes += typeof v === 'string' ? v.length : 16
        }
        rows++
        if (rows >= perStatement || bytes >= MAX_BYTES) await flush()
      },
      signal
    )
    await flush()
    return inserted
  }

  const prevFk = Number(
    Object.values((await target.query('PRAGMA foreign_keys')).rows[0] ?? {})[0] ?? 0
  )
  await target.query('PRAGMA foreign_keys = OFF')
  try {
    await target.query('BEGIN IMMEDIATE')
    try {
      if (options.replaceAll) await dropAll(target, schema)
      for (const item of tables) {
        if (fatal) break
        if (cancelled()) throw new Error(RESTORE_CANCELLED)
        progress({
          phase: 'object',
          current: index,
          total,
          message: `Restaurando ${item.object.name}`,
          done: false,
          detail: {
            objectType: 'Table',
            objectName: item.object.name,
            objectIndex: index + 1,
            objects: total,
            rowsEstimate: options.includeData ? item.object.rows : null
          }
        })
        let rows = 0
        const err = await attempt(async () => {
          if (structure) {
            if (options.dropObjectsFirst && !options.replaceAll)
              await target.query(`DROP TABLE IF EXISTS ${q}.${quoteIdent(item.object.name, true)}`)
            await target.query(qualifyDdl(item.ddl, schema))
          }
          if (options.includeData) rows = await insertRows(item)
          if (
            structure &&
            options.includeData &&
            !options.skipAutoIncrement &&
            item.meta.autoIncrement
          ) {
            await target.query(`DELETE FROM ${q}.sqlite_sequence WHERE name = ?`, [
              item.object.name
            ])
            await target.query(`INSERT INTO ${q}.sqlite_sequence (name, seq) VALUES (?, ?)`, [
              item.object.name,
              { $int: item.meta.autoIncrement }
            ])
          }
        })
        if (err) {
          if (cancelled()) throw new Error(RESTORE_CANCELLED)
          fail(item.object.name, err)
        } else {
          result.rowsInserted += rows
          done(item, options.includeData ? rows : null)
        }
        index++
      }
      if (structure && !fatal) {
        const failed = new Set(result.errors.map((e) => e.object))
        const post = async (label: string, statements: string[]): Promise<void> => {
          if (fatal || !statements.length) return
          const err = await attempt(async () => {
            for (const sql of statements) await target.query(qualifyDdl(sql, schema))
          })
          if (err) fail(label, err)
        }
        for (const t of tables.filter((t) => !failed.has(t.object.name)))
          await post(t.object.name, t.meta.indexes ?? [])
        for (const v of views) {
          if (fatal) break
          if (cancelled()) throw new Error(RESTORE_CANCELLED)
          const err = await attempt(async () => {
            if (options.dropObjectsFirst && !options.replaceAll)
              await target.query(`DROP VIEW IF EXISTS ${q}.${quoteIdent(v.object.name, true)}`)
            await target.query(qualifyDdl(v.ddl, schema))
          })
          if (err) fail(v.object.name, err)
          else done(v, null)
          index++
        }
        for (const item of [...tables, ...views].filter((i) => !failed.has(i.object.name)))
          await post(item.object.name, item.meta.triggers ?? [])
      }
      if (cancelled()) throw new Error(RESTORE_CANCELLED)
      if (fatal) {
        await target.query('ROLLBACK').catch(() => undefined)
        const f = fatal as { label: string; message: string }
        throw new SqliteRestoreRolledBackError(
          `No se pudo restaurar ${f.label}: ${f.message}. No se ha restaurado nada: la restauración es una sola transacción y se ha deshecho.`
        )
      }
      await target.query('COMMIT')
    } catch (err) {
      await target.query('ROLLBACK').catch(() => undefined)
      throw err
    }
  } finally {
    await target.query(`PRAGMA foreign_keys = ${prevFk ? 'ON' : 'OFF'}`).catch(() => undefined)
  }
  progress({
    phase: 'finish',
    current: total,
    total,
    message: 'Restauración terminada',
    done: false
  })
  result.durationMs = Math.round(performance.now() - started)
  return result
}

/** Default name of a connection created for a restored file. */
export function restoredConnectionName(filePath: string): string {
  return basename(filePath).replace(/\.(db|sqlite3?|db3)$/i, '') || 'SQLite restaurada'
}
