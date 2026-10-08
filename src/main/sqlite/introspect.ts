/**
 * SQLite introspection (docs/multi-engine-design.md, section 5.6): sqlite_schema
 * plus the table-valued PRAGMA functions (pragma_table_list, pragma_table_xinfo,
 * pragma_index_list/xinfo, pragma_foreign_key_list), always with the attached
 * database alias as a bound argument or a quoted identifier. DDL is the
 * original `sql` text of sqlite_schema.
 */
import { quoteIdent } from '@shared/dialects/sqlite'
import { affinityOf, sqliteTypeKind } from '@shared/sqlite/affinity'
import { hasAutoincrement, parseCreateTable } from '@shared/sqlite/createTable'
import type {
  ColumnInfo,
  ConstraintInfo,
  DatabaseInfo,
  EngineObjectType,
  ForeignKeyInfo,
  IndexInfo,
  ObjectRef,
  ObjectSummary,
  TableInfo,
  TableKind,
  TableStructure,
  TriggerInfo,
  ViewInfo
} from '@shared/types'
import { SqliteUserError } from './errors'

/** What introspection needs from a session. */
export interface SqliteQueryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
}

type Row = Record<string, unknown>

const text = (v: unknown, fallback = ''): string =>
  v === null || v === undefined ? fallback : String(v)
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)

/** `"aux".sqlite_schema` (temp uses sqlite_temp_schema through the same alias). */
const schemaTable = (db: string): string => `${quoteIdent(db, true)}.sqlite_schema`

/** Internal objects SQLite creates (sqlite_sequence, sqlite_stat1, autoindexes). */
const INTERNAL = `name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`

/* ---------- databases ---------- */

export async function listDatabases(s: SqliteQueryable): Promise<DatabaseInfo[]> {
  const rows = await s.query<Row>('SELECT seq, name, file FROM pragma_database_list ORDER BY seq')
  const out: DatabaseInfo[] = []
  for (const r of rows) {
    const name = text(r.name)
    if (name === 'temp') {
      const [count] = await s.query<{ n: number }>('SELECT count(*) AS n FROM temp.sqlite_schema')
      if (!count || num(count.n) === 0) continue
    }
    out.push({ name, characterSet: '', collation: '' })
  }
  return out
}

/* ---------- tables, views, indexes, triggers ---------- */

interface TableListRow {
  name: string
  type: string
  wr: number
  strict: number
}

async function tableList(s: SqliteQueryable, db: string): Promise<TableListRow[]> {
  const rows = await s.query<Row>(
    `SELECT name, type, wr, strict FROM pragma_table_list WHERE schema = ? AND ${INTERNAL}
      ORDER BY name COLLATE NOCASE`,
    [db]
  )
  return rows.map((r) => ({
    name: text(r.name),
    type: text(r.type),
    wr: num(r.wr),
    strict: num(r.strict)
  }))
}

async function sequences(s: SqliteQueryable, db: string): Promise<Map<string, number>> {
  const has = await s.query<Row>(
    `SELECT 1 FROM ${schemaTable(db)} WHERE type = 'table' AND name = 'sqlite_sequence'`
  )
  if (!has.length) return new Map()
  const rows = await s.query<Row>(`SELECT name, seq FROM ${quoteIdent(db, true)}.sqlite_sequence`)
  return new Map(rows.map((r) => [text(r.name).toLowerCase(), num(r.seq)]))
}

function tableLabel(t: TableListRow): string | null {
  if (t.type === 'virtual') return 'virtual'
  const parts = [t.wr ? 'WITHOUT ROWID' : '', t.strict ? 'STRICT' : ''].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

export async function listTables(s: SqliteQueryable, db: string): Promise<TableInfo[]> {
  const [list, seqs] = await Promise.all([tableList(s, db), sequences(s, db)])
  return list
    .filter((t) => t.type === 'table' || t.type === 'virtual')
    .map((t) => ({
      name: t.name,
      engine: tableLabel(t),
      rows: null,
      dataLength: null,
      indexLength: null,
      autoIncrement: seqs.get(t.name.toLowerCase()) ?? null,
      createTime: null,
      updateTime: null,
      collation: null,
      comment: ''
    }))
}

export async function listViews(s: SqliteQueryable, db: string): Promise<ViewInfo[]> {
  const rows = await s.query<Row>(
    `SELECT name FROM ${schemaTable(db)} WHERE type = 'view' ORDER BY name COLLATE NOCASE`
  )
  return rows.map((r) => ({ name: text(r.name), definer: '', security: '', updatable: false }))
}

/** BEFORE/AFTER/INSTEAD OF and INSERT/UPDATE/DELETE of a CREATE TRIGGER text. */
export function triggerShape(sql: string): { timing: string; event: string } {
  const head = sql.replace(/\s+/g, ' ').toUpperCase()
  const timing = / INSTEAD OF /.test(head)
    ? 'INSTEAD OF'
    : / BEFORE /.test(head)
      ? 'BEFORE'
      : 'AFTER'
  const event = / DELETE ON /.test(head) ? 'DELETE' : / INSERT ON /.test(head) ? 'INSERT' : 'UPDATE'
  return { timing, event }
}

export async function listTriggers(s: SqliteQueryable, db: string): Promise<TriggerInfo[]> {
  const rows = await s.query<Row>(
    `SELECT name, tbl_name, sql FROM ${schemaTable(db)} WHERE type = 'trigger'
      ORDER BY name COLLATE NOCASE`
  )
  return rows.map((r) => {
    const sql = text(r.sql)
    const shape = triggerShape(sql.split(/\bBEGIN\b/i)[0] ?? sql)
    return {
      name: text(r.name),
      table: text(r.tbl_name),
      event: shape.event,
      timing: shape.timing,
      statement: sql,
      definer: ''
    }
  })
}

export async function listIndexes(s: SqliteQueryable, db: string): Promise<ObjectSummary[]> {
  const rows = await s.query<Row>(
    `SELECT m.name AS name, m.tbl_name AS tbl, il."unique" AS uq, il.partial AS partial
       FROM ${schemaTable(db)} m
       LEFT JOIN pragma_index_list(m.tbl_name, ?) il ON il.name = m.name
      WHERE m.type = 'index' AND m.sql IS NOT NULL
      ORDER BY m.tbl_name COLLATE NOCASE, m.name COLLATE NOCASE`,
    [db]
  )
  const out: ObjectSummary[] = []
  for (const r of rows) {
    const name = text(r.name)
    const cols = await s.query<Row>(
      'SELECT name, cid FROM pragma_index_xinfo(?, ?) WHERE key = 1 ORDER BY seqno',
      [name, db]
    )
    out.push({
      name,
      type: 'index',
      schema: db,
      table: text(r.tbl),
      kind: num(r.uq) ? 'única' : r.partial ? 'parcial' : 'índice',
      detail: cols.map((c) => (c.name === null ? '(expresión)' : text(c.name))).join(', ')
    })
  }
  return out
}

export async function listObjects(
  s: SqliteQueryable,
  db: string,
  type: EngineObjectType
): Promise<ObjectSummary[]> {
  if (type === 'index') return listIndexes(s, db)
  if (type === 'trigger')
    return (await listTriggers(s, db)).map((t) => ({
      name: t.name,
      type: 'trigger',
      schema: db,
      table: t.table,
      kind: `${t.timing} ${t.event}`.toLowerCase(),
      detail: null
    }))
  if (type === 'view')
    return (await listViews(s, db)).map((v) => ({ name: v.name, type: 'view', schema: db }))
  if (type === 'table')
    return (await listTables(s, db)).map((t) => ({
      name: t.name,
      type: 'table',
      schema: db,
      kind: t.engine ?? undefined
    }))
  return []
}

/* ---------- columns and structure ---------- */

interface XinfoRow {
  cid: number
  name: string
  type: string
  notnull: number
  dflt: string | null
  pk: number
  hidden: number
}

async function xinfo(s: SqliteQueryable, db: string, table: string): Promise<XinfoRow[]> {
  const rows = await s.query<Row>(
    'SELECT cid, name, type, "notnull" AS nn, dflt_value AS dflt, pk, hidden FROM pragma_table_xinfo(?, ?) ORDER BY cid',
    [table, db]
  )
  return rows.map((r) => ({
    cid: num(r.cid),
    name: text(r.name),
    type: text(r.type),
    notnull: num(r.nn),
    dflt: r.dflt === null || r.dflt === undefined ? null : String(r.dflt),
    pk: num(r.pk),
    hidden: num(r.hidden)
  }))
}

async function tableEntry(
  s: SqliteQueryable,
  db: string,
  table: string
): Promise<{ type: string; wr: boolean; strict: boolean; sql: string | null } | null> {
  const [t] = await s.query<Row>(
    'SELECT name, type, wr, strict FROM pragma_table_list WHERE schema = ? AND name = ? COLLATE NOCASE',
    [db, table]
  )
  if (!t) return null
  const [m] = await s.query<Row>(
    `SELECT sql FROM ${schemaTable(db)} WHERE name = ? COLLATE NOCASE AND type IN ('table', 'view')`,
    [table]
  )
  return {
    type: text(t.type),
    wr: num(t.wr) === 1,
    strict: num(t.strict) === 1,
    sql: m && m.sql !== null && m.sql !== undefined ? String(m.sql) : null
  }
}

/** Column that is the rowid (an INTEGER PRIMARY KEY of a rowid table), or null. */
function rowidAliasOf(cols: XinfoRow[], withoutRowid: boolean): string | null {
  if (withoutRowid) return null
  const pk = cols.filter((c) => c.pk > 0)
  if (pk.length !== 1) return null
  return pk[0].type.toUpperCase() === 'INTEGER' ? pk[0].name : null
}

function toColumnInfo(c: XinfoRow, rowidAlias: string | null, autoincrement: boolean): ColumnInfo {
  const isAlias = rowidAlias !== null && c.name === rowidAlias
  const generated = c.hidden === 2 ? 'virtual' : c.hidden === 3 ? 'stored' : null
  return {
    name: c.name,
    ordinal: c.cid + 1,
    columnType: c.type,
    dataType: c.type.toLowerCase(),
    nullable: c.notnull === 0 && !isAlias,
    key: c.pk > 0 ? 'PRI' : '',
    defaultValue: c.dflt,
    extra:
      isAlias && autoincrement
        ? 'AUTOINCREMENT'
        : generated
          ? `GENERATED ${generated.toUpperCase()}`
          : '',
    characterSet: null,
    collation: null,
    comment: '',
    primaryKey: c.pk > 0,
    autoIncrement: isAlias,
    generated,
    typeKind: sqliteTypeKind(c.type),
    hidden: c.hidden === 1 ? true : undefined,
    hasDefault: c.dflt !== null || isAlias || generated !== null,
    identity: null
  }
}

export async function listColumns(
  s: SqliteQueryable,
  db: string,
  table: string
): Promise<ColumnInfo[]> {
  const entry = await tableEntry(s, db, table)
  const cols = await xinfo(s, db, table)
  const alias = rowidAliasOf(cols, entry?.wr ?? false)
  const auto = hasAutoincrement(entry?.sql)
  return cols.filter((c) => c.hidden !== 1).map((c) => toColumnInfo(c, alias, auto))
}

/** How rows of a table are addressed for edits (section 5.6: rowid whenever there is one). */
export type RowIdentity =
  | { kind: 'rowid'; alias: string; column: string | null }
  | { kind: 'primaryKey'; columns: string[] }
  | { kind: 'none'; reason: string }

/**
 * Rowid tables are edited by rowid, even with a primary key (rowid-table keys
 * allow NULLs and affinity duplicates). An INTEGER PRIMARY KEY is the rowid
 * (`column` names it). Otherwise the first of rowid, _rowid_, oid that no
 * real column shadows is selected. WITHOUT ROWID tables use their key.
 */
export async function rowIdentity(
  s: SqliteQueryable,
  db: string,
  table: string
): Promise<RowIdentity> {
  const entry = await tableEntry(s, db, table)
  if (!entry) return { kind: 'none', reason: 'la tabla no existe' }
  if (entry.type === 'view') return { kind: 'none', reason: 'es una vista' }
  if (entry.type === 'virtual') return { kind: 'none', reason: 'es una tabla virtual' }
  const cols = await xinfo(s, db, table)
  if (entry.wr) {
    const pk = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name)
    return pk.length
      ? { kind: 'primaryKey', columns: pk }
      : { kind: 'none', reason: 'la tabla no tiene clave primaria' }
  }
  const alias = rowidAliasOf(cols, false)
  if (alias) return { kind: 'rowid', alias, column: alias }
  const names = new Set(cols.map((c) => c.name.toLowerCase()))
  const free = ['rowid', '_rowid_', 'oid'].find((n) => !names.has(n))
  return free
    ? { kind: 'rowid', alias: free, column: null }
    : {
        kind: 'none',
        reason: 'las columnas rowid, _rowid_ y oid tapan el rowid de la tabla'
      }
}

async function indexes(
  s: SqliteQueryable,
  db: string,
  table: string,
  cols: XinfoRow[],
  alias: string | null
): Promise<IndexInfo[]> {
  const list = await s.query<Row>(
    'SELECT name, "unique" AS uq, origin, partial FROM pragma_index_list(?, ?) ORDER BY seq DESC',
    [table, db]
  )
  const sqls = await s.query<Row>(
    `SELECT name, sql FROM ${schemaTable(db)} WHERE type = 'index' AND tbl_name = ? COLLATE NOCASE`,
    [table]
  )
  const sqlOf = new Map(sqls.map((r) => [text(r.name), r.sql === null ? null : text(r.sql)]))
  const out: IndexInfo[] = []
  if (alias) {
    out.push({
      name: 'PRIMARY',
      unique: true,
      type: 'PRIMARY KEY',
      columns: [alias],
      comment: '',
      primary: true,
      definition: undefined,
      constraint: 'pk'
    })
  }
  for (const r of list) {
    const name = text(r.name)
    const origin = text(r.origin)
    const parts = await s.query<Row>(
      'SELECT name, cid, "desc" AS d FROM pragma_index_xinfo(?, ?) WHERE key = 1 ORDER BY seqno',
      [name, db]
    )
    out.push({
      name,
      unique: num(r.uq) === 1,
      type:
        origin === 'pk'
          ? 'PRIMARY KEY'
          : origin === 'u'
            ? 'UNIQUE'
            : num(r.partial)
              ? 'PARTIAL'
              : 'INDEX',
      columns: parts.map((p) =>
        p.name === null || p.name === undefined
          ? num(p.cid) === -1
            ? 'rowid'
            : '(expresión)'
          : text(p.name)
      ),
      comment: '',
      primary: origin === 'pk',
      definition: sqlOf.get(name) ?? undefined,
      constraint: origin === 'c' ? null : origin
    })
  }
  // A primary key without an index of its own (WITHOUT ROWID uses the table b-tree).
  if (!out.some((i) => i.primary)) {
    const pk = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name)
    if (pk.length)
      out.unshift({
        name: 'PRIMARY',
        unique: true,
        type: 'PRIMARY KEY',
        columns: pk,
        comment: '',
        primary: true,
        constraint: 'pk'
      })
  }
  return out
}

async function foreignKeys(
  s: SqliteQueryable,
  db: string,
  table: string,
  names: (string | null)[]
): Promise<ForeignKeyInfo[]> {
  const rows = await s.query<Row>(
    'SELECT id, seq, "table" AS ref, "from" AS src, "to" AS dst, on_update, on_delete FROM pragma_foreign_key_list(?, ?) ORDER BY id, seq',
    [table, db]
  )
  const byId = new Map<number, ForeignKeyInfo>()
  for (const r of rows) {
    const id = num(r.id)
    let fk = byId.get(id)
    if (!fk) {
      fk = {
        name: '',
        columns: [],
        referencedSchema: db,
        referencedTable: text(r.ref),
        referencedColumns: [],
        onUpdate: text(r.on_update, 'NO ACTION'),
        onDelete: text(r.on_delete, 'NO ACTION')
      }
      byId.set(id, fk)
    }
    fk.columns.push(text(r.src))
    if (r.dst !== null && r.dst !== undefined) fk.referencedColumns.push(text(r.dst))
  }
  // pragma ids count from the last FOREIGN KEY written; names come from the CREATE text.
  const list = [...byId.entries()].sort((a, b) => b[0] - a[0]).map(([, fk]) => fk)
  list.forEach((fk, i) => {
    fk.name = names[i] ?? `fk_${i + 1}`
  })
  return list
}

export async function tableStructure(
  s: SqliteQueryable,
  db: string,
  table: string
): Promise<TableStructure> {
  const entry = await tableEntry(s, db, table)
  if (!entry)
    throw new SqliteUserError(`La tabla ${table} no existe en ${db}.`, 'E_SQLITE_NO_TABLE')
  const cols = await xinfo(s, db, table)
  const alias = rowidAliasOf(cols, entry.wr)
  const auto = hasAutoincrement(entry.sql)
  const parsed = parseCreateTable(entry.sql)
  const kind: TableKind = entry.type === 'view' ? 'view' : 'table'
  // FK names in the order the CREATE text declares them (column-level and table-level).
  const fkNames: (string | null)[] = []
  for (const c of parsed.columns)
    for (const clause of c.clauses) if (clause.kind === 'references') fkNames.push(clause.name)
  for (const t of parsed.constraints) if (t.kind === 'foreign') fkNames.push(t.name)
  const constraints: ConstraintInfo[] = []
  for (const c of parsed.columns)
    for (const clause of c.clauses)
      if (clause.kind === 'check')
        constraints.push({
          name: clause.name ?? '',
          type: 'check',
          definition: clause.text.replace(/^CONSTRAINT\s+\S+\s+/i, ''),
          columns: [c.name]
        })
  for (const t of parsed.constraints)
    if (t.kind === 'check')
      constraints.push({
        name: t.name ?? '',
        type: 'check',
        definition: t.text.replace(/^CONSTRAINT\s+\S+\s+/i, ''),
        columns: []
      })
  const seqs = kind === 'table' ? await sequences(s, db) : new Map<string, number>()
  return {
    schema: db,
    name: table,
    tableType: kind === 'view' ? 'VIEW' : 'BASE TABLE',
    kind,
    columns: cols.filter((c) => c.hidden !== 1).map((c) => toColumnInfo(c, alias, auto)),
    indexes: kind === 'table' ? await indexes(s, db, table, cols, alias) : [],
    foreignKeys: kind === 'table' ? await foreignKeys(s, db, table, fkNames) : [],
    engine: null,
    collation: null,
    comment: '',
    autoIncrement: seqs.get(table.toLowerCase()) ?? null,
    createSql: entry.sql ?? '',
    constraints,
    options: {
      withoutRowid: entry.wr,
      strict: entry.strict,
      autoincrement: auto,
      virtual: entry.type === 'virtual'
    }
  }
}

/* ---------- DDL and drop ---------- */

const SCHEMA_TYPE: Partial<Record<EngineObjectType, string>> = {
  table: 'table',
  view: 'view',
  index: 'index',
  trigger: 'trigger'
}

/** Original DDL; a table also gets its indexes and triggers. */
export async function objectDdl(s: SqliteQueryable, db: string, ref: ObjectRef): Promise<string> {
  const type = SCHEMA_TYPE[ref.type]
  if (!type)
    throw new SqliteUserError(`SQLite no tiene objetos de tipo ${ref.type}.`, 'E_SQLITE_TYPE')
  const [row] = await s.query<Row>(
    `SELECT sql FROM ${schemaTable(db)} WHERE type = ? AND name = ? COLLATE NOCASE`,
    [type, ref.name]
  )
  if (!row || row.sql === null || row.sql === undefined)
    throw new SqliteUserError(`No se encontró ${ref.name} en ${db}.`, 'E_SQLITE_NO_OBJECT')
  const parts = [`${String(row.sql).trim()};`]
  if (type === 'table') {
    const extra = await s.query<Row>(
      `SELECT sql FROM ${schemaTable(db)}
        WHERE tbl_name = ? COLLATE NOCASE AND type IN ('index', 'trigger') AND sql IS NOT NULL
        ORDER BY type, name`,
      [ref.name]
    )
    for (const r of extra) parts.push(`${String(r.sql).trim()};`)
  }
  return parts.join('\n\n')
}

/** DROP TABLE|VIEW|INDEX|TRIGGER "db"."name". */
export function dropStatement(db: string, ref: ObjectRef): string {
  const type = SCHEMA_TYPE[ref.type]
  if (!type)
    throw new SqliteUserError(`SQLite no tiene objetos de tipo ${ref.type}.`, 'E_SQLITE_TYPE')
  return `DROP ${type.toUpperCase()} ${quoteIdent(db, true)}.${quoteIdent(ref.name, true)}`
}

/** Declared affinity of each column (for typed binds of edits). */
export function affinities(columns: ColumnInfo[]): Map<string, string> {
  return new Map(columns.map((c) => [c.name, affinityOf(c.columnType)]))
}

/** Row identity plus the generated columns of a table (results and grid). */
export interface TableMeta {
  identity: RowIdentity
  generated: Set<string>
}

export async function tableMeta(s: SqliteQueryable, db: string, table: string): Promise<TableMeta> {
  const identity = await rowIdentity(s, db, table)
  const cols = identity.kind === 'none' ? [] : await xinfo(s, db, table)
  return {
    identity,
    generated: new Set(cols.filter((c) => c.hidden === 2 || c.hidden === 3).map((c) => c.name))
  }
}
