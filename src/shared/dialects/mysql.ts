/**
 * MySQL dialect (docs/multi-engine-design.md, section 6). Every function below
 * was moved verbatim from v0.1.0 and is still re-exported from its old path:
 *
 * - splitStatements          <- src/main/mysql/sqlSplit.ts
 * - leadingKeyword,
 *   isObviousWrite           <- src/shared/productionGuard.ts
 * - quoteIdent, quoteString,
 *   qualified, analyzeDestructive,
 *   splitOnSemicolons        <- src/renderer/src/utils/sql.ts (there named splitStatements)
 * - analyzeWrites            <- src/renderer/src/components/query/writeGuard.ts
 *
 * Each function keeps its own tokeniser on purpose: they differ in edge cases
 * (the CLI splitter handles DELIMITER, `normalize` unwraps `/*!`,
 * `leadingKeyword` treats `/*!` as code). Do not merge them or "fix" them here:
 * golden/mysql.json pins their v0.1.0 outputs.
 */
import type { LexRules, SqlDialect, SqlStatement, WriteCheck } from './types'

export type { SqlStatement, WriteCheck } from './types'

// ---------------------------------------------------------------------------
// Script splitter (main: query execution and the production guard)
// ---------------------------------------------------------------------------

/**
 * Client-side SQL script splitter that mimics the mysql CLI: statements are
 * separated by the current delimiter (default ";"), which can be changed with
 * a `DELIMITER xx` line. Quotes and comments are honoured so that delimiters
 * inside strings, identifiers or comments never split a statement.
 */

type State = 'code' | 'single' | 'double' | 'backtick' | 'lineComment' | 'blockComment'

const DELIMITER_RE = /^delimiter[ \t]+(\S+)[ \t]*(?:\r?\n|$)/i

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\v'
}

export function splitStatements(script: string): SqlStatement[] {
  const result: SqlStatement[] = []
  const src = script.replace(/\r\n/g, '\n')
  let delimiter = ';'
  let state: State = 'code'
  let buf = ''
  let hasCode = false
  let startLine = 0
  let line = 1
  let atLineStart = true
  let i = 0

  const flush = (): void => {
    const sql = buf.trim()
    if (hasCode && sql) result.push({ sql, startLine })
    buf = ''
    hasCode = false
    startLine = 0
  }

  const appendCode = (text: string): void => {
    if (!hasCode) {
      hasCode = true
      startLine = line
    }
    buf += text
  }

  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]

    if (state === 'code') {
      if (atLineStart && !isSpace(ch)) {
        const m = DELIMITER_RE.exec(src.slice(i, i + 200))
        if (m) {
          flush()
          delimiter = m[1]
          const consumed = m[0].length
          for (let k = 0; k < consumed; k++) if (src[i + k] === '\n') line++
          i += consumed
          atLineStart = true
          continue
        }
        atLineStart = false
      }

      if (src.startsWith(delimiter, i)) {
        flush()
        i += delimiter.length
        continue
      }

      if (ch === '\n') {
        line++
        atLineStart = true
        buf += ch
        i++
        continue
      }

      if (
        ch === '#' ||
        (ch === '-' && next === '-' && (i + 2 >= src.length || isSpace(src[i + 2])))
      ) {
        state = 'lineComment'
        buf += ch
        i++
        continue
      }
      if (ch === '/' && next === '*') {
        // `/*! ... */` (versioned) and `/*+ ... */` (optimizer hints) are executed
        // by the server, so they count as statement code, not as a comment.
        const third = src[i + 2]
        if (third === '!' || third === '+') appendCode('/*')
        else buf += '/*'
        state = 'blockComment'
        i += 2
        continue
      }
      if (ch === "'") state = 'single'
      else if (ch === '"') state = 'double'
      else if (ch === '`') state = 'backtick'

      if (isSpace(ch)) buf += ch
      else appendCode(ch)
      i++
      continue
    }

    if (state === 'lineComment') {
      if (ch === '\n') {
        state = 'code'
        line++
        atLineStart = true
      }
      buf += ch
      i++
      continue
    }

    if (state === 'blockComment') {
      if (ch === '*' && next === '/') {
        state = 'code'
        buf += '*/'
        i += 2
        continue
      }
      if (ch === '\n') line++
      buf += ch
      i++
      continue
    }

    // inside a quoted string / identifier
    if (ch === '\n') line++
    const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`'
    if (ch === '\\' && state !== 'backtick' && i + 1 < src.length) {
      buf += ch + next
      if (next === '\n') line++
      i += 2
      continue
    }
    if (ch === quote) state = 'code'
    buf += ch
    i++
  }

  flush()
  return result
}

// ---------------------------------------------------------------------------
// Main-side production guard (denylist)
// ---------------------------------------------------------------------------

/**
 * Leading keywords that always change data, structure or privileges. This is
 * deliberately a small denylist: the renderer asks for anything that is not
 * provably read-only, so main must never flag a statement the renderer would
 * let through without asking.
 */
const WRITE_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'DROP',
  'CREATE',
  'ALTER',
  'TRUNCATE',
  'RENAME',
  'GRANT',
  'REVOKE',
  'LOAD',
  'CALL',
  'IMPORT'
])

/** First keyword of a statement, skipping leading comments and whitespace. */
export function leadingKeyword(statement: string): string {
  let s = statement
  for (;;) {
    s = s.replace(/^\s+/, '')
    if (s.startsWith('/*') && !s.startsWith('/*!')) {
      const end = s.indexOf('*/', 2)
      s = end < 0 ? '' : s.slice(end + 2)
    } else if (s.startsWith('#') || /^--(\s|$)/.test(s)) {
      const end = s.indexOf('\n')
      s = end < 0 ? '' : s.slice(end + 1)
    } else break
  }
  const m = /^[A-Za-z]+/.exec(s)
  return m ? m[0].toUpperCase() : ''
}

/** True when the statement obviously writes (see WRITE_KEYWORDS). */
export function isObviousWrite(statement: string): boolean {
  return WRITE_KEYWORDS.has(leadingKeyword(statement))
}

// ---------------------------------------------------------------------------
// Quoting and destructive-statement heuristics (renderer)
// ---------------------------------------------------------------------------

export function quoteIdent(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`'
}

export function quoteString(value: string): string {
  return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
}

export function qualified(schema: string | null | undefined, name: string): string {
  return schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name)
}

/** Strip comments and string literals so keyword heuristics do not misfire. */
function stripLiterals(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
}

/**
 * Plain ';' splitter used by the renderer guard heuristics. It knows quotes but
 * not comments or DELIMITER; callers strip those first.
 */
export function splitOnSemicolons(sql: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (quote) {
      current += ch
      if (ch === '\\' && i + 1 < sql.length) {
        current += sql[++i]
      } else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      current += ch
      continue
    }
    if (ch === ';') {
      if (current.trim()) out.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) out.push(current.trim())
  return out
}

export interface DestructiveCheck {
  destructive: boolean
  /** Human readable reasons such as "DELETE sin WHERE". */
  reasons: string[]
}

/** Heuristic classification of a SQL script for the production guard. */
export function analyzeDestructive(sql: string): DestructiveCheck {
  const reasons: string[] = []
  for (const stmt of splitOnSemicolons(stripLiterals(sql))) {
    const upper = stmt.toUpperCase().replace(/\s+/g, ' ').trim()
    if (/^(DROP|TRUNCATE)\b/.test(upper)) reasons.push(upper.split(' ').slice(0, 2).join(' '))
    else if (/^ALTER\b/.test(upper)) reasons.push('ALTER')
    else if (/^DELETE\b/.test(upper) && !/\bWHERE\b/.test(upper)) reasons.push('DELETE sin WHERE')
    else if (/^UPDATE\b/.test(upper) && !/\bWHERE\b/.test(upper)) reasons.push('UPDATE sin WHERE')
    else if (
      /^(DELETE|UPDATE|INSERT|REPLACE|CREATE|RENAME|GRANT|REVOKE|SET PASSWORD)\b/.test(upper)
    ) {
      reasons.push(upper.split(' ')[0])
    }
  }
  return { destructive: reasons.length > 0, reasons: [...new Set(reasons)] }
}

// ---------------------------------------------------------------------------
// Renderer-side production guard (allowlist with reasons)
// ---------------------------------------------------------------------------

/**
 * Allowlist classification for the production guard: every statement that is
 * not provably read-only counts as a write. A denylist misses CALL, LOAD DATA,
 * CTE DML, parenthesised DML, SET GLOBAL, IMPORT TABLE, executable comments...
 */

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
  for (const stmt of splitOnSemicolons(normalize(sql))) {
    const reason = statementWrites(stmt)
    if (reason) reasons.add(reason)
  }
  return { writes: reasons.size > 0, reasons: [...reasons] }
}

// ---------------------------------------------------------------------------
// Dialect object
// ---------------------------------------------------------------------------

/** MySQL lexical rules; descriptive only, the functions above do not read them. */
export const MYSQL_LEX: Readonly<LexRules> = {
  identQuotes: ['`'],
  stringQuotes: ["'", '"'],
  backslashEscapes: true,
  hashComment: true,
  dashCommentNeedsSpace: true,
  nestedBlockComments: false,
  executableComments: ['/*!', '/*+'],
  dollarQuotes: false,
  delimiterCommand: true,
  blockBodies: 'none'
}

export const mysqlDialect: SqlDialect = {
  id: 'mysql',
  lex: MYSQL_LEX,
  splitStatements,
  quoteIdent,
  quoteString,
  qualified,
  isObviousWrite,
  analyzeWrites
}
