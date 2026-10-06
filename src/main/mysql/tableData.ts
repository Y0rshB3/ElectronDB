import { performance } from 'node:perf_hooks'
import type { TableDataPage, TableDataRequest } from '@shared/types'
import { MysqlUserError } from './errors'
import { escapeId, primaryKeyColumns } from './introspect'
import { MAX_ROWS_CAP } from './query'
import type { FullSession } from './session'
import { normalizeRow, toQueryColumn } from './values'

/** Milliseconds the COUNT(*) may run before we give up and report total = null. */
export const COUNT_TIMEOUT_MS = 3000

export interface BuiltQuery {
  sql: string
  params: unknown[]
}

function validate(req: TableDataRequest): void {
  if (!req.schema || !req.table) throw new MysqlUserError('Falta el esquema o la tabla')
  if (!Number.isInteger(req.limit) || req.limit < 1 || req.limit > MAX_ROWS_CAP) {
    throw new MysqlUserError(`El límite de filas debe estar entre 1 y ${MAX_ROWS_CAP}`)
  }
  if (!Number.isInteger(req.offset) || req.offset < 0)
    throw new MysqlUserError('El desplazamiento debe ser 0 o mayor')
  if (req.orderBy && req.orderBy.direction !== 'ASC' && req.orderBy.direction !== 'DESC') {
    throw new MysqlUserError('La dirección de ordenación debe ser ASC o DESC')
  }
}

function fromClause(req: TableDataRequest): string {
  let sql = `FROM ${escapeId(req.schema)}.${escapeId(req.table)}`
  const where = req.where?.trim()
  // Own lines + parentheses: a trailing "-- note" / "#" comment in the filter
  // cannot swallow the LIMIT, and OR inside it cannot escape the clause.
  if (where) sql += ` WHERE (\n${where}\n)`
  return sql
}

export function buildSelectSql(req: TableDataRequest): BuiltQuery {
  validate(req)
  let sql = `SELECT * ${fromClause(req)}`
  if (req.orderBy) sql += ` ORDER BY ${escapeId(req.orderBy.column)} ${req.orderBy.direction}`
  sql += ' LIMIT ? OFFSET ?'
  return { sql, params: [req.limit, req.offset] }
}

export function buildCountSql(req: TableDataRequest): string {
  validate(req)
  return `SELECT /*+ MAX_EXECUTION_TIME(${COUNT_TIMEOUT_MS}) */ COUNT(*) AS total ${fromClause(req)}`
}

/** Loads one page of a table plus its primary key and (best effort) total row count. */
export async function fetchTableData(
  session: FullSession,
  req: TableDataRequest
): Promise<TableDataPage> {
  const select = buildSelectSql(req)
  const countSql = buildCountSql(req)
  const started = performance.now()

  const primaryKey = await primaryKeyColumns(session, req.schema, req.table)
  const raw = await session.runStatement(select.sql, req.limit, select.params)
  const first = raw.resultSets[0]
  const columns = first ? first.fields.map(toQueryColumn) : []
  const rows = first ? first.rows.map(normalizeRow) : []

  let total: number | null = null
  try {
    const [row] = await session.query<{ total: unknown }>(countSql)
    const n = Number(row?.total)
    total = Number.isFinite(n) ? n : null
  } catch {
    // timeout (ER_QUERY_TIMEOUT) or an engine that cannot count cheaply: leave null
    total = null
  }

  return { columns, rows, primaryKey, total, durationMs: Math.round(performance.now() - started) }
}
