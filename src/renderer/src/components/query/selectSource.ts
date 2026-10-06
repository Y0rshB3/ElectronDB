/**
 * Reads the FROM clause of a SELECT statement to tell whether it reads exactly
 * one table reference, with no derived table, CTE, join or subquery column.
 *
 * Result metadata alone cannot be trusted for in-place editing: once MySQL
 * merges a derived table, a CTE or a view it reports the inner table and
 * column names (orgTable/orgName), which may name a different table, swap
 * columns or hide a self-join. Editing is only offered when the statement text
 * itself is a plain single-table SELECT; anything this parser does not
 * understand is treated as read-only.
 */

export interface TableRef {
  /** Schema written in the statement (`schema.table`), or null for the default one. */
  schema: string | null
  table: string
  /** Alias given in the statement, or null. */
  alias: string | null
}

export type SelectSource = { ok: true; ref: TableRef } | { ok: false; reason: string }

type Token =
  | { kind: 'word'; text: string }
  | { kind: 'quoted'; text: string }
  | { kind: 'string' }
  | { kind: 'punct'; text: string }

export const REASON_NOT_SIMPLE = 'la consulta no es un SELECT simple'
export const REASON_UNPARSED = 'no se pudo analizar la consulta'
export const REASON_CTE = 'la consulta usa WITH (CTE)'
export const REASON_SUBQUERY = 'la consulta usa subconsultas'
export const REASON_DERIVED = 'la consulta lee de una subconsulta'
export const REASON_MULTI = 'la consulta usa varias tablas'
export const REASON_GROUPED = 'la consulta agrupa filas'
export const REASON_UNION = 'la consulta combina varios resultados'
export const REASON_NO_TABLE = 'el resultado no proviene directamente de una tabla'

const WORD = /[\p{L}\p{N}_$@]/u

/**
 * Splits a statement into tokens, dropping comments. Returns null for
 * executable comments (`/*! ... *\/`), whose content MySQL runs and which
 * could hide a join, and for unterminated literals.
 */
function tokenize(sql: string): Token[] | null {
  const out: Token[] = []
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const two = sql.slice(i, i + 2)
    if (/\s/.test(ch)) {
      i++
    } else if (two === '/*') {
      if (sql[i + 2] === '!') return null
      const end = sql.indexOf('*/', i + 2)
      if (end < 0) return null
      i = end + 2
    } else if (ch === '#' || (two === '--' && /\s/.test(sql[i + 2] ?? ' '))) {
      const end = sql.indexOf('\n', i)
      i = end < 0 ? sql.length : end + 1
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      let text = ''
      for (;;) {
        if (j >= sql.length) return null
        if (sql[j] === '\\' && ch !== '`') {
          text += sql.slice(j, j + 2)
          j += 2
        } else if (sql[j] === ch && sql[j + 1] === ch) {
          text += ch
          j += 2
        } else if (sql[j] === ch) break
        else text += sql[j++]
      }
      out.push(ch === '`' ? { kind: 'quoted', text } : { kind: 'string' })
      i = j + 1
    } else if (WORD.test(ch)) {
      let j = i + 1
      while (j < sql.length && WORD.test(sql[j])) j++
      out.push({ kind: 'word', text: sql.slice(i, j) })
      i = j
    } else {
      out.push({ kind: 'punct', text: ch })
      i++
    }
  }
  return out
}

/** Words that end the table factor: never read as an alias. */
const CLAUSE_WORDS = new Set([
  'WHERE',
  'ORDER',
  'LIMIT',
  'GROUP',
  'HAVING',
  'WINDOW',
  'FOR',
  'LOCK',
  'INTO',
  'PROCEDURE',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'JOIN',
  'INNER',
  'CROSS',
  'LEFT',
  'RIGHT',
  'NATURAL',
  'STRAIGHT_JOIN',
  'FULL',
  'OUTER',
  'ON',
  'USING',
  'USE',
  'IGNORE',
  'FORCE',
  'PARTITION',
  'AS',
  'TABLESAMPLE'
])

const JOIN_WORDS = new Set([
  'JOIN',
  'INNER',
  'CROSS',
  'LEFT',
  'RIGHT',
  'NATURAL',
  'STRAIGHT_JOIN',
  'FULL',
  'OUTER'
])

/** Clauses allowed after the single table factor. */
const TAIL_WORDS = new Set(['WHERE', 'ORDER', 'LIMIT', 'WINDOW', 'FOR', 'LOCK'])

const fail = (reason: string): SelectSource => ({ ok: false, reason })

function upper(token: Token | undefined): string {
  return token?.kind === 'word' ? token.text.toUpperCase() : ''
}

function isPunct(token: Token | undefined, text: string): boolean {
  return token?.kind === 'punct' && token.text === text
}

/** Identifier at `token`: a backquoted name or a bare word that is not a clause keyword. */
function identifier(token: Token | undefined): string | null {
  if (token?.kind === 'quoted') return token.text
  if (token?.kind === 'word' && !CLAUSE_WORDS.has(token.text.toUpperCase())) return token.text
  return null
}

/** Index just past the parenthesised group that opens at `start`, or -1 when unbalanced. */
function skipGroup(tokens: Token[], start: number): number {
  let depth = 0
  for (let i = start; i < tokens.length; i++) {
    if (isPunct(tokens[i], '(')) depth++
    else if (isPunct(tokens[i], ')') && --depth === 0) return i + 1
  }
  return -1
}

export function singleTableSelect(sql: string): SelectSource {
  const tokens = tokenize(sql)
  if (!tokens) return fail(REASON_UNPARSED)
  while (isPunct(tokens[tokens.length - 1], ';')) tokens.pop()
  if (!tokens.length) return fail(REASON_NOT_SIMPLE)

  const first = upper(tokens[0])
  if (first === 'WITH') return fail(REASON_CTE)
  if (first !== 'SELECT') return fail(REASON_NOT_SIMPLE)

  // Select list: up to the first FROM outside parentheses.
  let i = 1
  let depth = 0
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (isPunct(t, '(')) depth++
    else if (isPunct(t, ')')) depth--
    else if (depth === 0 && ['UNION', 'EXCEPT', 'INTERSECT'].includes(upper(t)))
      return fail(REASON_UNION)
    else if (upper(t) === 'SELECT') return fail(REASON_SUBQUERY)
    else if (depth === 0 && upper(t) === 'FROM') break
    else if (depth === 0 && upper(t) === 'INTO') return fail(REASON_NOT_SIMPLE)
  }
  if (i >= tokens.length) return fail(REASON_NO_TABLE)
  i++

  // Table factor: [schema.]table
  if (isPunct(tokens[i], '(')) return fail(REASON_DERIVED)
  if (upper(tokens[i]) === 'DUAL') return fail(REASON_NO_TABLE)
  if (upper(tokens[i]) === 'LATERAL' || upper(tokens[i]) === 'JSON_TABLE')
    return fail(REASON_DERIVED)
  const name = identifier(tokens[i])
  if (name === null) return fail(REASON_UNPARSED)
  i++
  let schema: string | null = null
  let table = name
  if (isPunct(tokens[i], '.')) {
    const second = identifier(tokens[i + 1])
    if (second === null) return fail(REASON_UNPARSED)
    schema = name
    table = second
    i += 2
  }
  if (isPunct(tokens[i], '(')) return fail(REASON_NOT_SIMPLE) // table function call

  // PARTITION (p0, ...) only narrows the rows read: edits still go to the table.
  if (upper(tokens[i]) === 'PARTITION' && isPunct(tokens[i + 1], '(')) {
    i = skipGroup(tokens, i + 1)
    if (i < 0) return fail(REASON_UNPARSED)
  }

  // [AS] alias
  let alias: string | null = null
  if (upper(tokens[i]) === 'AS') {
    alias = identifier(tokens[i + 1])
    if (alias === null) return fail(REASON_UNPARSED)
    i += 2
  } else {
    alias = identifier(tokens[i])
    if (alias !== null) i++
  }

  // Index hints: USE|IGNORE|FORCE INDEX|KEY [FOR ...] (...) [, ...]
  for (;;) {
    const hint = upper(tokens[i])
    const isHint =
      (hint === 'USE' || hint === 'IGNORE' || hint === 'FORCE') &&
      (upper(tokens[i + 1]) === 'INDEX' || upper(tokens[i + 1]) === 'KEY')
    if (!isHint) {
      // A comma between two hints is part of the hint list, not a comma join.
      const next = upper(tokens[i + 1])
      if (isPunct(tokens[i], ',') && (next === 'USE' || next === 'IGNORE' || next === 'FORCE')) {
        i++
        continue
      }
      break
    }
    let j = i + 2
    while (j < tokens.length && !isPunct(tokens[j], '(')) j++
    i = skipGroup(tokens, j)
    if (i < 0) return fail(REASON_UNPARSED)
  }

  if (i >= tokens.length) return { ok: true, ref: { schema, table, alias } }
  const next = tokens[i]
  if (isPunct(next, ',') || JOIN_WORDS.has(upper(next))) return fail(REASON_MULTI)
  if (upper(next) === 'GROUP' || upper(next) === 'HAVING') return fail(REASON_GROUPED)
  if (['UNION', 'EXCEPT', 'INTERSECT'].includes(upper(next))) return fail(REASON_UNION)
  if (!TAIL_WORDS.has(upper(next))) return fail(REASON_UNPARSED)

  // Tail (WHERE / ORDER BY / LIMIT / locking): subqueries there only filter or order rows.
  depth = 0
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (isPunct(t, '(')) depth++
    else if (isPunct(t, ')')) depth--
    else if (depth === 0) {
      const word = upper(t)
      if (word === 'GROUP' || word === 'HAVING') return fail(REASON_GROUPED)
      if (word === 'UNION' || word === 'EXCEPT' || word === 'INTERSECT') return fail(REASON_UNION)
      if (word === 'INTO') return fail(REASON_NOT_SIMPLE)
    }
  }
  if (depth !== 0) return fail(REASON_UNPARSED)
  return { ok: true, ref: { schema, table, alias } }
}
