/**
 * Token-level parser of a SQLite `CREATE TABLE` statement (the `sql` column of
 * sqlite_schema). It keeps the original text of every column definition and
 * table constraint, so the table designer can rebuild a table without losing
 * what it does not model (CHECK, COLLATE, GENERATED, ON CONFLICT…), and
 * introspection can read constraint names that the PRAGMAs do not report.
 *
 * It never evaluates anything: unknown shapes (CREATE TABLE … AS SELECT,
 * virtual tables) come back with `parsed: false`.
 */
import { sqliteCodeTokens, tokenizeSqlite, type SqliteToken } from '../dialects/sqliteLexer'

export type ColumnClauseKind =
  | 'primary'
  | 'notnull'
  | 'null'
  | 'unique'
  | 'check'
  | 'default'
  | 'collate'
  | 'references'
  | 'generated'

export interface ColumnClause {
  kind: ColumnClauseKind
  /** CONSTRAINT name, when the clause has one. */
  name: string | null
  /** Original text, CONSTRAINT name included. */
  text: string
  /** Text after the clause keyword(s): the DEFAULT value, the COLLATE name, the CHECK body… */
  body: string
}

export interface ParsedColumn {
  name: string
  /** Declared type as written ('' when untyped). */
  type: string
  clauses: ColumnClause[]
  /** Whole definition as written. */
  text: string
}

export type TableConstraintKind = 'primary' | 'unique' | 'check' | 'foreign' | 'unknown'

export interface ParsedTableConstraint {
  kind: TableConstraintKind
  name: string | null
  /** Columns of PRIMARY KEY / UNIQUE / FOREIGN KEY (…), as unquoted names. */
  columns: string[]
  text: string
}

export interface ParsedCreateTable {
  parsed: boolean
  schema: string | null
  name: string
  temp: boolean
  columns: ParsedColumn[]
  constraints: ParsedTableConstraint[]
  withoutRowid: boolean
  strict: boolean
}

const CLAUSE_START = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'NOT',
  'NULL',
  'UNIQUE',
  'CHECK',
  'DEFAULT',
  'COLLATE',
  'REFERENCES',
  'GENERATED',
  'AS'
])

const TABLE_CONSTRAINT_START = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'])

const upper = (t: SqliteToken | undefined): string =>
  t && t.kind === 'word' ? t.value.toUpperCase() : ''
const isPunct = (t: SqliteToken | undefined, v: string): boolean =>
  !!t && t.kind === 'punct' && t.value === v
const nameOf = (t: SqliteToken | undefined): string =>
  !t ? '' : t.kind === 'string' ? t.value.slice(1, -1).replace(/''/g, "'") : t.value

/** Splits tokens at depth-0 commas. */
function splitTopLevel(tokens: SqliteToken[]): SqliteToken[][] {
  const parts: SqliteToken[][] = []
  let current: SqliteToken[] = []
  let depth = 0
  for (const t of tokens) {
    if (isPunct(t, '(')) depth++
    else if (isPunct(t, ')')) depth--
    if (depth === 0 && isPunct(t, ',')) {
      parts.push(current)
      current = []
      continue
    }
    current.push(t)
  }
  if (current.length) parts.push(current)
  return parts
}

/** Names inside the first parenthesised group of `tokens` (PRIMARY KEY (a, b DESC)). */
function groupNames(tokens: SqliteToken[], from = 0): string[] {
  const open = tokens.findIndex((t, i) => i >= from && isPunct(t, '('))
  if (open < 0) return []
  const out: string[] = []
  let depth = 0
  let expectName = true
  for (let i = open + 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (isPunct(t, '(')) depth++
    else if (isPunct(t, ')')) {
      if (depth === 0) break
      depth--
    } else if (depth === 0 && isPunct(t, ',')) expectName = true
    else if (
      depth === 0 &&
      expectName &&
      (t.kind === 'word' || t.kind === 'ident' || t.kind === 'string')
    ) {
      out.push(nameOf(t))
      expectName = false
    }
  }
  return out
}

function textOf(src: string, tokens: SqliteToken[]): string {
  if (!tokens.length) return ''
  return src.slice(tokens[0].start, tokens[tokens.length - 1].end)
}

function clauseKind(tokens: SqliteToken[], i: number): ColumnClauseKind | null {
  switch (upper(tokens[i])) {
    case 'PRIMARY':
      return 'primary'
    case 'NOT':
      return upper(tokens[i + 1]) === 'NULL' ? 'notnull' : null
    case 'NULL':
      return 'null'
    case 'UNIQUE':
      return 'unique'
    case 'CHECK':
      return 'check'
    case 'DEFAULT':
      return 'default'
    case 'COLLATE':
      return 'collate'
    case 'REFERENCES':
      return 'references'
    case 'GENERATED':
    case 'AS':
      return 'generated'
    default:
      return null
  }
}

/** Keyword tokens that open a clause (and how many words the opener spans). */
function keywordSpan(kind: ColumnClauseKind, tokens: SqliteToken[], i: number): number {
  if (kind === 'primary') return upper(tokens[i + 1]) === 'KEY' ? 2 : 1
  if (kind === 'notnull') return 2
  if (kind === 'generated') {
    // GENERATED ALWAYS AS (…) or AS (…)
    let j = i
    if (upper(tokens[j]) === 'GENERATED') j++
    if (upper(tokens[j]) === 'ALWAYS') j++
    if (upper(tokens[j]) === 'AS') j++
    return j - i
  }
  return 1
}

/** True when tokens[i] starts a new column clause (inside the clause `current`). */
function startsClause(
  tokens: SqliteToken[],
  i: number,
  current: ColumnClauseKind | null,
  depth: number
): boolean {
  if (depth !== 0) return false
  const w = upper(tokens[i])
  if (!CLAUSE_START.has(w)) return false
  const prev = upper(tokens[i - 1])
  if (w === 'NOT') return upper(tokens[i + 1]) === 'NULL'
  if (w === 'NULL') return prev !== 'SET' && prev !== 'NOT' && prev !== 'IS' && prev !== 'DEFAULT'
  if (w === 'DEFAULT') return prev !== 'SET'
  if (w === 'AS') return current !== 'generated' && prev !== 'ALWAYS'
  if (w === 'CONSTRAINT') return true
  // Inside REFERENCES: MATCH, ON … are part of it; only real clause starts end it.
  return true
}

function parseColumn(src: string, tokens: SqliteToken[]): ParsedColumn {
  const name = nameOf(tokens[0])
  let i = 1
  let depth = 0
  const typeTokens: SqliteToken[] = []
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (depth === 0 && CLAUSE_START.has(upper(t)) && startsClause(tokens, i, null, 0)) break
    if (isPunct(t, '(')) depth++
    else if (isPunct(t, ')')) depth--
    typeTokens.push(t)
  }
  const clauses: ColumnClause[] = []
  let start = i
  let pendingName: string | null = null
  let kind: ColumnClauseKind | null = null
  let bodyStart = -1
  depth = 0
  const flush = (end: number): void => {
    if (kind === null || start >= end) return
    const slice = tokens.slice(start, end)
    clauses.push({
      kind,
      name: pendingName,
      text: textOf(src, slice),
      body: bodyStart >= 0 && bodyStart < end ? textOf(src, tokens.slice(bodyStart, end)) : ''
    })
    pendingName = null
    kind = null
  }
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (depth === 0 && startsClause(tokens, i, kind, depth)) {
      const w = upper(t)
      if (w === 'CONSTRAINT') {
        flush(i)
        start = i
        pendingName = nameOf(tokens[i + 1])
        i++
        continue
      }
      const k = clauseKind(tokens, i)
      if (k) {
        // A CONSTRAINT name keeps its start; otherwise the clause starts here.
        if (kind !== null) flush(i)
        if (pendingName === null) start = i
        kind = k
        const span = keywordSpan(k, tokens, i)
        bodyStart = i + span
        i += span - 1
        continue
      }
    }
    if (isPunct(t, '(')) depth++
    else if (isPunct(t, ')')) depth--
  }
  flush(tokens.length)
  return {
    name,
    type: textOf(src, typeTokens),
    clauses,
    text: textOf(src, tokens)
  }
}

function parseTableConstraint(src: string, tokens: SqliteToken[]): ParsedTableConstraint {
  let i = 0
  let name: string | null = null
  if (upper(tokens[0]) === 'CONSTRAINT') {
    name = nameOf(tokens[1])
    i = 2
  }
  const w = upper(tokens[i])
  const kind: TableConstraintKind =
    w === 'PRIMARY'
      ? 'primary'
      : w === 'UNIQUE'
        ? 'unique'
        : w === 'CHECK'
          ? 'check'
          : w === 'FOREIGN'
            ? 'foreign'
            : 'unknown'
  return {
    kind,
    name,
    columns: kind === 'check' || kind === 'unknown' ? [] : groupNames(tokens, i),
    text: textOf(src, tokens)
  }
}

const EMPTY: ParsedCreateTable = {
  parsed: false,
  schema: null,
  name: '',
  temp: false,
  columns: [],
  constraints: [],
  withoutRowid: false,
  strict: false
}

export function parseCreateTable(sql: string | null | undefined): ParsedCreateTable {
  if (!sql) return { ...EMPTY }
  const tokens = sqliteCodeTokens(tokenizeSqlite(sql))
  let i = 0
  if (upper(tokens[i]) !== 'CREATE') return { ...EMPTY }
  i++
  let temp = false
  if (upper(tokens[i]) === 'TEMP' || upper(tokens[i]) === 'TEMPORARY') {
    temp = true
    i++
  }
  if (upper(tokens[i]) !== 'TABLE') return { ...EMPTY }
  i++
  if (
    upper(tokens[i]) === 'IF' &&
    upper(tokens[i + 1]) === 'NOT' &&
    upper(tokens[i + 2]) === 'EXISTS'
  )
    i += 3
  let schema: string | null = null
  let name = nameOf(tokens[i])
  i++
  if (isPunct(tokens[i], '.')) {
    schema = name
    name = nameOf(tokens[i + 1])
    i += 2
  }
  if (!isPunct(tokens[i], '(')) return { ...EMPTY, schema, name, temp }
  // Body up to the matching ')'.
  let depth = 0
  let close = -1
  for (let j = i; j < tokens.length; j++) {
    if (isPunct(tokens[j], '(')) depth++
    else if (isPunct(tokens[j], ')')) {
      depth--
      if (depth === 0) {
        close = j
        break
      }
    }
  }
  if (close < 0) return { ...EMPTY, schema, name, temp }
  const columns: ParsedColumn[] = []
  const constraints: ParsedTableConstraint[] = []
  for (const part of splitTopLevel(tokens.slice(i + 1, close))) {
    if (!part.length) continue
    if (TABLE_CONSTRAINT_START.has(upper(part[0])))
      constraints.push(parseTableConstraint(sql, part))
    else columns.push(parseColumn(sql, part))
  }
  const tail = tokens.slice(close + 1).map(upper)
  const withoutRowid = tail.some((w, k) => w === 'WITHOUT' && tail[k + 1] === 'ROWID')
  const strict = tail.includes('STRICT')
  return { parsed: true, schema, name, temp, columns, constraints, withoutRowid, strict }
}

/** Column-level clause of a kind, if any. */
export function clauseOf(column: ParsedColumn, kind: ColumnClauseKind): ColumnClause | undefined {
  return column.clauses.find((c) => c.kind === kind)
}

/** COLLATE name of a column ('' when none). */
export function collationOf(column: ParsedColumn | undefined): string {
  const c = column ? clauseOf(column, 'collate') : undefined
  return c ? c.body.replace(/^["`[]|["`\]]$/g, '') : ''
}

/** True when the statement uses AUTOINCREMENT (only valid on an INTEGER PRIMARY KEY). */
export function hasAutoincrement(sql: string | null | undefined): boolean {
  if (!sql) return false
  return sqliteCodeTokens(tokenizeSqlite(sql)).some((t) => upper(t) === 'AUTOINCREMENT')
}
