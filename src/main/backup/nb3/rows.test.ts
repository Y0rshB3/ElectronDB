import { describe, expect, it } from 'vitest'
import { RowSplitter, joinRows } from './rows'

const split = (chunks: Buffer[]): string[] => {
  const s = new RowSplitter()
  const out: string[] = []
  for (const c of chunks) out.push(...s.push(c))
  const rest = s.flush()
  if (rest !== null) out.push(rest)
  return out
}

describe('RowSplitter', () => {
  const rows = ["(1, 'Ana')", "(2, 'Línea\\nDos')", "(3, 'café ☕')"]
  const bytes = joinRows(rows)

  it('splits a single buffer and keeps the trailing row without separator', () => {
    expect(split([bytes])).toEqual(rows)
  })

  it('handles every possible cut point, including inside the separator and inside UTF-8 sequences', () => {
    for (let i = 1; i < bytes.length; i++) {
      expect(split([bytes.subarray(0, i), bytes.subarray(i)])).toEqual(rows)
    }
  })

  it('handles byte-by-byte feeding', () => {
    expect(split([...bytes].map((b) => Buffer.from([b])))).toEqual(rows)
  })

  it('separator split exactly between RS and LF across chunks', () => {
    const rs = bytes.indexOf(0x1e)
    expect(split([bytes.subarray(0, rs + 1), bytes.subarray(rs + 1)])).toEqual(rows)
  })

  it('does not treat a lone RS or LF inside a row as a separator', () => {
    const data = Buffer.concat([
      Buffer.from('(1, \x1e)'),
      Buffer.from([0x1e, 0x0a]),
      Buffer.from("('\n')")
    ])
    expect(split([data])).toEqual(['(1, \x1e)', "('\n')"])
  })

  it('returns nothing for an empty stream', () => {
    expect(split([Buffer.alloc(0)])).toEqual([])
  })

  it('joinRows writes no trailing separator', () => {
    expect(joinRows(['a', 'b']).toString('latin1')).toBe('a\x1e\nb')
  })
})
