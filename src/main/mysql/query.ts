import { mysqlDialect } from '@shared/dialects/mysql'
import type { QueryExecuteOptions, QueryStatementResult } from '@shared/types'
import { DEFAULT_ROW_LIMIT, executeScript as runScript } from '../db/query'
import { describeError } from './errors'
import type { FullSession, RawStatementResult } from './session'
import { normalizeRow, toQueryColumn } from './values'

// The row limits and the script loop are engine-neutral (src/main/db/query.ts).
export { DEFAULT_ROW_LIMIT, MAX_ROWS_CAP, resolveMaxRows } from '../db/query'

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
 * options.stopOnError === false. The loop lives in src/main/db/query.ts; MySQL
 * supplies its CLI splitter (the dialect's), mysql2 runner and result mapping.
 */
export function executeScript(
  session: FullSession,
  script: string,
  options: QueryExecuteOptions = {},
  defaultMaxRows = DEFAULT_ROW_LIMIT
): Promise<QueryStatementResult[]> {
  return runScript(
    {
      useSchema: (schema) => session.useSchema(schema),
      runStatement: (sql, maxRows) => session.runStatement(sql, maxRows),
      toResult: toStatementResult,
      describeError
    },
    mysqlDialect,
    script,
    options,
    defaultMaxRows
  )
}
