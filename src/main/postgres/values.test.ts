import { describe, expect, it } from 'vitest'
import { OID, byteaToHex, normalizeCell, pgTypes, typeKindOf } from './values'

describe('PostgreSQL type parsing (value fidelity)', () => {
  const parse = (oid: number, text: string) => pgTypes.getTypeParser(oid)(text)

  it('parses only bool, int2/int4/oid and float4/float8', () => {
    expect(parse(OID.bool, 't')).toBe(true)
    expect(parse(OID.bool, 'f')).toBe(false)
    expect(parse(OID.int2, '-7')).toBe(-7)
    expect(parse(OID.int4, '2147483647')).toBe(2147483647)
    expect(parse(OID.oid, '16384')).toBe(16384)
    expect(parse(OID.float8, '0.30000000000000004')).toBe(0.30000000000000004)
    expect(parse(OID.float4, 'NaN')).toBe('NaN')
    expect(parse(OID.float8, 'Infinity')).toBe('Infinity')
  })

  it('keeps the server text of everything else', () => {
    expect(parse(OID.int8, '9007199254740993')).toBe('9007199254740993')
    expect(parse(OID.numeric, '1.50')).toBe('1.50')
    expect(parse(OID.date, '1980-01-02')).toBe('1980-01-02')
    expect(parse(OID.timestamptz, '2026-10-06 01:10:30.326955+00')).toBe(
      '2026-10-06 01:10:30.326955+00'
    )
    expect(parse(OID.interval, '1 day 02:03:04')).toBe('1 day 02:03:04')
    expect(parse(OID.jsonb, '{"k": [1, 2]}')).toBe('{"k": [1, 2]}')
    expect(parse(1009, '{a,"b c"}')).toBe('{a,"b c"}')
  })

  it('turns bytea hex output into 0xHEX', () => {
    expect(parse(OID.bytea, '\\x0102ff')).toBe('0x0102FF')
    expect(byteaToHex('\\x')).toBe('0x')
    expect(normalizeCell(Buffer.from([1, 255]))).toBe('0x01FF')
    expect(normalizeCell(10n)).toBe('10')
  })

  it('classifies types into neutral kinds', () => {
    const k = (name: string, category: string, type = 'b') => typeKindOf({ name, category, type })
    expect(k('int4', 'N')).toBe('integer')
    expect(k('numeric', 'N')).toBe('decimal')
    expect(k('float8', 'N')).toBe('float')
    expect(k('bool', 'B')).toBe('boolean')
    expect(k('jsonb', 'U')).toBe('json')
    expect(k('uuid', 'U')).toBe('uuid')
    expect(k('_text', 'A')).toBe('array')
    expect(k('mood', 'E', 'e')).toBe('enum')
    expect(k('timestamptz', 'D')).toBe('datetime')
    expect(k('date', 'D')).toBe('date')
    expect(k('varchar', 'S')).toBe('text')
    expect(k('bytea', 'U')).toBe('binary')
    expect(k('inet', 'I')).toBe('other')
  })
})
