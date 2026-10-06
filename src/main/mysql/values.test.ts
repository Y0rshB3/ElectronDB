import { describe, expect, it } from 'vitest'
import {
  FLAG_PRI_KEY,
  FLAG_UNSIGNED,
  columnTypeName,
  formatDateTime,
  normalizeCell,
  normalizeRow,
  toQueryColumn
} from './values'

describe('normalizeCell', () => {
  it('passes scalars through and maps undefined to null', () => {
    expect(normalizeCell('a')).toBe('a')
    expect(normalizeCell(1.5)).toBe(1.5)
    expect(normalizeCell(true)).toBe(true)
    expect(normalizeCell(null)).toBeNull()
    expect(normalizeCell(undefined)).toBeNull()
  })

  it('renders Buffers as upper-case 0x hex', () => {
    expect(normalizeCell(Buffer.from([0xde, 0xad, 0x01]))).toBe('0xDEAD01')
    expect(normalizeCell(Buffer.alloc(0))).toBe('0x')
  })

  it('renders bigint as string', () => {
    expect(normalizeCell(BigInt('9007199254740993'))).toBe('9007199254740993')
  })

  it('renders Dates as YYYY-MM-DD HH:mm:ss', () => {
    expect(normalizeCell(new Date(2026, 2, 17, 9, 5, 7))).toBe('2026-03-17 09:05:07')
    expect(formatDateTime(new Date(NaN))).toBe('')
  })

  it('renders JSON objects and arrays as JSON text', () => {
    expect(normalizeCell({ a: [1, 'b'] })).toBe('{"a":[1,"b"]}')
    expect(normalizeCell([1, 2])).toBe('[1,2]')
  })

  it('normalizes whole rows', () => {
    expect(normalizeRow([1, Buffer.from('ff', 'hex'), undefined])).toEqual([1, '0xFF', null])
  })
})

describe('columnTypeName', () => {
  it('maps mysql2 type ids to readable names', () => {
    expect(columnTypeName({ name: 'c', columnType: 0x08 })).toBe('BIGINT')
    expect(columnTypeName({ name: 'c', columnType: 0x03 })).toBe('INT')
    expect(columnTypeName({ name: 'c', columnType: 0xf6 })).toBe('DECIMAL')
    expect(columnTypeName({ name: 'c', columnType: 0x0f })).toBe('VARCHAR')
    expect(columnTypeName({ name: 'c', columnType: 0xf5 })).toBe('JSON')
    expect(columnTypeName({ name: 'c', columnType: 0x0c })).toBe('DATETIME')
    expect(columnTypeName({ name: 'c', type: 0x07 })).toBe('TIMESTAMP')
  })

  it('distinguishes binary variants by charset 63 or the binary flag', () => {
    expect(columnTypeName({ name: 'c', columnType: 0xfd, charsetNr: 63 })).toBe('VARBINARY')
    expect(columnTypeName({ name: 'c', columnType: 0xfd, charsetNr: 255 })).toBe('VARCHAR')
    expect(columnTypeName({ name: 'c', columnType: 0xfc, charsetNr: 63 })).toBe('BLOB')
    expect(columnTypeName({ name: 'c', columnType: 0xfc, charsetNr: 45 })).toBe('TEXT')
    expect(columnTypeName({ name: 'c', columnType: 0xfe, charsetNr: 63 })).toBe('BINARY')
  })

  it('adds UNSIGNED for numeric columns only', () => {
    expect(columnTypeName({ name: 'c', columnType: 0x03, flags: FLAG_UNSIGNED })).toBe(
      'INT UNSIGNED'
    )
    expect(columnTypeName({ name: 'c', columnType: 0x0f, flags: FLAG_UNSIGNED })).toBe('VARCHAR')
  })

  it('never throws on unknown ids', () => {
    expect(columnTypeName({ name: 'c', columnType: 0x99 })).toBe('TYPE_153')
    expect(columnTypeName({ name: 'c' })).toBe('UNKNOWN')
  })
})

describe('toQueryColumn', () => {
  it('fills table/schema and primary key from flags', () => {
    expect(
      toQueryColumn({
        name: 'id',
        orgTable: 'users',
        table: 'u',
        db: 'app',
        columnType: 0x03,
        flags: FLAG_PRI_KEY | 1
      })
    ).toEqual({
      name: 'id',
      type: 'INT',
      table: 'users',
      schema: 'app',
      primaryKey: true,
      tableAlias: 'u'
    })
  })

  it('keeps the real column name and table alias of aliased columns', () => {
    expect(
      toQueryColumn({
        name: 'ident',
        orgName: 'id',
        orgTable: 'user',
        table: 'u',
        db: 'accounts',
        columnType: 0x03,
        flags: FLAG_PRI_KEY
      })
    ).toEqual({
      name: 'ident',
      type: 'INT',
      table: 'user',
      schema: 'accounts',
      primaryKey: true,
      sourceName: 'id',
      tableAlias: 'u'
    })
  })

  it('leaves sourceName out for expressions (empty orgName)', () => {
    const column = toQueryColumn({ name: 'e', orgName: '', table: '', orgTable: '', db: '' })
    expect(column.sourceName).toBeUndefined()
    expect(column.table).toBeUndefined()
  })

  it('omits table/schema for computed columns', () => {
    expect(toQueryColumn({ name: 'n', columnType: 0x08, flags: 0, table: '', db: '' })).toEqual({
      name: 'n',
      type: 'BIGINT'
    })
  })
})
