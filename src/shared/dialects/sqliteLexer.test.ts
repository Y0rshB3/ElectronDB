import { describe, expect, it } from 'vitest'
import { sqliteCodeTokens, tokenizeSqlite } from './sqliteLexer'

const kinds = (src: string): [string, string][] => tokenizeSqlite(src).map((t) => [t.kind, t.value])

describe('SQLite lexer', () => {
  it('reads strings with doubled quotes and no backslash escapes', () => {
    expect(kinds("SELECT 'it''s', 'a\\'")).toEqual([
      ['word', 'SELECT'],
      ['string', "'it''s'"],
      ['punct', ','],
      ['string', "'a\\'"]
    ])
  })

  it('reads blob literals as strings', () => {
    expect(kinds("x'00ff' X'AB'")).toEqual([
      ['string', "x'00ff'"],
      ['string', "X'AB'"]
    ])
  })

  it('unquotes the three identifier forms', () => {
    expect(kinds('"a""b" [c d] `e``f` [x]]')).toEqual([
      ['ident', 'a"b'],
      ['ident', 'c d'],
      ['ident', 'e`f'],
      ['ident', 'x'],
      ['punct', ']']
    ])
  })

  it('keeps comments as tokens; block comments do not nest', () => {
    expect(kinds('a --x;\nb /* c /* d */ e */')).toEqual([
      ['word', 'a'],
      ['comment', '--x;'],
      ['word', 'b'],
      ['comment', '/* c /* d */'],
      ['word', 'e'],
      ['op', '*'],
      ['op', '/']
    ])
    // Operators follow SQLite's tokenizer: `=-1` is `=` and `-`, `->>` and `||` stay whole.
    expect(kinds("x=-1 || a->>'$'").map((t) => t[1])).toEqual([
      'x',
      '=',
      '-',
      '1',
      '||',
      'a',
      '->>',
      "'$'"
    ])
    expect(kinds('a /* open')).toEqual([
      ['word', 'a'],
      ['comment', '/* open']
    ])
  })

  it('reads every parameter form', () => {
    expect(kinds('? ?12 :name @v $a::b(x) $c').map((t) => t[1])).toEqual([
      '?',
      '?12',
      ':name',
      '@v',
      '$a::b(x)',
      '$c'
    ])
    expect(tokenizeSqlite('? ?1 :a').every((t) => t.kind === 'param')).toBe(true)
  })

  it('reads numbers and operators', () => {
    expect(kinds('1.5e3 0x1F .5 a||b x->>y <> !=')).toEqual([
      ['number', '1.5e3'],
      ['number', '0x1F'],
      ['number', '.5'],
      ['word', 'a'],
      ['op', '||'],
      ['word', 'b'],
      ['word', 'x'],
      ['op', '->>'],
      ['word', 'y'],
      ['op', '<>'],
      ['op', '!=']
    ])
  })

  it('reports offsets and lines; code tokens drop comments', () => {
    const tokens = tokenizeSqlite("SELECT\n  'a\nb',\n  x -- c\nFROM t")
    expect(tokens.map((t) => t.line)).toEqual([1, 2, 3, 4, 4, 5, 5])
    expect(tokens[1].start).toBe(9)
    expect(sqliteCodeTokens(tokens).map((t) => t.value)).toEqual([
      'SELECT',
      "'a\nb'",
      ',',
      'x',
      'FROM',
      't'
    ])
  })

  it('stays linear on unterminated input', () => {
    const big = "'" + 'a'.repeat(200_000)
    expect(tokenizeSqlite(big)).toHaveLength(1)
    expect(tokenizeSqlite('[' + 'a'.repeat(100_000))).toHaveLength(1)
  })
})
