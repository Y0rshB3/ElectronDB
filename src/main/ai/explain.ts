import { splitStatements } from '@shared/sqlSplit'
import type { Queryable } from './metadata'

/**
 * EXPLAIN for «Explicar / optimizar». Only ever issued for a script that is
 * exactly one SELECT statement, on user action. The plan is metadata (access
 * types, keys, row estimates), never row values.
 */

/** Strips leading comments, whitespace and opening parentheses. */
function leadingKeyword(sql: string): string {
  let s = sql
  for (;;) {
    const before = s
    s = s.replace(/^\s+/, '')
    s = s.replace(/^--[^\n]*(\n|$)/, '')
    s = s.replace(/^#[^\n]*(\n|$)/, '')
    s = s.replace(/^\/\*[\s\S]*?\*\//, '')
    s = s.replace(/^\(/, '')
    if (s === before) break
  }
  return (/^[A-Za-z]+/.exec(s)?.[0] ?? '').toUpperCase()
}

/** The script is one SELECT statement (EXPLAIN may run on it). */
export function isSingleSelect(sql: string | null | undefined): boolean {
  if (!sql?.trim()) return false
  const statements = splitStatements(sql)
  return statements.length === 1 && leadingKeyword(statements[0].sql) === 'SELECT'
}

const PLAN_COLUMNS = [
  'id',
  'select_type',
  'table',
  'partitions',
  'type',
  'possible_keys',
  'key',
  'key_len',
  'ref',
  'rows',
  'filtered',
  'Extra'
]

/** Compact text table of an EXPLAIN result. */
export function formatPlan(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '(sin plan)'
  const cols = PLAN_COLUMNS.filter((c) => rows.some((r) => r[c] !== undefined && r[c] !== null))
  const lines = [cols.join(' | ')]
  for (const r of rows.slice(0, 50))
    lines.push(
      cols.map((c) => (r[c] === null || r[c] === undefined ? '' : String(r[c]))).join(' | ')
    )
  if (rows.length > 50) lines.push(`… ${rows.length - 50} filas más del plan`)
  return lines.join('\n')
}

/** Runs EXPLAIN on a single SELECT; null when the SQL is not one SELECT or EXPLAIN fails. */
export async function explainSelect(q: Queryable, sql: string): Promise<string | null> {
  if (!isSingleSelect(sql)) return null
  const statement = splitStatements(sql)[0].sql
  try {
    return formatPlan(await q.query<Record<string, unknown>>(`EXPLAIN ${statement}`))
  } catch {
    return null
  }
}
