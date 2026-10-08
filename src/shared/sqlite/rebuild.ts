/**
 * The SQLite "rebuild table" procedure (docs/multi-engine-design.md, section
 * 8.1, steps 1–13), as a pure statement builder. Main runs it (with the
 * dependents and the sqlite_sequence value it reads itself, never from the
 * renderer) and the designer uses it to preview the exact script.
 *
 * Order: PRAGMA foreign_keys=OFF (outside the transaction) · BEGIN · in-place
 * steps (a table rename goes first, so SQLite rewrites the dependents) · drop
 * dependent triggers and views · CREATE the new table under a temporary name ·
 * copy the rows (rowid included when both tables have one) · DROP the old
 * table · RENAME the new one · CREATE INDEX · recreate triggers and views in
 * their original order · restore the AUTOINCREMENT high-water mark ·
 * PRAGMA foreign_key_check (only new violations abort) · COMMIT ·
 * PRAGMA foreign_keys back to the connection's setting.
 */
import { quoteIdent, quoteString } from '../dialects/sqlite'
import { sqliteCodeTokens, tokenizeSqlite } from '../dialects/sqliteLexer'
import type { SqliteRebuildDefinition, SqliteTableDependent } from '../types'

/** Marker statement main recognises to run the foreign key check against its baseline. */
export const FOREIGN_KEY_CHECK = 'PRAGMA foreign_key_check'

export interface RebuildContext {
  /** Attached database alias ('main', 'aux'…). */
  schema: string
  /** Name of the table when the rebuild starts (after an in-place rename). */
  table: string
  /** Triggers and views to drop and recreate, in sqlite_schema order. */
  dependents: SqliteTableDependent[]
  /** sqlite_sequence value of the table before the rebuild (null = none). */
  sequence: number | null
  /** PRAGMA foreign_keys of the connection (restored at the end). */
  foreignKeys: boolean
}

export interface RebuildScript {
  /** Outside the transaction, before it. */
  pre: string[]
  /** BEGIN … COMMIT, FOREIGN_KEY_CHECK included before COMMIT. */
  body: string[]
  /** Outside the transaction, after it (always run, also after a failure). */
  post: string[]
}

export function tempTableName(table: string): string {
  return `__vortaq_new_${table}`
}

const q = (name: string): string => quoteIdent(name, true)

/** True when `sql` names `table` as an identifier (not inside a string or comment). */
export function mentionsTable(sql: string, table: string): boolean {
  const lower = table.toLowerCase()
  return sqliteCodeTokens(tokenizeSqlite(sql)).some(
    (t) => (t.kind === 'word' || t.kind === 'ident') && t.value.toLowerCase() === lower
  )
}

/**
 * `CREATE [UNIQUE] INDEX|VIEW|TRIGGER [IF NOT EXISTS] name …` with the name
 * qualified by `schema` when it is not qualified yet. The SQL stored in
 * sqlite_schema never names its database, and an unqualified CREATE goes to
 * `main`: recreating an attached database's index, view or trigger needs the
 * prefix. `main`, TEMP objects and other statements are returned unchanged.
 */
export function qualifyCreate(sql: string, schema: string): string {
  // An unqualified CREATE already goes to main: keep the user's text as written.
  if (schema.toLowerCase() === 'main') return sql
  const tokens = sqliteCodeTokens(tokenizeSqlite(sql))
  const up = (i: number): string =>
    tokens[i] && tokens[i].kind === 'word' ? tokens[i].value.toUpperCase() : ''
  let i = 0
  if (up(i) !== 'CREATE') return sql
  i++
  if (up(i) === 'UNIQUE') i++
  if (up(i) === 'TEMP' || up(i) === 'TEMPORARY') return sql
  if (up(i) !== 'INDEX' && up(i) !== 'VIEW' && up(i) !== 'TRIGGER') return sql
  i++
  if (up(i) === 'IF' && up(i + 1) === 'NOT' && up(i + 2) === 'EXISTS') i += 3
  const name = tokens[i]
  if (!name) return sql
  const next = tokens[i + 1]
  if (next && next.kind === 'punct' && next.value === '.') return sql
  return `${sql.slice(0, name.start)}${q(schema)}.${sql.slice(name.start)}`
}

/**
 * The full script. `inPlace` are the designer's in-place statements (a table
 * rename first), run inside the transaction before the rebuild.
 */
export function buildRebuildScript(
  definition: SqliteRebuildDefinition,
  inPlace: string[],
  ctx: RebuildContext
): RebuildScript {
  const s = q(ctx.schema)
  const tmp = `${s}.${q(tempTableName(ctx.table))}`
  const old = `${s}.${q(ctx.table)}`
  const body: string[] = ['BEGIN', ...inPlace]
  for (const d of ctx.dependents)
    body.push(`DROP ${d.type === 'view' ? 'VIEW' : 'TRIGGER'} IF EXISTS ${s}.${q(d.name)}`)
  body.push(`CREATE TABLE ${tmp} ${definition.createBody}`)
  const targets = definition.columnMap.map((c) => q(c.target))
  const sources = definition.columnMap.map((c) => q(c.source))
  if (definition.keepRowid) {
    targets.unshift('rowid')
    sources.unshift('rowid')
  }
  if (targets.length)
    body.push(`INSERT INTO ${tmp} (${targets.join(', ')}) SELECT ${sources.join(', ')} FROM ${old}`)
  body.push(`DROP TABLE ${old}`)
  body.push(`ALTER TABLE ${tmp} RENAME TO ${q(ctx.table)}`)
  body.push(...definition.indexes.map((ix) => qualifyCreate(ix, ctx.schema)))
  for (const d of ctx.dependents) body.push(qualifyCreate(d.sql, ctx.schema))
  if (definition.autoincrement && ctx.sequence !== null) {
    const name = quoteString(ctx.table)
    body.push(
      `UPDATE ${s}.sqlite_sequence SET seq = max(seq, ${ctx.sequence}) WHERE name = ${name}`,
      `INSERT INTO ${s}.sqlite_sequence (name, seq) SELECT ${name}, ${ctx.sequence} WHERE NOT EXISTS (SELECT 1 FROM ${s}.sqlite_sequence WHERE name = ${name})`
    )
  }
  body.push(FOREIGN_KEY_CHECK, 'COMMIT')
  return {
    pre: ['PRAGMA foreign_keys = OFF'],
    body,
    post: [`PRAGMA foreign_keys = ${ctx.foreignKeys ? 'ON' : 'OFF'}`]
  }
}

/** Readable script for the designer's preview. */
export function rebuildPreview(script: RebuildScript): string {
  return [
    '-- Fuera de la transacción',
    ...script.pre.map((st) => `${st};`),
    '',
    ...script.body.map((st) => `${st};`),
    '',
    '-- Al terminar (también si falla)',
    ...script.post.map((st) => `${st};`)
  ].join('\n')
}
