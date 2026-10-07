/**
 * Engine-neutral script execution (docs/multi-engine-design.md, section 5.5):
 * split with the dialect, run statement by statement on one session, and
 * normalise each outcome. The loop is v0.1.0's mysql/query.ts loop unchanged;
 * the engine supplies the statement runner and the result mapping.
 */
import { performance } from 'node:perf_hooks'
import type { SqlDialect } from '@shared/dialects/types'
import type { QueryExecuteOptions, QueryStatementResult } from '@shared/types'

export const MAX_ROWS_CAP = 100000
export const DEFAULT_ROW_LIMIT = 1000

export function resolveMaxRows(requested: number | undefined, fallback: number): number {
  const base =
    Number.isFinite(requested) && (requested as number) > 0 ? (requested as number) : fallback
  return Math.min(Math.max(Math.floor(base), 1), MAX_ROWS_CAP)
}

/** What one engine provides to run a script on one of its sessions. */
export interface ScriptTarget<Raw> {
  /** Selects the default database/schema before the first statement. */
  useSchema(schema: string): Promise<void>
  /** Runs one statement, keeping at most `maxRows` rows of each result set. */
  runStatement(sql: string, maxRows: number): Promise<Raw>
  /** Maps a raw statement result to the transport shape. */
  toResult(sql: string, raw: Raw, durationMs: number): QueryStatementResult
  /** The driver's describeForUser. */
  describeError(err: unknown): string
}

/**
 * Runs a script statement by statement on one dedicated session so that
 * USE / SET / transactions carry over. Stops at the first error unless
 * options.stopOnError === false.
 */
export async function executeScript<Raw>(
  target: ScriptTarget<Raw>,
  dialect: Pick<SqlDialect, 'splitStatements'>,
  script: string,
  options: QueryExecuteOptions = {},
  defaultMaxRows = DEFAULT_ROW_LIMIT
): Promise<QueryStatementResult[]> {
  const maxRows = resolveMaxRows(options.maxRows, defaultMaxRows)
  const stopOnError = options.stopOnError !== false
  // MySQL passes the database name; the object form (PostgreSQL) never reaches this loop.
  if (options.schema)
    await target.useSchema(
      typeof options.schema === 'string' ? options.schema : options.schema.schema
    )

  const results: QueryStatementResult[] = []
  for (const stmt of dialect.splitStatements(script)) {
    const started = performance.now()
    try {
      const raw = await target.runStatement(stmt.sql, maxRows)
      results.push(target.toResult(stmt.sql, raw, Math.round(performance.now() - started)))
    } catch (err) {
      results.push({
        sql: stmt.sql,
        durationMs: Math.round(performance.now() - started),
        affectedRows: null,
        insertId: null,
        changedRows: null,
        warnings: 0,
        resultSet: null,
        error: target.describeError(err)
      })
      if (stopOnError) break
    }
  }
  return results
}
