/**
 * Structure-only reader for the AI assistant.
 *
 * PRIVACY: this is the only way the assistant reads a database. It goes
 * through `MetadataQueryable`, which refuses any statement that is not a
 * SELECT over information_schema (or `SELECT VERSION()`), so a bug in the
 * context builder cannot read table rows. Only names, types, keys, indexes,
 * foreign keys, routine signatures and row-count estimates leave this file;
 * column defaults, view bodies, routine bodies and trigger statements are not
 * read at all.
 */

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
}

const METADATA_SQL = /^\s*SELECT\b[\s\S]*\bFROM\s+information_schema\.[A-Z_]+\b/i
const VERSION_SQL = /^\s*SELECT\s+VERSION\(\)\s+AS\s+version\s*$/i
/** Anything that could reach user tables or change state, even inside an information_schema query. */
const FORBIDDEN = /;|\b(INTO|UPDATE|DELETE|INSERT|REPLACE|DROP|ALTER|CREATE|CALL|HANDLER|LOAD)\b/i

export class MetadataOnlyError extends Error {
  constructor() {
    super('El asistente de IA solo puede leer la estructura (information_schema).')
    this.name = 'MetadataOnlyError'
  }
}

/** True when `sql` may run through the metadata reader. */
export function isMetadataSql(sql: string): boolean {
  if (VERSION_SQL.test(sql)) return true
  if (!METADATA_SQL.test(sql) || FORBIDDEN.test(sql)) return false
  // Every FROM / JOIN target must be an information_schema table.
  const targets = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([`\w.]+)/gi)].map((m) =>
    m[1].replace(/`/g, '')
  )
  return targets.length > 0 && targets.every((t) => /^information_schema\.\w+$/i.test(t))
}

/** Wraps a session so only metadata statements reach the server. */
export class MetadataQueryable implements Queryable {
  constructor(private readonly inner: Queryable) {}
  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    if (!isMetadataSql(sql)) throw new MetadataOnlyError()
    return this.inner.query<T>(sql, params)
  }
}

export interface ColumnMeta {
  name: string
  type: string
  nullable: boolean
  key: string
  extra: string
  comment: string
}

export interface IndexMeta {
  name: string
  unique: boolean
  columns: string[]
}

export interface ForeignKeyMeta {
  name: string
  columns: string[]
  refSchema: string
  refTable: string
  refColumns: string[]
}

export interface TableMeta {
  name: string
  kind: 'table' | 'view'
  rows: number | null
  comment: string
  columns: ColumnMeta[]
  indexes: IndexMeta[]
  foreignKeys: ForeignKeyMeta[]
}

export interface RoutineMeta {
  name: string
  type: 'FUNCTION' | 'PROCEDURE'
  params: string[]
  returns: string | null
}

export interface SchemaSnapshot {
  schema: string
  serverVersion: string
  tables: TableMeta[]
  routines: RoutineMeta[]
}

type Row = Record<string, unknown>

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const byName = <T extends { name: string }>(a: T, b: T): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0

/** Server version (e.g. "8.4.3"), '' when unavailable. */
export async function readServerVersion(q: MetadataQueryable): Promise<string> {
  try {
    const [row] = await q.query<Row>('SELECT VERSION() AS version')
    return str(row?.version)
  } catch {
    return ''
  }
}

/**
 * Reads the structure of `schema` (all tables, or only `only` when given).
 * Five information_schema queries, whatever the number of tables.
 */
export async function readSchemaSnapshot(
  q: MetadataQueryable,
  schema: string,
  only?: string[]
): Promise<SchemaSnapshot> {
  const filter = only && only.length ? only : null
  const tableClause = filter ? ` AND TABLE_NAME IN (${filter.map(() => '?').join(', ')})` : ''
  const params = (): unknown[] => [schema, ...(filter ?? [])]

  const [tableRows, columnRows, indexRows, fkRows, routineRows, paramRows, version] =
    await Promise.all([
      q.query<Row>(
        `SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ?${tableClause} ORDER BY TABLE_NAME`,
        params()
      ),
      q.query<Row>(
        `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA, COLUMN_COMMENT
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ?${tableClause} ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        params()
      ),
      q.query<Row>(
        `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ?${tableClause} ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
        params()
      ),
      q.query<Row>(
        `SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA,
                REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = ?${tableClause} AND REFERENCED_TABLE_NAME IS NOT NULL
          ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
        params()
      ),
      filter
        ? Promise.resolve([] as Row[])
        : q.query<Row>(
            `SELECT ROUTINE_NAME, ROUTINE_TYPE, DTD_IDENTIFIER FROM information_schema.ROUTINES
              WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME`,
            [schema]
          ),
      filter
        ? Promise.resolve([] as Row[])
        : q.query<Row>(
            `SELECT SPECIFIC_NAME, ROUTINE_TYPE, PARAMETER_MODE, PARAMETER_NAME, DTD_IDENTIFIER
               FROM information_schema.PARAMETERS
              WHERE SPECIFIC_SCHEMA = ? AND ORDINAL_POSITION > 0
              ORDER BY SPECIFIC_NAME, ORDINAL_POSITION`,
            [schema]
          ),
      readServerVersion(q)
    ])

  const tables = new Map<string, TableMeta>()
  // MariaDB sequences are TABLE_TYPE 'SEQUENCE': named, without their internal columns.
  const sequences = new Set<string>()
  for (const r of tableRows) {
    const name = str(r.TABLE_NAME)
    const view = /VIEW/i.test(str(r.TABLE_TYPE))
    const sequence = /^SEQUENCE$/i.test(str(r.TABLE_TYPE))
    if (sequence) sequences.add(name)
    tables.set(name, {
      name,
      kind: view ? 'view' : 'table',
      rows: view || sequence ? null : num(r.TABLE_ROWS),
      comment: sequence
        ? 'secuencia de MariaDB: NEXTVAL(nombre), SETVAL(nombre, n)'
        : view
          ? ''
          : str(r.TABLE_COMMENT),
      columns: [],
      indexes: [],
      foreignKeys: []
    })
  }
  for (const r of columnRows) {
    if (sequences.has(str(r.TABLE_NAME))) continue
    tables.get(str(r.TABLE_NAME))?.columns.push({
      name: str(r.COLUMN_NAME),
      type: str(r.COLUMN_TYPE),
      nullable: str(r.IS_NULLABLE).toUpperCase() === 'YES',
      key: str(r.COLUMN_KEY),
      extra: str(r.EXTRA),
      comment: str(r.COLUMN_COMMENT)
    })
  }
  for (const r of indexRows) {
    const t = tables.get(str(r.TABLE_NAME))
    if (!t) continue
    const name = str(r.INDEX_NAME)
    let idx = t.indexes.find((i) => i.name === name)
    if (!idx) {
      idx = { name, unique: num(r.NON_UNIQUE) === 0, columns: [] }
      t.indexes.push(idx)
    }
    idx.columns.push(str(r.COLUMN_NAME) || '(expr)')
  }
  for (const r of fkRows) {
    const t = tables.get(str(r.TABLE_NAME))
    if (!t) continue
    const name = str(r.CONSTRAINT_NAME)
    let fk = t.foreignKeys.find((f) => f.name === name)
    if (!fk) {
      fk = {
        name,
        columns: [],
        refSchema: str(r.REFERENCED_TABLE_SCHEMA),
        refTable: str(r.REFERENCED_TABLE_NAME),
        refColumns: []
      }
      t.foreignKeys.push(fk)
    }
    fk.columns.push(str(r.COLUMN_NAME))
    fk.refColumns.push(str(r.REFERENCED_COLUMN_NAME))
  }

  const routineParams = new Map<string, string[]>()
  for (const r of paramRows) {
    const key = `${str(r.ROUTINE_TYPE).toUpperCase()}:${str(r.SPECIFIC_NAME)}`
    const mode = str(r.PARAMETER_MODE)
    const label = `${mode && mode !== 'IN' ? `${mode} ` : ''}${str(r.PARAMETER_NAME)} ${str(r.DTD_IDENTIFIER)}`
    routineParams.set(key, [...(routineParams.get(key) ?? []), label.trim()])
  }
  const routines: RoutineMeta[] = routineRows.map((r) => {
    const type = str(r.ROUTINE_TYPE).toUpperCase() === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE'
    const name = str(r.ROUTINE_NAME)
    return {
      name,
      type,
      params: routineParams.get(`${type}:${name}`) ?? [],
      returns: type === 'FUNCTION' ? str(r.DTD_IDENTIFIER) || null : null
    }
  })

  return {
    schema,
    serverVersion: version,
    tables: [...tables.values()].sort(byName),
    routines: routines.sort(byName)
  }
}
