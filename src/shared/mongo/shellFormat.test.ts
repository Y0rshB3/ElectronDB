import { describe, expect, it } from 'vitest'
import { parse as parseShell } from '@mongodb-js/shell-bson-parser'
import {
  Binary,
  BSONRegExp,
  Code,
  Decimal128,
  Double,
  EJSON,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID
} from 'bson'
import {
  bsonTypeOf,
  cellPreview,
  isoDate,
  objectIdTime,
  parseEjson,
  plainValue,
  quote,
  shellText,
  typedValue,
  type EjsonValue
} from './shellFormat'

const canonical = (doc: unknown): string => EJSON.stringify(doc, { relaxed: false })

/** shellText → shell-bson-parser → canonical EJSON must give back the same text. */
function roundTrip(doc: Record<string, unknown>): void {
  const text = canonical(doc)
  const shell = shellText(parseEjson(text), { indent: 2 })
  const parsed = parseShell(shell, { mode: 'strict', allowComments: true })
  expect(parsed, shell).not.toBe('')
  expect(canonical(parsed)).toBe(text)
}

describe('shellFormat round trip', () => {
  it('keeps every BSON type through shell text', () => {
    roundTrip({
      _id: new ObjectId('6ac6f781fc637c60b5590643'),
      int: new Int32(5),
      negInt: new Int32(-7),
      long: Long.fromString('9007199254740993'),
      negLong: Long.fromString('-9223372036854775808'),
      double: new Double(5),
      frac: new Double(5.25),
      big: new Double(3e9),
      tiny: new Double(1e-7),
      negZero: new Double(-0),
      nan: new Double(NaN),
      inf: new Double(Infinity),
      dec: Decimal128.fromString('1.10'),
      decBig: Decimal128.fromString('12345678901234567890.123456789'),
      date: new Date('2026-10-07T10:11:12.345Z'),
      oldDate: new Date(-62198755200001),
      year0: new Date(Date.UTC(2000, 0, 1) - 63113904000000),
      farDate: new Date(253402300800000),
      bool: true,
      nul: null,
      str: 'it\'s "quoted" \\ back\nline\ttab   é 😀',
      empty: '',
      uuid: new UUID('0e3b4a3c-7b5f-4b1a-9a7e-1d2e3f4a5b6c'),
      bin: new Binary(new Uint8Array([0, 1, 2, 255]), 0),
      legacyUuid: new Binary(new Uint8Array(16).fill(7), 3),
      userBin: new Binary(new Uint8Array([9, 9]), 128),
      ts: new Timestamp({ t: 1700000000, i: 3 }),
      re: new BSONRegExp('^ab+c$', 'i'),
      min: new MinKey(),
      max: new MaxKey(),
      code: new Code('function () { return 1 }'),
      nested: { a: [new Int32(1), 'x', { b: Long.fromNumber(2) }], 'weird key': 1, 'a.b': 2 },
      arr: [],
      obj: {}
    })
  })

  it('formats in one line by default', () => {
    const v = parseEjson(canonical({ a: new Int32(1), b: [new Double(2.5)] }))
    expect(shellText(v)).toBe('{ a: 1, b: [2.5] }')
  })

  it('shows dates out of years 0–9999 as new Date(ms)', () => {
    const v = parseEjson(canonical({ d: new Date(253402300800000) })) as Record<string, EjsonValue>
    expect(shellText(v.d)).toBe('new Date(253402300800000)')
    expect(isoDate(253402300800000)).toBeNull()
    expect(isoDate(0)).toBe('1970-01-01T00:00:00.000Z')
  })

  it('quotes strings that parse back to the same text', () => {
    for (const s of ["a'b", 'a\\b', '\u0000\u001f', '\ud800', 'x y']) {
      const parsed = parseShell(`{ v: ${quote(s)} }`, { mode: 'strict' }) as { v: string }
      expect(parsed.v).toBe(s)
    }
  })
})

describe('cell previews and types', () => {
  const doc = parseEjson(
    canonical({
      _id: new ObjectId('6ac6f781fc637c60b5590643'),
      o: { a: 1, b: 2, c: 3 },
      l: [1, 2, 3, 4, 5],
      s: 'plain',
      n: Long.fromNumber(7),
      u: new UUID('0e3b4a3c-7b5f-4b1a-9a7e-1d2e3f4a5b6c')
    })
  ) as Record<string, EjsonValue>

  it('previews containers and scalars', () => {
    expect(cellPreview(doc.o)).toBe('{…} 3 campos')
    expect(cellPreview(doc.l)).toBe('[…] 5')
    expect(cellPreview(doc.s)).toBe('plain')
    expect(cellPreview(doc.n)).toBe("NumberLong('7')")
    expect(cellPreview(doc._id)).toBe("ObjectId('6ac6f781fc637c60b5590643')")
    expect(cellPreview(doc.u)).toBe("UUID('0e3b4a3c-7b5f-4b1a-9a7e-1d2e3f4a5b6c')")
  })

  it('names BSON types', () => {
    expect(bsonTypeOf(doc._id)).toBe('objectId')
    expect(bsonTypeOf(doc.n)).toBe('long')
    expect(bsonTypeOf(doc.o)).toBe('object')
    expect(bsonTypeOf(doc.l)).toBe('array')
    expect(bsonTypeOf(doc.u)).toBe('binData')
  })

  it('reads the creation time of an ObjectId', () => {
    expect(objectIdTime('6ac6f781fc637c60b5590643')).toBe(0x6ac6f781 * 1000)
    expect(objectIdTime('nope')).toBeNull()
  })
})

describe('typed values of the cell editor', () => {
  const parsed = (v: EjsonValue): unknown => EJSON.parse(JSON.stringify({ v }), { relaxed: false })

  it('keeps the chosen type', () => {
    const int = typedValue('int', '5')
    expect(int).toEqual({ value: { $numberInt: '5' } })
    expect((parsed((int as { value: EjsonValue }).value) as { v: unknown }).v).toBeInstanceOf(Int32)
    expect(typedValue('long', '9223372036854775807')).toEqual({
      value: { $numberLong: '9223372036854775807' }
    })
    expect(typedValue('double', '5')).toEqual({ value: { $numberDouble: '5.0' } })
    expect(typedValue('double', '2.5')).toEqual({ value: { $numberDouble: '2.5' } })
    expect(typedValue('decimal', '1.10')).toEqual({ value: { $numberDecimal: '1.10' } })
    expect(typedValue('bool', 'false')).toEqual({ value: false })
    expect(typedValue('string', ' 5 ')).toEqual({ value: ' 5 ' })
    expect(typedValue('null', 'x')).toEqual({ value: null })
    expect(typedValue('objectId', '6AC6F781FC637C60B5590643')).toEqual({
      value: { $oid: '6ac6f781fc637c60b5590643' }
    })
    expect(typedValue('date', '2026-10-07T00:00:00Z')).toEqual({
      value: { $date: { $numberLong: String(Date.UTC(2026, 9, 7)) } }
    })
  })

  it('refuses values the type cannot hold', () => {
    expect(typedValue('int', '2147483648')).toHaveProperty('error')
    expect(typedValue('int', '1.5')).toHaveProperty('error')
    expect(typedValue('long', '9223372036854775808')).toHaveProperty('error')
    expect(typedValue('double', 'abc')).toHaveProperty('error')
    expect(typedValue('objectId', 'xyz')).toHaveProperty('error')
    expect(typedValue('date', 'yesterday')).toHaveProperty('error')
    expect(typedValue('bool', 'maybe')).toHaveProperty('error')
  })

  it('shows plain text of scalars for editing', () => {
    expect(plainValue({ $numberLong: '12' })).toBe('12')
    expect(plainValue({ $date: { $numberLong: '0' } })).toBe('1970-01-01T00:00:00.000Z')
    expect(plainValue(null)).toBe('')
    expect(plainValue({ $oid: 'abc' })).toBe('abc')
  })
})
