/**
 * MariaDB dialect (docs/multi-engine-design.md, sections 6 and 10, phase P5):
 * the MySQL dialect plus
 *
 * - `/*M! … *\/` executable comments, which only MariaDB runs: the splitter
 *   keeps a statement made of one as code, and both guards read their content
 *   like the content of `/*! … *\/`;
 * - sequences: `NEXTVAL(s)`, `SETVAL(s, …)` and `NEXT VALUE FOR s` change the
 *   sequence, so a SELECT that calls them is a write for both guards;
 * - `SET STATEMENT var=… FOR <statement>`: main's denylist reads the inner
 *   statement (the renderer already treats every SET STATEMENT as a write);
 * - `RETURNING` (INSERT/REPLACE/DELETE … RETURNING) is a write already.
 *
 * The MySQL functions in ./mysql are reused untouched (their outputs are
 * pinned by golden/mysql.json); the MariaDB rules wrap them.
 */
import {
  MYSQL_LEX,
  analyzeWrites as mysqlAnalyzeWrites,
  isObviousWrite as mysqlIsObviousWrite,
  normalize,
  qualified,
  quoteIdent,
  quoteString,
  splitOnSemicolons,
  splitStatements as mysqlSplitStatements
} from './mysql'
import type { LexRules, SqlDialect, SqlStatement, WriteCheck } from './types'

const MARIA_COMMENT = '/*M!'
/** Same length as `/*M!`, so offsets in the rewritten text match the original. */
const AS_MYSQL_COMMENT = '/*!M'

/**
 * Splits like the mariadb CLI: the MySQL splitter, with `/*M!` counted as
 * code. The MySQL splitter is run over a copy where `/*M!` reads `/*!M`
 * (same length) and each statement is cut from the original text at the
 * same offsets, so the statements keep exactly what the user wrote.
 */
export function splitStatements(script: string): SqlStatement[] {
  if (!script.includes(MARIA_COMMENT)) return mysqlSplitStatements(script)
  const original = script.replace(/\r\n/g, '\n')
  const rewritten = original.split(MARIA_COMMENT).join(AS_MYSQL_COMMENT)
  let cursor = 0
  return mysqlSplitStatements(rewritten).map((stmt) => {
    const at = rewritten.indexOf(stmt.sql, cursor)
    if (at < 0) return stmt
    cursor = at + stmt.sql.length
    return { sql: original.slice(at, cursor), startLine: stmt.startLine }
  })
}

/** `/*M!` read as `/*!` (for analysis only: never executed). */
function asMysqlComments(sql: string): string {
  return sql.split(MARIA_COMMENT).join('/*!')
}

// Also Oracle mode's pseudo-columns (`SET sql_mode='ORACLE'; SELECT s.nextval FROM dual`).
const SEQUENCE_WRITE = /\b(NEXTVAL|SETVAL)\s*\(|\bNEXT\s+VALUE\s+FOR\b|\.\s*(NEXTVAL|SETVAL)\b/i
const SEQUENCE_REASON = 'Secuencia (NEXTVAL/SETVAL)'

/** Statements of a script with comments dropped, literals emptied and executable comments unwrapped. */
function normalizedStatements(sql: string): string[] {
  return splitOnSemicolons(normalize(asMysqlComments(sql)))
}

/** Renderer: the MySQL allowlist (with `/*M!` unwrapped) plus the sequence functions. */
export function analyzeWrites(sql: string): WriteCheck {
  const base = mysqlAnalyzeWrites(asMysqlComments(sql))
  const reasons = new Set(base.reasons)
  if (normalizedStatements(sql).some((s) => SEQUENCE_WRITE.test(s))) reasons.add(SEQUENCE_REASON)
  return { writes: reasons.size > 0, reasons: [...reasons] }
}

const SET_STATEMENT = /^\s*SET\s+STATEMENT\b/i

/**
 * Leading words main also refuses on MariaDB (the renderer already asks for
 * them, since none is provably read-only): dynamic SQL, anonymous compound
 * blocks, server-wide settings and maintenance.
 */
const MARIADB_WRITE_LEADS =
  /^(EXECUTE|PREPARE|DO|FLUSH|BEGIN\s+NOT\s+ATOMIC|SET\s+(GLOBAL\b|@@GLOBAL\.|PASSWORD\b|ROLE\b|DEFAULT\s+ROLE\b))/i

/**
 * Inner statement of `SET STATEMENT a=1, b='x' FOR <statement>` (already
 * normalised: literals are empty, so the first top-level FOR is the keyword).
 */
function setStatementInner(normalized: string): string | null {
  if (!SET_STATEMENT.test(normalized)) return null
  const m = /\bFOR\b/i.exec(normalized)
  return m ? normalized.slice(m.index + 3) : null
}

/**
 * Main: the MySQL denylist, also applied to the statement with executable
 * comments unwrapped and to the inner statement of SET STATEMENT … FOR, plus
 * the sequence functions.
 */
export function isObviousWrite(statement: string): boolean {
  if (mysqlIsObviousWrite(statement)) return true
  for (const normalized of normalizedStatements(statement)) {
    const text = normalized.replace(/^[\s(]+/, '')
    if (mysqlIsObviousWrite(text)) return true
    if (SEQUENCE_WRITE.test(text) || MARIADB_WRITE_LEADS.test(text)) return true
    const inner = setStatementInner(text)
    if (inner !== null && isObviousWrite(inner)) return true
  }
  return false
}

export const MARIADB_LEX: Readonly<LexRules> = {
  ...MYSQL_LEX,
  executableComments: ['/*!', '/*M!', '/*+']
}

export const mariadbDialect: SqlDialect = {
  id: 'mariadb',
  lex: MARIADB_LEX,
  splitStatements,
  quoteIdent,
  quoteString,
  qualified,
  isObviousWrite,
  analyzeWrites
}
