import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { splitStatements } from './mysql'
import { MysqlStatementStream, splitStatementChunks } from './mysqlStream'

const FIXTURES = join(__dirname, '../../../tests/fixtures/importers/sql')
const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => ({ name: f, text: readFileSync(join(FIXTURES, f), 'utf8') }))

/** Deterministic PRNG so failures are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function chunked(text: string, sizes: () => number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length;) {
    const n = Math.max(1, sizes())
    out.push(text.slice(i, i + n))
    i += n
  }
  return out
}

const streamed = (chunks: Iterable<string>) => [...splitStatementChunks(chunks)]

const EDGE_CASES: Record<string, string> = {
  crlf: 'SELECT 1;\r\nSELECT\r\n 2;\r\n',
  loneCr: 'SELECT 1;\rSELECT 2;',
  delimiterLine: 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;\nSELECT 3;',
  delimiterIndented: '  delimiter //\nSELECT 1//\n\tDELIMITER ;\nSELECT 2;',
  delimiterAtEnd: 'SELECT 1;\nDELIMITER ;;',
  notDelimiter: 'delimited_table;\nSELECT d FROM delimiter_x;',
  longDelimiterLine: `DELIMITER ${'x'.repeat(250)}\nSELECT 1;`,
  dashes: 'SELECT 1--1;\nSELECT 2 -- comment ; here\n;\nSELECT 3--',
  hash: "SELECT '#' # trailing ; comment\n;",
  blockComments: '/* plain ; */ SELECT 1; /*! SELECT 2 */; /*+ hint */ SELECT 3; /* unterminated',
  quotes: `SELECT 'a;\\'b', "c;\\"d", \`e;\\\` ;SELECT 'x\\`,
  escapedNewline: "SELECT 'a\\\nb';SELECT 2;",
  backslashAtEnd: "SELECT 'abc\\",
  starAtEnd: '/* comment *',
  onlyComments: '-- nothing\n# here\n/* at all */',
  multiCharDelimiter: 'DELIMITER ;;\nSELECT 1;;SELECT 2; still;;\nDELIMITER ;\n',
  delimiterPrefix: 'DELIMITER $$\nSELECT 1 $ 2$$SELECT $3$$',
  unicode: "INSERT INTO t VALUES ('Ñandú 😀;'),('ü');\nSELECT 'ok';",
  emptyStatements: ';;; ;\n;SELECT 1;;'
}

describe('MysqlStatementStream', () => {
  it('matches splitStatements on every fixture in one chunk', () => {
    for (const f of fixtures) expect(streamed([f.text]), f.name).toEqual(splitStatements(f.text))
  })

  it('matches splitStatements with 1-character chunks', () => {
    for (const f of fixtures) expect(streamed([...f.text]), f.name).toEqual(splitStatements(f.text))
    for (const [name, text] of Object.entries(EDGE_CASES))
      expect(streamed([...text]), name).toEqual(splitStatements(text))
  })

  it('matches splitStatements for random chunk sizes', () => {
    const inputs = [...fixtures.map((f) => [f.name, f.text]), ...Object.entries(EDGE_CASES)]
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed)
      const max = [2, 3, 7, 16, 64, 300][seed % 6]
      for (const [name, text] of inputs) {
        const chunks = chunked(text, () => Math.floor(r() * max) + 1)
        expect(streamed(chunks), `${name} seed ${seed}`).toEqual(splitStatements(text))
      }
    }
  })

  it('handles the edge cases like splitStatements in one chunk', () => {
    for (const [name, text] of Object.entries(EDGE_CASES))
      expect(streamed([text]), name).toEqual(splitStatements(text))
  })

  it('emits statements as soon as they are complete', () => {
    const s = new MysqlStatementStream()
    expect(s.push('SELECT 1; SEL')).toEqual([{ sql: 'SELECT 1', startLine: 1 }])
    expect(s.push('ECT 2;\nSELECT')).toEqual([{ sql: 'SELECT 2', startLine: 1 }])
    expect(s.end()).toEqual([{ sql: 'SELECT', startLine: 2 }])
    expect(() => s.push('x')).toThrow()
  })

  it('tracks the delimiter', () => {
    const s = new MysqlStatementStream()
    s.push('DELIMITER ;;\n')
    // a DELIMITER line is only recognised with splitStatements' 200-character lookahead
    expect(s.push(`SELECT 1;;${' '.repeat(200)}`)).toEqual([{ sql: 'SELECT 1', startLine: 2 }])
    expect(s.currentDelimiter).toBe(';;')
  })

  it('splits a multi-megabyte extended INSERT in linear time', () => {
    const tuple = "(12345,'texto con ; y \\' comillas','2026-01-01 00:00:00',NULL)"
    const big = `INSERT INTO t VALUES ${Array.from({ length: 80_000 }, () => tuple).join(',')};\nSELECT 1;`
    expect(big.length).toBeGreaterThan(5_000_000)
    const started = performance.now()
    const out = streamed(chunked(big, () => 64 * 1024))
    const ms = performance.now() - started
    expect(out).toHaveLength(2)
    expect(out[0].sql.length).toBe(big.indexOf(';\nSELECT'))
    expect(ms).toBeLessThan(3000)
  })
})
