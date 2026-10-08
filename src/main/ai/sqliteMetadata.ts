/**
 * Structure-only reader for the AI assistant on SQLite connections (same
 * guard model as metadata.ts for MySQL and pgMetadata.ts for PostgreSQL).
 *
 * PRIVACY: `SqliteMetadataQueryable` refuses every statement that is not one
 * read-only SELECT whose sources are all sqlite_schema / sqlite_master /
 * sqlite_temp_schema (optionally qualified with an attached alias) or the
 * read pragma table-valued functions (pragma_table_xinfo, pragma_index_list,
 * pragma_foreign_key_list…), checked with the SQLite lexer and the dialect's
 * write allowlist, so a bug in the context builder cannot read table rows.
 * Only names, declared types, nullability, keys, indexes and foreign keys are
 * read: no defaults, CREATE statements (view/trigger bodies), or rows.
 */
import { analyzeWrites, splitStatements } from '@shared/dialects/sqlite'
import { sqliteCodeTokens, tokenizeSqlite, type SqliteToken } from '@shared/dialects/sqliteLexer'
import type { Queryable, SchemaSnapshot, TableMeta } from './metadata'
import { MetadataOnlyError } from './metadata'

const SCHEMA_TABLES = new Set([
  'sqlite_schema',
  'sqlite_master',
  'sqlite_temp_schema',
  'sqlite_temp_master'
])
const PRAGMA_FUNCTIONS = new Set([
  'pragma_table_list',
  'pragma_table_xinfo',
  'pragma_table_info',
  'pragma_index_list',
  'pragma_index_xinfo',
  'pragma_index_info',
  'pragma_foreign_key_list',
  'pragma_database_list'
])
const RELATION_END = new Set([
  'WHERE',
  'GROUP',
  'ORDER',
  'LIMIT',
  'HAVING',
  'WINDOW',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'ON',
  'USING',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'FULL',
  'CROSS',
  'NATURAL',
  'OUTER',
  'INDEXED',
  'NOT'
])

const upper = (t: SqliteToken | undefined): string =>
  t?.kind === 'word' ? t.value.toUpperCase() : ''
const isPunct = (t: SqliteToken | undefined, v: string): boolean =>
  !!t && (t.kind === 'punct' || t.kind === 'op') && t.value === v
const nameOf = (t: SqliteToken | undefined): string | null =>
  t?.kind === 'word' || t?.kind === 'ident' ? t.value.toLowerCase() : null

/**
 * Index just after an allowed source starting at `j`, or -1. Sources:
 * `[alias.]sqlite_schema` (and its synonyms), `pragma_x(…)` (read list),
 * or a parenthesised subquery (its own FROM is checked by the caller loop).
 */
function allowedSource(tokens: SqliteToken[], j: number): number {
  if (isPunct(tokens[j], '(')) return j // subquery
  const first = nameOf(tokens[j])
  if (first === null) return -1
  if (isPunct(tokens[j + 1], '(')) return PRAGMA_FUNCTIONS.has(first) ? j + 1 : -1
  if (isPunct(tokens[j + 1], '.')) {
    const second = nameOf(tokens[j + 2])
    return second !== null && SCHEMA_TABLES.has(second) && !isPunct(tokens[j + 3], '(') ? j + 3 : -1
  }
  return SCHEMA_TABLES.has(first) || PRAGMA_FUNCTIONS.has(first) ? j + 1 : -1
}

/** Skips a balanced parenthesised group starting at `j` (an opening paren). */
function skipGroup(tokens: SqliteToken[], j: number): number {
  let depth = 0
  for (let k = j; k < tokens.length; k++) {
    if (isPunct(tokens[k], '(')) depth++
    else if (isPunct(tokens[k], ')') && --depth === 0) return k + 1
  }
  return tokens.length
}

function sourcesAreSchema(tokens: SqliteToken[]): boolean {
  let found = false
  for (let i = 0; i < tokens.length; i++) {
    const word = upper(tokens[i])
    // `x IN users` reads a table in SQLite: only `IN (…)` is allowed.
    if (word === 'IN' && !isPunct(tokens[i + 1], '(')) return false
    if (word !== 'FROM' && word !== 'JOIN') continue
    let j = i + 1
    for (;;) {
      const end = allowedSource(tokens, j)
      if (end < 0) return false
      // A subquery or pragma arguments are skipped here; their own FROM/JOIN
      // and IN are checked by the outer loop, which visits every token.
      if (end === j) j = skipGroup(tokens, j)
      else if (isPunct(tokens[end], '(')) {
        j = skipGroup(tokens, end)
        found = true
      } else {
        j = end
        found = true
      }
      if (upper(tokens[j]) === 'AS') j += 2
      else if (
        (tokens[j]?.kind === 'word' && !RELATION_END.has(upper(tokens[j]))) ||
        tokens[j]?.kind === 'ident'
      )
        j++
      if (word === 'FROM' && isPunct(tokens[j], ',')) {
        j++
        continue
      }
      break
    }
  }
  return found
}

/** True when `sql` may run through the SQLite metadata reader. */
export function isSqliteMetadataSql(sql: string): boolean {
  if (/^\s*SELECT\s+sqlite_version\(\)(\s+AS\s+version)?\s*$/i.test(sql)) return true
  if (splitStatements(sql).length !== 1) return false
  const tokens = sqliteCodeTokens(tokenizeSqlite(sql))
  if (upper(tokens[0]) !== 'SELECT') return false
  if (tokens.some((t) => isPunct(t, ';'))) return false
  if (analyzeWrites(sql).writes) return false
  return sourcesAreSchema(tokens)
}

/** Wraps a SQLite session so only schema reads reach the file. */
export class SqliteMetadataQueryable implements Queryable {
  constructor(private readonly inner: Queryable) {}
  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    if (!isSqliteMetadataSql(sql)) throw new MetadataOnlyError()
    return this.inner.query<T>(sql, params)
  }
}

type Row = Record<string, unknown>
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const quoteAlias = (db: string): string => `"${db.replace(/"/g, '""')}"`
const USER_OBJECTS = `name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`

/** Structure of one attached database ('main', 'temp', an ATTACH alias), all tables or `only`. */
export async function readSqliteSchemaSnapshot(
  q: SqliteMetadataQueryable,
  db: string,
  only?: string[]
): Promise<SchemaSnapshot> {
  const schema = `${quoteAlias(db)}.sqlite_schema`
  const wanted = only && only.length ? new Set(only.map((n) => n.toLowerCase())) : null
  const keep = (name: unknown): boolean => !wanted || wanted.has(str(name).toLowerCase())
  const objects = await q.query<Row>(
    `SELECT m.name AS name, m.type AS type FROM ${schema} m
      WHERE m.type IN ('table', 'view') AND m.${USER_OBJECTS} ORDER BY m.name`
  )
  const columns = await q.query<Row>(
    `SELECT m.name AS tbl, p.name AS name, p.type AS type, p."notnull" AS nn, p.pk AS pk, p.hidden AS hidden
       FROM ${schema} m JOIN pragma_table_xinfo(m.name, ?) p
      WHERE m.type IN ('table', 'view') AND m.${USER_OBJECTS} ORDER BY m.name, p.cid`,
    [db]
  )
  const indexes = await q.query<Row>(
    `SELECT m.name AS tbl, il.name AS name, il."unique" AS uq, ii.name AS col
       FROM ${schema} m JOIN pragma_index_list(m.name, ?) il JOIN pragma_index_info(il.name, ?) ii
      WHERE m.type = 'table' AND m.${USER_OBJECTS} ORDER BY m.name, il.name, ii.seqno`,
    [db, db]
  )
  const foreignKeys = await q.query<Row>(
    `SELECT m.name AS tbl, f.id AS id, f."table" AS ref, f."from" AS src, f."to" AS dst
       FROM ${schema} m JOIN pragma_foreign_key_list(m.name, ?) f
      WHERE m.type = 'table' AND m.${USER_OBJECTS} ORDER BY m.name, f.id, f.seq`,
    [db]
  )
  const [version] = await q.query<Row>('SELECT sqlite_version() AS version')

  const byName = new Map<string, TableMeta>()
  for (const o of objects) {
    if (!keep(o.name)) continue
    byName.set(str(o.name), {
      name: str(o.name),
      kind: str(o.type) === 'view' ? 'view' : 'table',
      rows: null,
      comment: '',
      columns: [],
      indexes: [],
      foreignKeys: []
    })
  }
  for (const c of columns) {
    const hidden = Number(c.hidden)
    if (hidden === 1) continue // virtual-table hidden columns
    byName.get(str(c.tbl))?.columns.push({
      name: str(c.name),
      type: str(c.type),
      nullable: Number(c.nn) === 0,
      key: Number(c.pk) > 0 ? 'PRI' : '',
      extra: hidden === 2 ? 'generated virtual' : hidden === 3 ? 'generated stored' : '',
      comment: ''
    })
  }
  for (const i of indexes) {
    const table = byName.get(str(i.tbl))
    if (!table) continue
    let index = table.indexes.find((x) => x.name === str(i.name))
    if (!index) {
      index = { name: str(i.name), unique: Number(i.uq) === 1, columns: [] }
      table.indexes.push(index)
    }
    index.columns.push(i.col === null || i.col === undefined ? '(expresión)' : str(i.col))
  }
  for (const f of foreignKeys) {
    const table = byName.get(str(f.tbl))
    if (!table) continue
    const name = `fk_${str(f.id)}`
    let fk = table.foreignKeys.find((x) => x.name === name)
    if (!fk) {
      fk = { name, columns: [], refSchema: db, refTable: str(f.ref), refColumns: [] }
      table.foreignKeys.push(fk)
    }
    fk.columns.push(str(f.src))
    if (f.dst !== null && f.dst !== undefined) fk.refColumns.push(str(f.dst))
  }
  return {
    schema: db,
    serverVersion: `SQLite ${str(version?.version)}`,
    tables: [...byName.values()],
    routines: []
  }
}

/** Attached databases of the connection (main, temp, aliases), for the "no database" context. */
export async function readSqliteDatabaseNames(q: SqliteMetadataQueryable): Promise<string[]> {
  const rows = await q.query<Row>('SELECT name FROM pragma_database_list ORDER BY seq')
  return rows.map((r) => str(r.name))
}

/** One read-only SELECT (EXPLAIN QUERY PLAN may run on it, never plain EXPLAIN). */
export function isSingleSqliteSelect(sql: string | null | undefined): boolean {
  if (!sql?.trim()) return false
  const statements = splitStatements(sql)
  if (statements.length !== 1) return false
  const first = sqliteCodeTokens(tokenizeSqlite(statements[0].sql))[0]
  return upper(first) === 'SELECT' && !analyzeWrites(statements[0].sql).writes
}

/** EXPLAIN QUERY PLAN of a single read-only SELECT, as an indented tree; null otherwise. */
export async function explainSqliteSelect(q: Queryable, sql: string): Promise<string | null> {
  if (!isSingleSqliteSelect(sql)) return null
  const statement = splitStatements(sql)[0].sql.replace(/;\s*$/, '')
  try {
    const rows = await q.query<Row>(`EXPLAIN QUERY PLAN ${statement}`)
    const depth = new Map<number, number>()
    const lines = rows.map((r) => {
      const level = (depth.get(Number(r.parent)) ?? -1) + 1
      depth.set(Number(r.id), level)
      return `${'  '.repeat(level)}${str(r.detail)}`
    })
    return (
      lines.slice(0, 80).join('\n') +
      (lines.length > 80 ? `\n… ${lines.length - 80} líneas más` : '')
    )
  } catch {
    return null
  }
}
