import { analyzeDestructive, splitStatements } from '@renderer/utils/sql'

/**
 * Allowlist classification for the production guard: every statement that is
 * not provably read-only counts as a write. A denylist misses CALL, LOAD DATA,
 * CTE DML, parenthesised DML, SET GLOBAL, IMPORT TABLE, executable comments...
 */

export interface WriteCheck {
  writes: boolean
  /** Short labels such as "DELETE sin WHERE" or "CALL" for the confirmation message. */
  reasons: string[]
}

/**
 * Single pass over the script: comments are dropped, literals become empty
 * placeholders, and executable comments (`/*! ... *\/`) are unwrapped because
 * MySQL runs their content.
 */
export function normalize(sql: string): string {
  let out = ''
  let inExecutable = false
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const two = sql.slice(i, i + 2)
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === '\\' && ch !== '`') j += 2
        else if (sql[j] === ch && sql[j + 1] === ch) j += 2
        else if (sql[j] === ch) break
        else j++
      }
      out += ch + ch
      i = j + 1
    } else if (two === '/*' && sql[i + 2] === '!') {
      i += 3
      while (/\d/.test(sql[i] ?? '')) i++
      inExecutable = true
      out += ' '
    } else if (two === '*/' && inExecutable) {
      inExecutable = false
      i += 2
      out += ' '
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2)
      i = end < 0 ? sql.length : end + 2
      out += ' '
    } else if (ch === '#' || (two === '--' && /\s/.test(sql[i + 2] ?? ' '))) {
      const end = sql.indexOf('\n', i)
      i = end < 0 ? sql.length : end
    } else {
      out += ch
      i++
    }
  }
  // A DELIMITER line ends the previous statement; never let it swallow the next one.
  return out.replace(/^\s*DELIMITER\s+\S+\s*$/gim, ';')
}

const READ_ONLY = /^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|USE|HELP|TABLE|VALUES)\b/
const DML_WORD =
  /\b(INSERT(?!\s*\()|UPDATE|DELETE|REPLACE(?!\s*\()|INTO\s+(OUTFILE|DUMPFILE)|FOR\s+UPDATE|FOR\s+SHARE|LOCK\s+IN\s+SHARE\s+MODE)\b/

function statementWrites(stmt: string): string | null {
  // Strip leading parentheses: "(SELECT ...)" is read-only, "(DELETE ...)" is not.
  const upper = stmt
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\(+\s*/, '')
  if (!upper) return null
  // Session-only state: user variables, SET NAMES, SET SESSION.
  if (/^SET (@[^@]|@@SESSION\.|SESSION\b|NAMES\b|CHARACTER SET\b|CHARSET\b)/.test(upper))
    return null
  if (/^WITH\b/.test(upper)) return DML_WORD.test(upper) ? 'WITH + DML' : null
  if (READ_ONLY.test(upper)) {
    // SELECT ... INTO OUTFILE writes files; FOR UPDATE takes locks; EXPLAIN ANALYZE runs the statement.
    if (/^EXPLAIN ANALYZE\b/.test(upper) && DML_WORD.test(upper)) return 'EXPLAIN ANALYZE'
    if (/^(SELECT|TABLE|VALUES)\b/.test(upper) && DML_WORD.test(upper)) return 'SELECT con efectos'
    return null
  }
  return upper
    .split(' ')
    .slice(0, /^(SET|LOAD|IMPORT|LOCK)\b/.test(upper) ? 2 : 1)
    .join(' ')
}

export function analyzeWrites(sql: string): WriteCheck {
  const reasons = new Set(analyzeDestructive(sql).reasons)
  for (const stmt of splitStatements(normalize(sql))) {
    const reason = statementWrites(stmt)
    if (reason) reasons.add(reason)
  }
  return { writes: reasons.size > 0, reasons: [...reasons] }
}
