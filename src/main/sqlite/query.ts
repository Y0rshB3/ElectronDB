/**
 * SQLite script execution (docs/multi-engine-design.md, sections 5.3.1, 5.4
 * and 5.5): split with the SQLite dialect (prepare() would silently drop
 * everything after the first statement), run one statement at a time on the
 * connection's single handle with a row cap, and describe each result column
 * from StatementSync.columns() so single-table results can be edited by rowid
 * (or by primary key on WITHOUT ROWID tables).
 */
import { performance } from 'node:perf_hooks'
import {
  analyzeWrites,
  leadingKeyword,
  sqliteDialect,
  transactionControl
} from '@shared/dialects/sqlite'
import { sqliteTypeKind } from '@shared/sqlite/affinity'
import type { QueryColumn, QueryExecuteOptions, QueryStatementResult } from '@shared/types'
import { DEFAULT_ROW_LIMIT, resolveMaxRows } from '../db/query'
import { CancelledError } from './client'
import { NO_TAB, type SqliteDriverConnection, type SqliteSession } from './connection'
import { OTHER_TAB_TRANSACTION, SqliteUserError, describeError } from './errors'
import { tableMeta, type SqliteQueryable, type TableMeta } from './introspect'
import type { RunResult, WorkerColumn } from './protocol'

const DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE'])

export const KEYLESS_TRANSACTION_NOTE =
  'La transacción abierta por esta ejecución se ha deshecho: abre las transacciones desde una pestaña de consulta.'

export const NEEDS_ROWID = 'añade rowid a la consulta (SELECT rowid, …) para poder editar sus filas'

/** Per script: table facts by `db.table`. */
export type MetaCache = Map<string, Promise<TableMeta | null>>

const ROWID_NAMES = new Set(['rowid', '_rowid_', 'oid'])

/**
 * Transport columns of a result: declared type, typeKind and the source table
 * (views report their base table; the renderer also checks the FROM target).
 * The row's identity column is marked `primaryKey`; the rowid of a table
 * without INTEGER PRIMARY KEY and generated columns are `locked` (key only).
 * A rowid table whose rowid is not in the result cannot be edited, and says why.
 */
export async function describeColumns(
  session: SqliteQueryable,
  columns: WorkerColumn[],
  cache: MetaCache = new Map()
): Promise<QueryColumn[]> {
  const out: QueryColumn[] = columns.map((c) => ({
    name: c.name,
    type: c.type ?? '',
    typeKind: sqliteTypeKind(c.type),
    ...(c.table ? { table: c.table, schema: c.database ?? 'main' } : {}),
    ...(c.column ? { sourceName: c.column } : {})
  }))
  const tables = new Map<string, { db: string; table: string }>()
  for (const c of columns)
    if (c.table)
      tables.set(`${c.database ?? 'main'}.${c.table}`, { db: c.database ?? 'main', table: c.table })
  for (const [key, { db, table }] of tables) {
    let pending = cache.get(key)
    if (!pending) {
      pending = tableMeta(session, db, table).catch(() => null)
      cache.set(key, pending)
    }
    const meta = await pending
    const mine = out.filter((c) => c.table === table && (c.schema ?? 'main') === db)
    if (!meta) continue
    const { identity } = meta
    for (const c of mine)
      if (c.sourceName && meta.generated.has(c.sourceName)) c.locked = 'columna generada'
    if (identity.kind === 'none') {
      for (const c of mine) c.readOnlyReason = identity.reason
      continue
    }
    if (identity.kind === 'primaryKey') {
      const pk = new Set(identity.columns.map((n) => n.toLowerCase()))
      for (const c of mine)
        if (c.sourceName && pk.has(c.sourceName.toLowerCase())) c.primaryKey = true
      continue
    }
    // Rowid table: the key is the INTEGER PRIMARY KEY column, or the rowid itself.
    // SQLite reports the rowid pseudo-column as source 'rowid' (whatever alias was written).
    // When a real column is called rowid, the key is the alias the grid selected by name.
    const keys = mine.filter((c) => {
      const source = c.sourceName?.toLowerCase()
      if (identity.column !== null) return source === identity.column.toLowerCase()
      if (identity.alias === 'rowid') return source === 'rowid'
      return c.name.toLowerCase() === identity.alias && ROWID_NAMES.has(source ?? '')
    })
    if (!keys.length) {
      for (const c of mine) c.readOnlyReason = NEEDS_ROWID
      continue
    }
    for (const c of keys) {
      c.primaryKey = true
      if (identity.column === null) c.locked = 'rowid'
    }
  }
  return out
}

function errorResult(sql: string, started: number, message: string): QueryStatementResult {
  return {
    sql,
    durationMs: Math.round(performance.now() - started),
    affectedRows: null,
    insertId: null,
    changedRows: null,
    warnings: 0,
    resultSet: null,
    error: message
  }
}

async function toResult(
  session: SqliteSession,
  sql: string,
  raw: RunResult,
  started: number,
  cache: MetaCache
): Promise<QueryStatementResult> {
  const lead = leadingKeyword(sql)
  const hasRows = raw.rows !== null
  const dml = DML.has(lead) || (lead === 'WITH' && !hasRows)
  if (!hasRows || dml || lead.startsWith('CREATE') || lead === 'DROP' || lead === 'ALTER')
    cache.clear()
  return {
    sql,
    durationMs: Math.round(performance.now() - started),
    affectedRows: dml && !hasRows ? raw.changes : null,
    insertId:
      (lead === 'INSERT' || lead === 'REPLACE') &&
      !hasRows &&
      typeof raw.lastInsertRowid === 'number'
        ? raw.lastInsertRowid
        : null,
    changedRows: null,
    warnings: 0,
    resultSet: hasRows
      ? {
          columns: await describeColumns(session, raw.columns, cache).catch(() =>
            raw.columns.map((c) => ({ name: c.name, type: c.type ?? '' }))
          ),
          rows: raw.rows!,
          truncated: raw.truncated
        }
      : null,
    ...(hasRows && raw.storage ? { storage: raw.storage } : {}),
    error: null
  }
}

/**
 * Runs `script` for query tab `key` (NO_TAB without a tab) on the shared
 * handle, holding the connection lock for the whole script:
 * - another tab's open transaction refuses writes and transaction control
 *   before anything runs (reads still run and see its uncommitted changes);
 * - a confirmed write on a guarded connection lifts query_only for the script;
 * - a run without a tab never leaves a transaction open (it is rolled back);
 * - cancel kills the worker: the statement gets the cancel message and the
 *   rest of the script does not run.
 */
export async function executeSqliteScript(
  connection: SqliteDriverConnection,
  script: string,
  options: QueryExecuteOptions = {},
  defaultMaxRows = DEFAULT_ROW_LIMIT
): Promise<QueryStatementResult[]> {
  const key = options.sessionKey ?? NO_TAB
  const executionId = options.executionId
  const maxRows = resolveMaxRows(options.maxRows, defaultMaxRows)
  const stopOnError = options.stopOnError !== false
  const statements = sqliteDialect.splitStatements(script)
  if (key !== NO_TAB) connection.touchTab(key)
  try {
    return await connection.exclusive(async (session) => {
      const owner = connection.transactionOwner
      if (owner !== null && owner !== key) {
        const blocked = statements.some(
          (s) => analyzeWrites(s.sql).writes || transactionControl(s.sql) !== null
        )
        if (blocked) throw new SqliteUserError(OTHER_TAB_TRANSACTION, 'E_SQLITE_TX_OTHER_TAB')
      }
      const lifted = await connection.liftGuard(options.confirmProduction === true)
      const results: QueryStatementResult[] = []
      const cache: MetaCache = new Map()
      let cancelled = false
      try {
        for (const stmt of statements) {
          if (connection.isCancelled(executionId)) {
            cancelled = true
            break
          }
          const started = performance.now()
          let result: QueryStatementResult
          try {
            const raw = await connection.runStatement(stmt.sql, maxRows, key, executionId)
            result = await toResult(session, stmt.sql, raw, started, cache)
          } catch (err) {
            if (err instanceof CancelledError) {
              cancelled = true
              results.push(errorResult(stmt.sql, started, err.message))
              break
            }
            result = errorResult(stmt.sql, started, describeError(err))
          }
          result.transactionStatus = connection.transactionOwner === key ? 'in' : 'idle'
          results.push(result)
          if (result.error && stopOnError) break
        }
      } finally {
        if (!cancelled && !connection.isCancelled(executionId)) {
          if (key === NO_TAB && owner === null && connection.transactionOwner === NO_TAB) {
            await session.exec('ROLLBACK').catch(() => undefined)
            const last = results[results.length - 1]
            if (last) {
              last.notices = [...(last.notices ?? []), KEYLESS_TRANSACTION_NOTE]
              last.transactionStatus = 'idle'
            }
          }
          await connection.restoreGuard(lifted)
        }
      }
      return results
    })
  } finally {
    connection.forgetExecution(executionId)
  }
}
