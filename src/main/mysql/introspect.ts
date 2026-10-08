import type {
  ColumnInfo,
  DatabaseInfo,
  EventInfo,
  ForeignKeyInfo,
  IndexInfo,
  ObjectSummary,
  ObjectType,
  RoutineInfo,
  ServerInfo,
  TableInfo,
  TableStructure,
  TriggerInfo,
  ViewInfo
} from '@shared/types'
import { MysqlUserError } from './errors'
import { isSystemSchema } from '@shared/restoreTask'
import { detectMysqlFlavor, mysqlReturning, mysqlVersionNumber } from '@shared/serverFlavor'
import type { EngineId } from '@shared/types'
import {
  MARIADB_COLUMN_CHECKS_SQL,
  MARIADB_FULL_COLLATIONS_SQL,
  MARIADB_LIST_TABLES_SQL,
  isMariaDbSession,
  jsonColumnsFromChecks,
  listMariaDbSequences,
  unquoteMariaDbDefault
} from './mariadb'

/** The subset of MysqlSession introspection needs (also satisfied by a bare connection). */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  /**
   * VERSION() of the server when known (sessions carry it). A MariaDB version
   * turns on the P1b fixes; absent or MySQL keeps the v0.1.x SQL unchanged.
   */
  readonly serverVersion?: string
}

type Row = Record<string, unknown>

const IDENT_RE = /^[A-Za-z0-9_]+$/

export function escapeId(identifier: string): string {
  return '`' + String(identifier).replace(/`/g, '``') + '`'
}

function qualified(schema: string, name: string): string {
  return `${escapeId(schema)}.${escapeId(name)}`
}

function text(value: unknown, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value)
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function yes(value: unknown): boolean {
  const v = text(value).toUpperCase()
  return v === 'YES' || v === 'Y' || v === '1' || v === 'TRUE'
}

/* ---------- server ---------- */

export async function fetchServerInfo(
  q: Queryable,
  target: { host: string; port: number; username: string; engine?: EngineId }
): Promise<ServerInfo> {
  const [vars] = await q.query<Row>(
    'SELECT VERSION() AS version, @@version_comment AS versionComment, @@character_set_server AS characterSet'
  )
  const status = await q.query<Row>(
    "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime', 'Threads_connected')"
  )
  const byName = new Map(status.map((r) => [text(r.Variable_name), text(r.Value)]))
  const version = text(vars?.version)
  return {
    version,
    versionComment: text(vars?.versionComment),
    host: target.host,
    port: target.port,
    username: target.username,
    characterSet: text(vars?.characterSet),
    uptimeSeconds: numberOrNull(byName.get('Uptime')) ?? 0,
    threadsConnected: numberOrNull(byName.get('Threads_connected')) ?? 0,
    engine: target.engine ?? 'mysql',
    // Derived from VERSION() above: no extra query, the MySQL SQL is unchanged.
    runtime: {
      flavor: detectMysqlFlavor(version),
      versionNumber: mysqlVersionNumber(version),
      transactions: true,
      returning: mysqlReturning(version)
    }
  }
}

/* ---------- databases ---------- */

export async function listDatabases(q: Queryable): Promise<DatabaseInfo[]> {
  const rows = await q.query<Row>(
    `SELECT SCHEMA_NAME AS name, DEFAULT_CHARACTER_SET_NAME AS characterSet, DEFAULT_COLLATION_NAME AS collation
       FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME`
  )
  return rows.map((r) => ({
    name: text(r.name),
    characterSet: text(r.characterSet),
    collation: text(r.collation)
  }))
}

export async function createDatabase(
  q: Queryable,
  name: string,
  charset: string,
  collation: string
): Promise<void> {
  if (!name.trim()) throw new MysqlUserError('El nombre de la base de datos no puede estar vacío')
  if (charset && !IDENT_RE.test(charset))
    throw new MysqlUserError(`Juego de caracteres no válido: ${charset}`)
  if (collation && !IDENT_RE.test(collation))
    throw new MysqlUserError(`Collation no válida: ${collation}`)
  let sql = `CREATE DATABASE ${escapeId(name)}`
  if (charset) sql += ` CHARACTER SET ${charset}`
  if (collation) sql += ` COLLATE ${collation}`
  await q.query(sql)
}

export async function dropDatabase(q: Queryable, name: string): Promise<void> {
  if (!name.trim()) throw new MysqlUserError('El nombre de la base de datos no puede estar vacío')
  if (isSystemSchema(name)) {
    throw new MysqlUserError(`La base de datos del sistema ${name} no se puede eliminar`)
  }
  await q.query(`DROP DATABASE ${escapeId(name)}`)
}

/* ---------- objects ---------- */

export async function listTables(q: Queryable, schema: string): Promise<TableInfo[]> {
  if (isMariaDbSession(q)) return mapTables(await q.query<Row>(MARIADB_LIST_TABLES_SQL, [schema]))
  const rows = await q.query<Row>(
    `SELECT TABLE_NAME, ENGINE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, AUTO_INCREMENT,
            CREATE_TIME, UPDATE_TIME, TABLE_COLLATION, TABLE_COMMENT
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME`,
    [schema]
  )
  return mapTables(rows)
}

function mapTables(rows: Row[]): TableInfo[] {
  return rows.map((r) => ({
    name: text(r.TABLE_NAME),
    engine: textOrNull(r.ENGINE),
    rows: numberOrNull(r.TABLE_ROWS),
    dataLength: numberOrNull(r.DATA_LENGTH),
    indexLength: numberOrNull(r.INDEX_LENGTH),
    autoIncrement: numberOrNull(r.AUTO_INCREMENT),
    createTime: textOrNull(r.CREATE_TIME),
    updateTime: textOrNull(r.UPDATE_TIME),
    collation: textOrNull(r.TABLE_COLLATION),
    comment: text(r.TABLE_COMMENT)
  }))
}

export async function listViews(q: Queryable, schema: string): Promise<ViewInfo[]> {
  const rows = await q.query<Row>(
    `SELECT v.TABLE_NAME, v.DEFINER, v.SECURITY_TYPE, v.IS_UPDATABLE, t.CREATE_TIME
       FROM information_schema.VIEWS v
       LEFT JOIN information_schema.TABLES t
         ON t.TABLE_SCHEMA = v.TABLE_SCHEMA AND t.TABLE_NAME = v.TABLE_NAME
      WHERE v.TABLE_SCHEMA = ?
      ORDER BY v.TABLE_NAME`,
    [schema]
  )
  return rows.map((r) => ({
    name: text(r.TABLE_NAME),
    definer: text(r.DEFINER),
    security: text(r.SECURITY_TYPE),
    updatable: yes(r.IS_UPDATABLE),
    createTime: textOrNull(r.CREATE_TIME)
  }))
}

export async function listRoutines(q: Queryable, schema: string): Promise<RoutineInfo[]> {
  const rows = await q.query<Row>(
    `SELECT ROUTINE_NAME, ROUTINE_TYPE, DEFINER, DTD_IDENTIFIER, CREATED, LAST_ALTERED, ROUTINE_COMMENT
       FROM information_schema.ROUTINES
      WHERE ROUTINE_SCHEMA = ?
      ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
    [schema]
  )
  return rows.map((r) => ({
    name: text(r.ROUTINE_NAME),
    type: text(r.ROUTINE_TYPE).toUpperCase() === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE',
    definer: text(r.DEFINER),
    returns: textOrNull(r.DTD_IDENTIFIER),
    created: textOrNull(r.CREATED),
    modified: textOrNull(r.LAST_ALTERED),
    comment: text(r.ROUTINE_COMMENT)
  }))
}

export async function listEvents(q: Queryable, schema: string): Promise<EventInfo[]> {
  const rows = await q.query<Row>(
    `SELECT EVENT_NAME, DEFINER, STATUS, EVENT_TYPE, EXECUTE_AT, INTERVAL_VALUE, INTERVAL_FIELD,
            STARTS, ENDS, CREATED, LAST_ALTERED, EVENT_COMMENT
       FROM information_schema.EVENTS
      WHERE EVENT_SCHEMA = ?
      ORDER BY EVENT_NAME`,
    [schema]
  )
  return rows.map((r) => ({
    name: text(r.EVENT_NAME),
    definer: text(r.DEFINER),
    status: text(r.STATUS),
    type: text(r.EVENT_TYPE),
    executeAt: textOrNull(r.EXECUTE_AT),
    intervalValue: textOrNull(r.INTERVAL_VALUE),
    intervalField: textOrNull(r.INTERVAL_FIELD),
    starts: textOrNull(r.STARTS),
    ends: textOrNull(r.ENDS),
    created: textOrNull(r.CREATED),
    modified: textOrNull(r.LAST_ALTERED),
    comment: text(r.EVENT_COMMENT)
  }))
}

export async function listTriggers(q: Queryable, schema: string): Promise<TriggerInfo[]> {
  const rows = await q.query<Row>(
    `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, EVENT_MANIPULATION, ACTION_TIMING, ACTION_STATEMENT, DEFINER
       FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = ?
      ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER, TRIGGER_NAME`,
    [schema]
  )
  return rows.map((r) => ({
    name: text(r.TRIGGER_NAME),
    table: text(r.EVENT_OBJECT_TABLE),
    event: text(r.EVENT_MANIPULATION),
    timing: text(r.ACTION_TIMING),
    statement: text(r.ACTION_STATEMENT),
    definer: text(r.DEFINER)
  }))
}

/* ---------- table structure ---------- */

export async function listColumns(
  q: Queryable,
  schema: string,
  table: string
): Promise<ColumnInfo[]> {
  const rows = await q.query<Row>(
    `SELECT COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT,
            EXTRA, CHARACTER_SET_NAME, COLLATION_NAME, COLUMN_COMMENT
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [schema, table]
  )
  const columns = rows.map((r): ColumnInfo => ({
    name: text(r.COLUMN_NAME),
    ordinal: numberOrNull(r.ORDINAL_POSITION) ?? 0,
    columnType: text(r.COLUMN_TYPE),
    dataType: text(r.DATA_TYPE),
    nullable: yes(r.IS_NULLABLE),
    key: text(r.COLUMN_KEY),
    defaultValue: textOrNull(r.COLUMN_DEFAULT),
    extra: text(r.EXTRA),
    characterSet: textOrNull(r.CHARACTER_SET_NAME),
    collation: textOrNull(r.COLLATION_NAME),
    comment: text(r.COLUMN_COMMENT)
  }))
  if (!isMariaDbSession(q)) return columns
  // MariaDB: JSON is LONGTEXT plus a json_valid() column check; report it as json.
  const json = columns.some((c) => c.dataType.toLowerCase() === 'longtext')
    ? await mariaDbJsonColumns(q, schema, table)
    : new Set<string>()
  // MariaDB: 'NULL' / quoted literals in COLUMN_DEFAULT, INVISIBLE columns hidden from SELECT *.
  return columns.map((c) => ({
    ...c,
    ...(json.has(c.name) ? { dataType: 'json', columnType: 'json' } : {}),
    defaultValue: unquoteMariaDbDefault(c.defaultValue),
    hidden: /\bINVISIBLE\b/i.test(c.extra)
  }))
}

/** Columns of a MariaDB table declared JSON (best effort: [] when the catalog lacks the view). */
async function mariaDbJsonColumns(
  q: Queryable,
  schema: string,
  table: string
): Promise<Set<string>> {
  try {
    return jsonColumnsFromChecks(
      await q.query<{ name: unknown; clause: unknown }>(MARIADB_COLUMN_CHECKS_SQL, [schema, table])
    )
  } catch {
    return new Set()
  }
}

export async function listIndexes(
  q: Queryable,
  schema: string,
  table: string
): Promise<IndexInfo[]> {
  const rows = await q.query<Row>(
    `SELECT INDEX_NAME, NON_UNIQUE, INDEX_TYPE, COLUMN_NAME, SEQ_IN_INDEX, INDEX_COMMENT
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY (INDEX_NAME = 'PRIMARY') DESC, INDEX_NAME, SEQ_IN_INDEX`,
    [schema, table]
  )
  const byName = new Map<string, IndexInfo>()
  for (const r of rows) {
    const name = text(r.INDEX_NAME)
    let idx = byName.get(name)
    if (!idx) {
      idx = {
        name,
        unique: numberOrNull(r.NON_UNIQUE) === 0,
        type: text(r.INDEX_TYPE),
        columns: [],
        comment: text(r.INDEX_COMMENT)
      }
      byName.set(name, idx)
    }
    idx.columns.push(text(r.COLUMN_NAME, '(expression)'))
  }
  return [...byName.values()]
}

/** Primary key column names in key order (empty when the table has none). */
export async function primaryKeyColumns(
  q: Queryable,
  schema: string,
  table: string
): Promise<string[]> {
  const rows = await q.query<Row>(
    `SELECT COLUMN_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
      ORDER BY SEQ_IN_INDEX`,
    [schema, table]
  )
  return rows.map((r) => text(r.COLUMN_NAME))
}

export async function listForeignKeys(
  q: Queryable,
  schema: string,
  table: string
): Promise<ForeignKeyInfo[]> {
  const rows = await q.query<Row>(
    `SELECT rc.CONSTRAINT_NAME, kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME,
            kcu.REFERENCED_COLUMN_NAME, rc.UPDATE_RULE, rc.DELETE_RULE
       FROM information_schema.REFERENTIAL_CONSTRAINTS rc
       JOIN information_schema.KEY_COLUMN_USAGE kcu
         ON kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
        AND kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
        AND kcu.TABLE_NAME = rc.TABLE_NAME
      WHERE rc.CONSTRAINT_SCHEMA = ? AND rc.TABLE_NAME = ?
      ORDER BY rc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
    [schema, table]
  )
  const byName = new Map<string, ForeignKeyInfo>()
  for (const r of rows) {
    const name = text(r.CONSTRAINT_NAME)
    let fk = byName.get(name)
    if (!fk) {
      fk = {
        name,
        columns: [],
        referencedSchema: text(r.REFERENCED_TABLE_SCHEMA),
        referencedTable: text(r.REFERENCED_TABLE_NAME),
        referencedColumns: [],
        onUpdate: text(r.UPDATE_RULE),
        onDelete: text(r.DELETE_RULE)
      }
      byName.set(name, fk)
    }
    fk.columns.push(text(r.COLUMN_NAME))
    fk.referencedColumns.push(text(r.REFERENCED_COLUMN_NAME))
  }
  return [...byName.values()]
}

export async function tableStructure(
  q: Queryable,
  schema: string,
  table: string
): Promise<TableStructure> {
  const [meta] = await q.query<Row>(
    `SELECT TABLE_TYPE, ENGINE, TABLE_COLLATION, TABLE_COMMENT, AUTO_INCREMENT
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [schema, table]
  )
  if (!meta) throw new MysqlUserError(`La tabla ${schema}.${table} no existe`)
  const [columns, indexes, foreignKeys, createSql] = await Promise.all([
    listColumns(q, schema, table),
    listIndexes(q, schema, table),
    listForeignKeys(q, schema, table),
    showCreate(q, schema, 'table', table)
  ])
  const tableType = text(meta.TABLE_TYPE)
  return {
    schema,
    name: table,
    tableType,
    // MariaDB only: system-versioned tables are editable tables (kind says so to the renderer).
    ...(isMariaDbSession(q)
      ? {
          kind:
            tableType === 'SYSTEM VERSIONED'
              ? ('system-versioned' as const)
              : tableType === 'VIEW'
                ? ('view' as const)
                : ('table' as const)
        }
      : {}),
    columns,
    indexes,
    foreignKeys,
    engine: textOrNull(meta.ENGINE),
    collation: textOrNull(meta.TABLE_COLLATION),
    comment: text(meta.TABLE_COMMENT),
    autoIncrement: numberOrNull(meta.AUTO_INCREMENT),
    createSql
  }
}

/* ---------- DDL helpers ---------- */

const SHOW_CREATE_KEYWORD: Record<ObjectType, string> = {
  table: 'TABLE',
  view: 'VIEW',
  function: 'FUNCTION',
  procedure: 'PROCEDURE',
  event: 'EVENT',
  trigger: 'TRIGGER'
}

const OBJECT_LABEL: Record<ObjectType, string> = {
  table: 'La tabla',
  view: 'La vista',
  function: 'La función',
  procedure: 'El procedimiento',
  event: 'El evento',
  trigger: 'El trigger'
}

function assertObjectType(type: ObjectType): void {
  if (!(type in SHOW_CREATE_KEYWORD))
    throw new MysqlUserError(`Tipo de objeto no soportado: ${String(type)}`)
}

export async function showCreate(
  q: Queryable,
  schema: string,
  type: ObjectType,
  name: string
): Promise<string> {
  assertObjectType(type)
  const rows = await q.query<Row>(
    `SHOW CREATE ${SHOW_CREATE_KEYWORD[type]} ${qualified(schema, name)}`
  )
  const row = rows[0]
  if (!row) throw new MysqlUserError(`${OBJECT_LABEL[type]} ${schema}.${name} no existe`)
  const key = Object.keys(row).find((k) => /^create /i.test(k) || k === 'SQL Original Statement')
  const ddl = key ? row[key] : null
  if (ddl === null || ddl === undefined) {
    throw new MysqlUserError(
      `No se pudo obtener la definición de ${schema}.${name} (sin privilegios suficientes)`
    )
  }
  return String(ddl)
}

export async function dropObject(
  q: Queryable,
  schema: string,
  type: ObjectType,
  name: string
): Promise<void> {
  assertObjectType(type)
  await q.query(`DROP ${SHOW_CREATE_KEYWORD[type]} ${qualified(schema, name)}`)
}

/** Sequences exist only on MariaDB servers (MariaDB engine, P5). */
function assertMariaDbSequences(q: Queryable): void {
  if (!isMariaDbSession(q))
    throw new MysqlUserError('Las secuencias solo existen en servidores MariaDB')
}

/** SHOW CREATE SEQUENCE (MariaDB). */
export async function showCreateSequence(
  q: Queryable,
  schema: string,
  name: string
): Promise<string> {
  assertMariaDbSequences(q)
  const rows = await q.query<Row>(`SHOW CREATE SEQUENCE ${qualified(schema, name)}`)
  const row = rows[0]
  const key = row ? Object.keys(row).find((k) => /^create /i.test(k)) : undefined
  if (!row || !key || row[key] === null || row[key] === undefined)
    throw new MysqlUserError(`La secuencia ${schema}.${name} no existe`)
  return String(row[key])
}

export async function dropSequence(q: Queryable, schema: string, name: string): Promise<void> {
  assertMariaDbSequences(q)
  await q.query(`DROP SEQUENCE ${qualified(schema, name)}`)
}

/** Sequences of a database (MariaDB); [] on MySQL servers. */
export async function listSequences(q: Queryable, schema: string): Promise<ObjectSummary[]> {
  if (!isMariaDbSession(q)) return []
  return listMariaDbSequences(q, schema)
}

/* ---------- charsets ---------- */

export interface CharsetInfo {
  charset: string
  defaultCollation: string
  collations: string[]
}

export async function listCharsets(q: Queryable): Promise<CharsetInfo[]> {
  const [charsets, collations] = await Promise.all([
    q.query<Row>('SHOW CHARACTER SET'),
    q.query<Row>('SHOW COLLATION')
  ])
  const byCharset = new Map<string, CharsetInfo>()
  for (const r of charsets) {
    const name = text(r.Charset)
    byCharset.set(name, {
      charset: name,
      defaultCollation: text(r['Default collation']),
      collations: []
    })
  }
  for (const r of collations) {
    const cs = byCharset.get(text(r.Charset))
    if (cs) cs.collations.push(text(r.Collation))
  }
  // MariaDB 11: UCA 14.0 collations are charset-independent in SHOW COLLATION; their full
  // names (utf8mb4_uca1400_ai_ci, the default) come from the applicability table.
  if (isMariaDbSession(q)) {
    const full = await q.query<Row>(MARIADB_FULL_COLLATIONS_SQL).catch(() => [] as Row[])
    for (const r of full) {
      const cs = byCharset.get(text(r.charset))
      const name = text(r.collation)
      if (cs && name && !cs.collations.includes(name)) cs.collations.push(name)
    }
  }
  const list = [...byCharset.values()].sort((a, b) => a.charset.localeCompare(b.charset))
  for (const cs of list) cs.collations.sort()
  return list
}
