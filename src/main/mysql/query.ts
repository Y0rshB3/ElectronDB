import { performance } from 'node:perf_hooks'
import type { QueryExecuteOptions, QueryStatementResult } from '@shared/types'
import { describeError } from './errors'
import type { FullSession, RawStatementResult } from './session'
import { splitStatements } from './sqlSplit'
import { normalizeRow, toQueryColumn } from './values'

export const MAX_ROWS_CAP = 100000
export const DEFAULT_ROW_LIMIT = 1000

export function resolveMaxRows(requested: number | undefined, fallback: number): number {
  const base =
    Number.isFinite(requested) && (requested as number) > 0 ? (requested as number) : fallback
  return Math.min(Math.max(Math.floor(base), 1), MAX_ROWS_CAP)
}

/** Maps a raw mysql2 statement result to the transport shape. */
export function toStatementResult(
  sql: string,
  raw: RawStatementResult,
  durationMs: number
): QueryStatementResult {
  const first = raw.resultSets[0] ?? null
  const header = raw.header
  return {
    sql,
    durationMs,
    affectedRows: header ? header.affectedRows : null,
    insertId: header && header.insertId ? Number(header.insertId) : null,
    changedRows: header && typeof header.changedRows === 'number' ? header.changedRows : null,
    warnings: header?.warningStatus ?? 0,
    resultSet: first
      ? {
          columns: first.fields.map(toQueryColumn),
          rows: first.rows.map(normalizeRow),
          truncated: first.truncated
        }
      : null,
    error: null
  }
}

/**
 * Runs a script statement by statement on one dedicated session so that
 * USE / SET / transactions carry over. Stops at the first error unless
 * options.stopOnError === false.
 */
export async function executeScript(
  session: FullSession,
  script: string,
  options: QueryExecuteOptions = {},
  defaultMaxRows = DEFAULT_ROW_LIMIT
): Promise<QueryStatementResult[]> {
  const maxRows = resolveMaxRows(options.maxRows, defaultMaxRows)
  const stopOnError = options.stopOnError !== false
  if (options.schema) await session.useSchema(options.schema)

  const results: QueryStatementResult[] = []
  for (const stmt of splitStatements(script)) {
    const started = performance.now()
    try {
      const raw = await session.runStatement(stmt.sql, maxRows)
      results.push(toStatementResult(stmt.sql, raw, Math.round(performance.now() - started)))
    } catch (err) {
      results.push({
        sql: stmt.sql,
        durationMs: Math.round(performance.now() - started),
        affectedRows: null,
        insertId: null,
        changedRows: null,
        warnings: 0,
        resultSet: null,
        error: describeError(err)
      })
      if (stopOnError) break
    }
  }
  return results
}
