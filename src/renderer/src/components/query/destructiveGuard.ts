import { normalize, splitStatements } from '@shared/dialects/mysql'
import type { ConfirmItem } from '@renderer/stores/ui'

/**
 * Detection of destructive statements for the «Confirmar antes de borrar o
 * eliminar en cualquier conexión» setting: DROP (any object), TRUNCATE,
 * DELETE, ALTER TABLE … DROP and UPDATE without WHERE. Unlike the production
 * allowlist (writeGuard), plain INSERT or UPDATE … WHERE do not count.
 *
 * The script is split like the mysql CLI (DELIMITER aware, quotes and comments
 * honoured); each statement is then classified on a copy without comments and
 * with literals blanked, so words inside strings or comments never trigger.
 */

export interface DestructiveStatement {
  /** Statement as written (leading comments removed), for the dialog. */
  sql: string
  /** Short tag such as "DROP TABLE", "TRUNCATE TABLE", "DELETE" or "ALTER TABLE … DROP". */
  reason: string
  /** DELETE / UPDATE without WHERE (nor LIMIT): every row of the table is affected. */
  allRows: boolean
}

export const ALL_ROWS_WARNING = 'sin WHERE: afecta a todas las filas'

/** Longest statement text shown in a confirmation row. */
const MAX_STATEMENT = 300

/** Drops the text nested in parentheses so subquery clauses do not count as top level. */
function topLevel(upper: string): string {
  let depth = 0
  let out = ''
  for (const ch of upper) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0) out += ch
  }
  return out
}

function withoutWhere(upper: string): boolean {
  const top = topLevel(upper)
  return !/\bWHERE\b/.test(top) && !/\bLIMIT\b/.test(top)
}

function classify(upper: string): Omit<DestructiveStatement, 'sql'> | null {
  if (/^DROP\b/.test(upper)) {
    const words = upper.split(' ')
    const extra = words[1] === 'TEMPORARY' || words[1] === 'UNDO' ? 3 : 2
    return { reason: words.slice(0, extra).join(' '), allRows: false }
  }
  if (/^TRUNCATE\b/.test(upper)) return { reason: 'TRUNCATE TABLE', allRows: false }
  if (/^DELETE\b/.test(upper)) {
    const allRows = withoutWhere(upper)
    return { reason: allRows ? 'DELETE sin WHERE' : 'DELETE', allRows }
  }
  if (/^UPDATE\b/.test(upper)) {
    return withoutWhere(upper) ? { reason: 'UPDATE sin WHERE', allRows: true } : null
  }
  if (/^WITH\b/.test(upper)) {
    // CTE + DML: classify from the main statement keyword onwards.
    const main = /\b(DELETE|UPDATE)\b(?<! FOR UPDATE)/.exec(topLevel(upper))
    if (main) return classify(topLevel(upper).slice(main.index))
    return null
  }
  if (/^ALTER (ONLINE |OFFLINE |IGNORE )*TABLE\b/.test(upper)) {
    const top = topLevel(upper)
    if (
      /\bDROP\b(?! DEFAULT\b)/.test(top) ||
      /\b(TRUNCATE|DISCARD) (PARTITION|TABLESPACE)\b/.test(top)
    )
      return { reason: 'ALTER TABLE … DROP', allRows: false }
  }
  return null
}

/** Removes comments that precede the first keyword of a statement. */
function stripLeadingComments(statement: string): string {
  let s = statement
  for (;;) {
    s = s.replace(/^\s+/, '')
    if (s.startsWith('/*') && !s.startsWith('/*!') && !s.startsWith('/*+')) {
      const end = s.indexOf('*/', 2)
      s = end < 0 ? '' : s.slice(end + 2)
    } else if (s.startsWith('#') || /^--(\s|$)/.test(s)) {
      const end = s.indexOf('\n')
      s = end < 0 ? '' : s.slice(end + 1)
    } else return s
  }
}

/** Destructive statements of `script`, in order. Empty when nothing needs confirming. */
export function analyzeDestructiveScript(script: string): DestructiveStatement[] {
  const out: DestructiveStatement[] = []
  for (const { sql } of splitStatements(script)) {
    const upper = normalize(sql)
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .replace(/;\s*$/, '')
      .trim()
      .replace(/^\(+\s*/, '')
    const found = classify(upper)
    if (found) out.push({ sql: stripLeadingComments(sql), ...found })
  }
  return out
}

export function truncateStatement(sql: string, max = MAX_STATEMENT): string {
  const flat = sql.trim()
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat
}

/** Rows for the confirmation dialog: tag, truncated statement and the "sin WHERE" warning. */
export function destructiveItems(statements: DestructiveStatement[]): ConfirmItem[] {
  return statements.map((s) => ({
    tag: s.allRows ? s.reason.split(' ')[0] : s.reason,
    text: truncateStatement(s.sql),
    warning: s.allRows ? ALL_ROWS_WARNING : undefined
  }))
}

/** "¿Ejecutar 1 sentencia destructiva?" / "¿Ejecutar 3 sentencias destructivas?" */
export function destructiveTitle(count: number): string {
  return count === 1
    ? '¿Ejecutar 1 sentencia destructiva?'
    : `¿Ejecutar ${count} sentencias destructivas?`
}
