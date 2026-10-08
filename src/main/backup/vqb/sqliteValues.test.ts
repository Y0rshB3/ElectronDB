import { describe, expect, it } from 'vitest'
import { bindable } from '../../sqlite/core'
import { encodeSqliteCell, sqliteParam } from './sqliteValues'
import { qualifyDdl } from './sqliteRestore'
import { checkValue, encodeValue } from './values'

describe('SQLite cells in .vqb', () => {
  const cases: [Parameters<typeof encodeSqliteCell>, unknown][] = [
    [[42, 'integer'], 42],
    [['9007199254740993', 'integer'], { $bigint: '9007199254740993' }],
    [['-9223372036854775808', 'integer'], { $bigint: '-9223372036854775808' }],
    [[2.5, 'real'], 2.5],
    [[1, 'real'], { $float: '1' }],
    [[-0, 'real'], { $float: '-0' }],
    [[1e300, 'real'], { $float: '1e+300' }],
    [[Infinity, 'real'], { $float: 'Infinity' }],
    [['texto ñ €', 'text'], 'texto ñ €'],
    [['0x00FF10', 'blob'], { $bin: 'AP8Q' }],
    [['0x', 'blob'], { $bin: '' }],
    [[null, 'null'], null]
  ]
  it.each(cases)('encodes %j', (args, expected) => {
    const value = encodeSqliteCell(...args)
    expect(value).toEqual(expected)
    expect(() => checkValue(value)).not.toThrow()
    expect(encodeValue(value, 'raw')).toEqual(expected)
  })

  it('binds every value back with its storage class', () => {
    expect(bindable(sqliteParam(42))).toBe(42n)
    expect(bindable(sqliteParam({ $bigint: '9007199254740993' }))).toBe(9007199254740993n)
    expect(sqliteParam(2.5)).toBe(2.5)
    expect(sqliteParam({ $float: '1' })).toBe(1)
    expect(Object.is(sqliteParam({ $float: '-0' }), -0)).toBe(true)
    expect(sqliteParam({ $float: 'Infinity' })).toBe(Infinity)
    expect(sqliteParam('texto')).toBe('texto')
    expect(Buffer.from(bindable(sqliteParam({ $bin: 'AP8Q' })) as Uint8Array)).toEqual(
      Buffer.from([0, 255, 16])
    )
    expect(sqliteParam(null)).toBeNull()
    expect(bindable(sqliteParam(true))).toBe(1n)
    expect(sqliteParam({ $dt: '2026-10-07' })).toBe('2026-10-07')
  })

  it('refuses malformed cells', () => {
    expect(() => encodeSqliteCell('abc', 'integer')).toThrow()
    expect(() => encodeSqliteCell('zz', 'blob')).toThrow()
  })
})

describe('qualifyDdl', () => {
  it('qualifies the created object with the target database', () => {
    expect(qualifyDdl('CREATE TABLE t (a)', 'aux')).toBe('CREATE TABLE "aux"."t" (a)')
    expect(qualifyDdl('CREATE TABLE "my t" (a)', 'main')).toBe('CREATE TABLE "main"."my t" (a)')
    expect(qualifyDdl('CREATE UNIQUE INDEX IF NOT EXISTS ix ON t(a)', 'aux one')).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "aux one"."ix" ON t(a)'
    )
    expect(
      qualifyDdl('CREATE TEMP TRIGGER old.tr AFTER INSERT ON t BEGIN SELECT 1; END', 'main')
    ).toBe('CREATE TEMP TRIGGER "main"."tr" AFTER INSERT ON t BEGIN SELECT 1; END')
    expect(qualifyDdl('CREATE VIEW [v] AS SELECT 1', 'aux')).toBe(
      'CREATE VIEW "aux"."v" AS SELECT 1'
    )
    expect(qualifyDdl('SELECT 1', 'aux')).toBe('SELECT 1')
  })
})
