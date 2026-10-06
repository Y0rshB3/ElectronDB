import { describe, expect, it } from 'vitest'
import { escapeString, formatLiteral, literalKindOf, renderTuple } from './mysqlLiterals'

describe('mysqlLiterals', () => {
  it('escapes like mysql_real_escape_string', () => {
    expect(escapeString('a\0b\nc\rd\\e\'f"g\x1ah')).toBe('a\\0b\\nc\\rd\\\\e\\\'f\\"g\\Zh')
  })

  it('renders scalars', () => {
    expect(formatLiteral(null)).toBe('NULL')
    expect(formatLiteral(undefined)).toBe('NULL')
    expect(formatLiteral(42)).toBe('42')
    expect(formatLiteral(-3.5)).toBe('-3.5')
    expect(formatLiteral(Number.NaN)).toBe('NULL')
    expect(formatLiteral(12345678901234567890n)).toBe('12345678901234567890')
    expect(formatLiteral(true)).toBe('1')
    expect(formatLiteral("O'Reilly")).toBe("'O\\'Reilly'")
  })

  it('writes numeric driver strings unquoted only for numeric columns', () => {
    expect(formatLiteral('9007199254740993', 'numeric')).toBe('9007199254740993')
    expect(formatLiteral('12.50', 'numeric')).toBe('12.50')
    expect(formatLiteral('007', 'text')).toBe("'007'")
    expect(formatLiteral('abc', 'numeric')).toBe("'abc'")
  })

  it('renders binary values as hex literals', () => {
    expect(formatLiteral(Buffer.from([0, 255, 16]))).toBe('0x00FF10')
    expect(formatLiteral(new Uint8Array([1, 2]))).toBe('0x0102')
    expect(formatLiteral(Buffer.alloc(0))).toBe("''")
    expect(formatLiteral('0xABCD', 'binary')).toBe('0xABCD')
    expect(formatLiteral('0xABCD', 'text')).toBe("'0xABCD'")
  })

  it('serialises JSON objects and dates as quoted strings', () => {
    expect(formatLiteral({ k: "it's" })).toBe('\'{\\"k\\":\\"it\\\'s\\"}\'')
    expect(formatLiteral([1, 2])).toBe("'[1,2]'")
    expect(formatLiteral(new Date(2026, 0, 2, 3, 4, 5))).toBe("'2026-01-02 03:04:05'")
  })

  it('classifies column types', () => {
    expect(literalKindOf('bigint unsigned')).toBe('numeric')
    expect(literalKindOf('decimal(10,2)')).toBe('numeric')
    expect(literalKindOf('varbinary(16)')).toBe('binary')
    expect(literalKindOf('longblob')).toBe('binary')
    expect(literalKindOf('bit(1)')).toBe('binary')
    expect(literalKindOf('json')).toBe('text')
    expect(literalKindOf('varchar(10)')).toBe('text')
  })

  it('renders tuples', () => {
    expect(
      renderTuple([1, null, 'x\ny', Buffer.from('A')], ['numeric', 'text', 'text', 'binary'])
    ).toBe("(1, NULL, 'x\\ny', 0x41)")
  })
})
