import { describe, expect, it } from 'vitest'
import type { ColumnInfo, IndexInfo, TableStructure } from '@shared/types'
import { columnKindOf } from '@renderer/components/data/columnKind'
import { decideEditability, primaryKeyOf } from '@renderer/components/query/resultEditability'
import { draftFromStructure } from './tableDesigner'
import {
  isAutoIncrementColumn,
  isNumericKind,
  isPrimaryKeyColumn,
  isTemporalKind,
  isViewLike
} from './columnMeta'

const column = (name: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  ordinal: 1,
  columnType: 'int4',
  dataType: 'int4',
  nullable: false,
  key: '',
  defaultValue: null,
  extra: '',
  characterSet: null,
  collation: null,
  comment: '',
  ...extra
})

const index = (name: string, columns: string[], extra: Partial<IndexInfo> = {}): IndexInfo => ({
  name,
  unique: true,
  type: 'btree',
  columns,
  comment: '',
  ...extra
})

describe('neutral metadata with MySQL fallback', () => {
  it('classifies type kinds', () => {
    expect(['integer', 'decimal', 'float'].every((k) => isNumericKind(k as never))).toBe(true)
    expect(['date', 'time', 'datetime'].every((k) => isTemporalKind(k as never))).toBe(true)
    expect(isNumericKind('text')).toBe(false)
    expect(isTemporalKind('json')).toBe(false)
  })

  it('reads autoIncrement / primaryKey when present, MySQL EXTRA / COLUMN_KEY otherwise', () => {
    expect(isAutoIncrementColumn(column('id', { extra: 'auto_increment' }))).toBe(true)
    expect(isAutoIncrementColumn(column('id', { autoIncrement: true }))).toBe(true)
    // The neutral flag wins over a stray MySQL string.
    expect(
      isAutoIncrementColumn(column('id', { autoIncrement: false, extra: 'auto_increment' }))
    ).toBe(false)
    expect(isPrimaryKeyColumn(column('id', { key: 'PRI' }))).toBe(true)
    expect(isPrimaryKeyColumn(column('id', { primaryKey: true }))).toBe(true)
    expect(isPrimaryKeyColumn(column('id', { primaryKey: false, key: 'PRI' }))).toBe(false)
  })

  it('reads kind when present, TABLE_TYPE otherwise', () => {
    expect(isViewLike({ tableType: 'BASE TABLE' })).toBe(false)
    expect(isViewLike({ tableType: 'VIEW' })).toBe(true)
    expect(isViewLike({ tableType: 'SYSTEM VIEW' })).toBe(true)
    expect(isViewLike({})).toBe(false)
    expect(isViewLike({ kind: 'table', tableType: 'VIEW' })).toBe(false)
    expect(isViewLike({ kind: 'partitioned' })).toBe(false)
    expect(isViewLike({ kind: 'view' })).toBe(true)
    expect(isViewLike({ kind: 'materialized-view' })).toBe(true)
  })

  it('columnKindOf uses typeKind and falls back to the MySQL type name', () => {
    expect(columnKindOf({ type: 'int4', typeKind: 'integer' })).toBe('number')
    expect(columnKindOf({ type: 'timestamptz', typeKind: 'datetime' })).toBe('temporal')
    expect(columnKindOf({ type: 'INT', typeKind: 'text' })).toBe('text')
    expect(columnKindOf({ type: 'BIGINT UNSIGNED' })).toBe('number')
    expect(columnKindOf({ type: 'DATETIME' })).toBe('temporal')
    expect(columnKindOf({ type: 'int4' })).toBe('text')
  })
})

describe('primary key detection', () => {
  it('uses IndexInfo.primary when the driver sets it (PostgreSQL names its key users_pkey)', () => {
    const structure = {
      indexes: [index('users_email', ['email']), index('users_pkey', ['id'], { primary: true })]
    }
    expect(primaryKeyOf(structure)).toEqual(['id'])
    expect(primaryKeyOf({ indexes: [index('PRIMARY', ['id'], { primary: false })] })).toEqual([])
    expect(primaryKeyOf({ indexes: [index('PRIMARY', ['id'])] })).toEqual(['id'])
  })

  it('the designer reads the neutral flags the same way', () => {
    const structure: TableStructure = {
      schema: 'public',
      name: 'users',
      kind: 'table',
      columns: [column('id', { primaryKey: true, autoIncrement: true }), column('email')],
      indexes: [index('users_pkey', ['id'], { primary: true }), index('users_email', ['email'])],
      foreignKeys: [],
      engine: null,
      collation: null,
      comment: '',
      autoIncrement: null,
      createSql: ''
    }
    const draft = draftFromStructure(structure)
    expect(draft.columns.map((c) => [c.name, c.primaryKey, c.autoIncrement])).toEqual([
      ['id', true, true],
      ['email', false, false]
    ])
    expect(draft.indexes.map((i) => i.name)).toEqual(['users_email'])
  })
})

describe('result editability with neutral metadata', () => {
  const col = (name: string) => ({
    name,
    type: 'int4',
    schema: 'public',
    table: 'users',
    tableAlias: 'users',
    sourceName: name
  })
  const source = { schema: 'public', table: 'users', alias: 'users' }

  it('refuses views by kind and finds the key and identity column by flag', () => {
    const indexes = [index('users_pkey', ['id'], { primary: true })]
    expect(
      decideEditability([col('id')], source, { kind: 'materialized-view', indexes }, [[1]])
    ).toMatchObject({ editable: false, reason: 'el origen es una vista' })
    const decision = decideEditability(
      [col('id'), col('name')],
      source,
      { kind: 'table', indexes, columns: [column('id', { autoIncrement: true })] },
      [[1, 'a']]
    )
    expect(decision).toMatchObject({
      editable: true,
      primaryKey: ['id'],
      generatedKeyColumn: 'id'
    })
  })
})
