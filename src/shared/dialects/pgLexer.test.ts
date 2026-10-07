import { describe, expect, it } from 'vitest'
import { codeTokens, tokenizePg } from './pgLexer'

const kinds = (sql: string): string[] => tokenizePg(sql).map((t) => `${t.kind}:${t.value}`)

describe('tokenizePg', () => {
  it('reads dollar quotes with nested different tags as one string', () => {
    const sql = "SELECT $fn$ BEGIN RETURN $q$it's; done$q$; END $fn$, 1"
    const t = tokenizePg(sql)
    expect(t.map((x) => x.kind)).toEqual(['word', 'string', 'punct', 'number'])
    expect(t[1].value).toBe("$fn$ BEGIN RETURN $q$it's; done$q$; END $fn$")
  })

  it('reads E strings with backslash escapes and standard strings with doubling', () => {
    expect(kinds("E'it\\'s;' 'a''b;' 'c\\'")).toEqual([
      "string:E'it\\'s;'",
      "string:'a''b;'",
      "string:'c\\'"
    ])
  })

  it('reads prefixed literals and quoted identifiers', () => {
    expect(kinds(`U&'d\\0061t' B'101' X'1F' N'x' "a""b" U&"x"`)).toEqual([
      "string:U&'d\\0061t'",
      "string:B'101'",
      "string:X'1F'",
      "string:N'x'",
      'ident:a"b',
      'ident:x'
    ])
  })

  it('nests block comments and takes -- without a space as a comment', () => {
    expect(kinds('/* a /* b */ c */ SELECT 1--x\n2')).toEqual([
      'comment:/* a /* b */ c */',
      'word:SELECT',
      'number:1',
      'comment:--x',
      'number:2'
    ])
  })

  it('keeps jsonb and cast operators whole', () => {
    expect(kinds("d #>> '{a}' ? 'k' ?| a @> b <@ c ->> 'x' || y :: int $1")).toEqual([
      'word:d',
      'op:#>>',
      "string:'{a}'",
      'op:?',
      "string:'k'",
      'op:?|',
      'word:a',
      'op:@>',
      'word:b',
      'op:<@',
      'word:c',
      'op:->>',
      "string:'x'",
      'op:||',
      'word:y',
      'op:::',
      'word:int',
      'param:$1'
    ])
  })

  it('stops an operator run before a comment', () => {
    expect(kinds('a+--c\nb')).toEqual(['word:a', 'op:+', 'comment:--c', 'word:b'])
  })

  it('reports 1-based lines and offsets', () => {
    const t = tokenizePg('SELECT\n  1,\n\n  "x"')
    expect(t.map((x) => [x.value, x.line, x.start])).toEqual([
      ['SELECT', 1, 0],
      ['1', 2, 9],
      [',', 2, 10],
      ['x', 4, 15]
    ])
  })

  it('takes a backslash as a psql meta-command to the end of the line', () => {
    expect(kinds('\\copy t to stdout\nSELECT 1')).toEqual([
      'meta:\\copy t to stdout',
      'word:SELECT',
      'number:1'
    ])
  })

  it('never hangs on unterminated quotes and comments', () => {
    for (const sql of ["'abc", '"abc', '$$abc', '/* abc', "E'\\", '$tag$ x'])
      expect(tokenizePg(sql).length).toBe(1)
  })

  it('is linear on large inputs', () => {
    const big = "SELECT '" + 'x'.repeat(500_000) + "' ; " + 'a + b '.repeat(50_000)
    const started = Date.now()
    expect(codeTokens(tokenizePg(big)).length).toBe(150_003)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
