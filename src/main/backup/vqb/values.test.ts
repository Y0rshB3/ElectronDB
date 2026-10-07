import { describe, expect, it } from 'vitest'
import {
  checkValue,
  encodeValue,
  formatPgArray,
  parsePgArray,
  pgParam,
  tagOf,
  type VqbValue
} from './values'

describe('encodeValue', () => {
  it('keeps exact JSON values plain', () => {
    expect(encodeValue(null, 'text')).toBeNull()
    expect(encodeValue(undefined, 'int')).toBeNull()
    expect(encodeValue(true, 'bool')).toBe(true)
    expect(encodeValue(42, 'int')).toBe(42)
    expect(encodeValue('42', 'int')).toBe(42)
    expect(encodeValue('-9007199254740991', 'int')).toBe(-9007199254740991)
    expect(encodeValue(1.5, 'float')).toBe(1.5)
    expect(encodeValue('1.5', 'float')).toBe(1.5)
    expect(encodeValue('héllo', 'text')).toBe('héllo')
  })

  it('tags integers outside the safe range', () => {
    expect(encodeValue('9007199254740993', 'int')).toEqual({ $bigint: '9007199254740993' })
    expect(encodeValue('18446744073709551615', 'int')).toEqual({ $bigint: '18446744073709551615' })
    expect(encodeValue(2n ** 63n, 'int')).toEqual({ $bigint: '9223372036854775808' })
  })

  it('tags decimals, non-finite floats, dates, json, bytes and arrays', () => {
    expect(encodeValue('123.4500', 'decimal')).toEqual({ $dec: '123.4500' })
    expect(encodeValue('NaN', 'decimal')).toEqual({ $dec: 'NaN' })
    expect(encodeValue('Infinity', 'float')).toEqual({ $float: 'Infinity' })
    expect(encodeValue('-Infinity', 'float')).toEqual({ $float: '-Infinity' })
    expect(encodeValue('2026-10-07 10:00:00.123', 'datetime')).toEqual({
      $dt: '2026-10-07 10:00:00.123'
    })
    expect(encodeValue('{"a": 1, "big": 12345678901234567890}', 'json')).toEqual({
      $json: '{"a": 1, "big": 12345678901234567890}'
    })
    expect(encodeValue(Buffer.from([0, 1, 2, 255]), 'binary')).toEqual({ $bin: 'AAEC/w==' })
    expect(encodeValue('0x0001FF', 'binary')).toEqual({ $bin: 'AAH/' })
    expect(encodeValue('{1,NULL,"a b"}', 'array')).toEqual({ $arr: ['1', null, 'a b'] })
    expect(encodeValue('[0:1]={7,8}', 'array')).toEqual({ $arr: ['7', '8'], $lb: '[0:1]' })
  })

  it('keeps 0x… text of a text column as text', () => {
    expect(encodeValue('0x41', 'text')).toBe('0x41')
  })
})

describe('checkValue', () => {
  it('accepts every tag of the spec', () => {
    const values: VqbValue[] = [
      null,
      true,
      1,
      's',
      { $bigint: '-1' },
      { $dec: '1.20' },
      { $float: 'NaN' },
      { $bin: '' },
      { $dt: '2026-01-01' },
      { $json: '[]' },
      { $arr: [null, ['x']], $lb: '[1:1][2:3]' }
    ]
    for (const v of values) expect(checkValue(v)).toEqual(v)
  })

  it('refuses malformed values', () => {
    for (const v of [
      { $bigint: '1.5' },
      { $dec: '1; DROP' },
      { $bin: 'not base64!' },
      { $dt: 5 },
      { $arr: [1] },
      { $what: 'x' },
      { a: 1 },
      [1],
      Number.NaN
    ])
      expect(() => checkValue(v), JSON.stringify(v)).toThrow()
  })

  it('names the tag', () => {
    expect(tagOf({ $arr: [], $lb: '[0:0]' })).toBe('$arr')
    expect(tagOf('x')).toBeNull()
  })
})

describe('PostgreSQL arrays', () => {
  it('parses nested, quoted and escaped elements', () => {
    expect(parsePgArray('{}').value).toEqual([])
    expect(parsePgArray('{{1,2},{3,NULL}}').value).toEqual([
      ['1', '2'],
      ['3', null]
    ])
    expect(parsePgArray('{"a\\"b","c\\\\d","NULL",null}').value).toEqual([
      'a"b',
      'c\\d',
      'NULL',
      null
    ])
    expect(parsePgArray('{(1\\,2);(3\\,4)}', ';').value).toEqual(['(1,2)', '(3,4)'])
  })

  it('round trips through formatPgArray', () => {
    const samples = ['{1,2,3}', '{"x y",NULL,"q\\"uote"}', '[0:1]={a,b}', '{{a},{b}}', '{}']
    for (const text of samples) {
      const { value, bounds } = parsePgArray(text)
      expect(parsePgArray(formatPgArray(value, bounds))).toEqual({ value, bounds })
    }
  })

  it('refuses broken literals', () => {
    for (const t of ['{1,2', '1,2}', '{"a}', '[0:1]{1}']) expect(() => parsePgArray(t)).toThrow()
  })
})

describe('pgParam', () => {
  it('turns values into text PostgreSQL casts back', () => {
    expect(pgParam(null)).toBeNull()
    expect(pgParam(false)).toBe('false')
    expect(pgParam(12)).toBe('12')
    expect(pgParam({ $bin: 'AAH/' })).toBe('\\x0001ff')
    expect(pgParam({ $arr: ['a', null], $lb: '[2:3]' })).toBe('[2:3]={"a",NULL}')
    expect(pgParam({ $json: '{"k": 1}' })).toBe('{"k": 1}')
    expect(pgParam({ $dec: '1.10' })).toBe('1.10')
  })
})
