import { describe, expect, it } from 'vitest'
import type { ColumnInfo, IndexInfo, QueryColumn } from '@shared/types'
import {
  REASON_COMPUTED,
  REASON_DUPLICATE_KEYS,
  REASON_MISMATCH,
  decideEditability,
  duplicateKeyRow,
  payloadColumns,
  primaryKeyOf,
  resultSource,
  type ResultSource
} from './resultEditability'

/** Column as main reports it for `<alias>.<source>` of accounts.user. */
function col(
  name: string,
  sourceName: string | undefined = name,
  extra: Partial<QueryColumn> = {}
): QueryColumn {
  return {
    name,
    type: 'VARCHAR',
    schema: 'accounts',
    table: 'user',
    tableAlias: 'u',
    ...(sourceName ? { sourceName } : {}),
    ...extra
  }
}

const pk = (...columns: string[]): IndexInfo => ({
  name: 'PRIMARY',
  unique: true,
  type: 'BTREE',
  columns,
  comment: ''
})
const column = (name: string, extra = ''): ColumnInfo => ({
  name,
  ordinal: 1,
  columnType: 'int',
  dataType: 'int',
  nullable: false,
  key: '',
  defaultValue: null,
  extra,
  characterSet: null,
  collation: null,
  comment: ''
})
const table = (indexes: IndexInfo[] = [pk('id')], columns: ColumnInfo[] = []) => ({
  tableType: 'BASE TABLE',
  indexes,
  columns
})
/** `FROM accounts.user AS u` */
const SRC: ResultSource = { schema: 'accounts', table: 'user', alias: 'u' }

describe('decideEditability', () => {
  it('accepts SELECT * from one table with an alias (Navicat behaviour)', () => {
    // SELECT * FROM accounts.user AS u WHERE u.email LIKE '%x%'
    const columns = [col('id'), col('email'), col('name')]
    expect(decideEditability(columns, SRC, table())).toEqual({
      editable: true,
      schema: 'accounts',
      table: 'user',
      primaryKey: ['id'],
      keyColumns: ['id'],
      generatedKeyColumn: null
    })
  })

  it('maps aliased columns (AS) back to their real names', () => {
    // SELECT id AS ident, email AS correo FROM accounts.user u
    const columns = [col('ident', 'id'), col('correo', 'email')]
    const decision = decideEditability(columns, SRC, table())
    expect(decision).toMatchObject({ editable: true, primaryKey: ['id'], keyColumns: ['ident'] })
    expect(payloadColumns(columns).map((c) => c.name)).toEqual(['id', 'email'])
  })

  it('matches key columns case-insensitively, keeping the result spelling', () => {
    const decision = decideEditability([col('ID', 'ID'), col('email')], SRC, table())
    expect(decision).toMatchObject({ editable: true, primaryKey: ['ID'] })
  })

  it('is read-only when a column comes from another table than the statement names', () => {
    const columns = [col('id'), col('total', 'total', { table: 'orders', tableAlias: 'o' })]
    expect(decideEditability(columns, SRC, table())).toMatchObject({
      editable: false,
      reason: REASON_MISMATCH
    })
  })

  it('is read-only when a column reports another alias (self-join)', () => {
    const columns = [col('id'), col('email', 'email', { tableAlias: 'v' })]
    expect(decideEditability(columns, SRC, table())).toMatchObject({
      editable: false,
      reason: REASON_MISMATCH
    })
  })

  it('is read-only when the metadata names another table than FROM (merged derived table)', () => {
    // SELECT * FROM items: but MySQL reports orgTable 'decoy' (cannot be trusted).
    const source: ResultSource = { schema: 'accounts', table: 'items', alias: 'items' }
    const columns = [col('id', 'id', { table: 'decoy', tableAlias: 'items' })]
    expect(decideEditability(columns, source, table())).toMatchObject({
      editable: false,
      reason: REASON_MISMATCH
    })
  })

  it('is read-only with an expression column', () => {
    // SELECT id, UPPER(email) AS e FROM accounts.user
    const columns = [col('id'), { name: 'e', type: 'VARCHAR' }]
    expect(decideEditability(columns, SRC, table())).toEqual({
      editable: false,
      reason: REASON_COMPUTED,
      schema: 'accounts',
      table: 'user'
    })
  })

  it('is read-only when the same column appears twice', () => {
    expect(decideEditability([col('id'), col('id2', 'id')], SRC, table())).toMatchObject({
      editable: false,
      reason: 'la misma columna aparece varias veces'
    })
  })

  it('is read-only for a view, before looking at its columns', () => {
    // A TEMPTABLE view or a view with aggregates reports base-table / computed columns.
    const columns = [col('id', 'id', { primaryKey: true }), { name: 'n', type: 'BIGINT' }]
    expect(decideEditability(columns, SRC, { tableType: 'VIEW', indexes: [] })).toEqual({
      editable: false,
      reason: 'el origen es una vista',
      schema: 'accounts',
      table: 'user'
    })
  })

  it('is read-only when a composite primary key is only partially selected', () => {
    const columns = [col('tenant_id'), col('email')]
    expect(decideEditability(columns, SRC, table([pk('tenant_id', 'id')]))).toMatchObject({
      editable: false,
      reason: 'falta la clave primaria completa en el resultado'
    })
    const full = decideEditability(
      [col('id'), col('tenant_id')],
      SRC,
      table([pk('tenant_id', 'id')])
    )
    expect(full).toMatchObject({ editable: true, primaryKey: ['tenant_id', 'id'] })
  })

  it('is read-only when the table has no primary key', () => {
    const unique: IndexInfo = { ...pk('email'), name: 'uq_email' }
    expect(decideEditability([col('id'), col('email')], SRC, table([unique]))).toMatchObject({
      editable: false,
      reason: 'la tabla no tiene clave primaria'
    })
  })

  it('is read-only when the table structure could not be read', () => {
    expect(decideEditability([col('id')], SRC, null)).toMatchObject({
      editable: false,
      reason: 'no se pudo comprobar la tabla'
    })
  })

  // Regression: two copies of one row got conflicting edits and the grid kept both.
  it('is read-only when the loaded rows repeat a key', () => {
    const rows = [
      [1, 'a'],
      [1, 'a'],
      [2, 'b']
    ]
    expect(decideEditability([col('id'), col('email')], SRC, table(), rows)).toMatchObject({
      editable: false,
      reason: REASON_DUPLICATE_KEYS
    })
    expect(duplicateKeyRow(rows, [0])).toBe(1)
    expect(duplicateKeyRow([[1], [2]], [0])).toBe(-1)
  })

  // Regression: an insert id was written into a PK that is not the AUTO_INCREMENT column.
  it('fills generated ids only into an AUTO_INCREMENT single-column key', () => {
    const columns = [col('code'), col('n'), col('v')]
    const uuidKey = table([pk('code')], [column('code'), column('n', 'auto_increment')])
    expect(decideEditability(columns, SRC, uuidKey)).toMatchObject({
      editable: true,
      generatedKeyColumn: null
    })
    const aiKey = table([pk('code')], [column('CODE', 'auto_increment')])
    expect(decideEditability(columns, SRC, aiKey)).toMatchObject({
      generatedKeyColumn: 'code'
    })
    const composite = table([pk('code', 'n')], [column('code', 'auto_increment')])
    expect(decideEditability(columns, SRC, composite)).toMatchObject({
      generatedKeyColumn: null
    })
  })
})

describe('resultSource / primaryKeyOf', () => {
  it('names the table the statement reads without touching the server', () => {
    const columns = [col('id'), col('email')]
    expect(resultSource(columns, "SELECT * FROM accounts.user AS u WHERE u.email LIKE '%x%'")).toEqual({
      ok: true,
      source: SRC
    })
    // Unqualified: the schema comes from the result; no alias: the table name.
    expect(resultSource(columns, 'SELECT * FROM user')).toEqual({
      ok: true,
      source: { schema: 'accounts', table: 'user', alias: 'user' }
    })
    expect(resultSource([], 'SELECT * FROM user')).toMatchObject({ ok: false })
  })

  it('stays read-only for statements that are not a plain single-table SELECT', () => {
    const columns = [col('id'), col('email')]
    expect(resultSource(columns, 'SELECT * FROM (SELECT * FROM user) u')).toMatchObject({
      ok: false,
      reason: 'la consulta lee de una subconsulta'
    })
    expect(
      resultSource(columns, 'SELECT u.* FROM user u JOIN orders o ON o.user_id = u.id')
    ).toMatchObject({ ok: false, reason: 'la consulta usa varias tablas' })
    expect(resultSource([{ name: 'n', type: 'BIGINT' }], 'SELECT COUNT(*) FROM user')).toEqual({
      ok: false,
      reason: REASON_COMPUTED
    })
  })

  it('returns the PRIMARY index columns in order', () => {
    expect(primaryKeyOf({ indexes: [{ ...pk('x'), name: 'idx' }, pk('b', 'a')] })).toEqual([
      'b',
      'a'
    ])
    expect(primaryKeyOf({ indexes: [] })).toEqual([])
  })
})
