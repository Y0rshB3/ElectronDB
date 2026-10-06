import { describe, expect, it } from 'vitest'
import { executeScript, resolveMaxRows } from './query'
import type { FullSession, RawStatementResult } from './session'

function fakeSession(handler: (sql: string, maxRows: number) => RawStatementResult | Error) {
  const executed: string[] = []
  let schema: string | null = null
  const session = {
    executed,
    get schema() {
      return schema
    },
    useSchema: async (s: string | null) => {
      schema = s
    },
    runStatement: async (sql: string, maxRows: number) => {
      executed.push(sql)
      const out = handler(sql, maxRows)
      if (out instanceof Error) throw out
      return out
    }
  }
  return session as unknown as FullSession & { executed: string[]; schema: string | null }
}

const okHeader = (affectedRows: number, insertId = 0): RawStatementResult => ({
  resultSets: [],
  header: {
    affectedRows,
    insertId,
    changedRows: affectedRows,
    warningStatus: 1,
    fieldCount: 0,
    info: '',
    serverStatus: 0
  } as never
})

const rows = (n: number, maxRows: number): RawStatementResult => ({
  header: null,
  resultSets: [
    {
      fields: [{ name: 'n', columnType: 0x08, flags: 0 }] as never,
      rows: Array.from({ length: Math.min(n, maxRows) }, (_, i) => [String(i)]),
      rowCount: n,
      truncated: n > maxRows
    }
  ]
})

describe('resolveMaxRows', () => {
  it('uses the fallback and caps at 100000', () => {
    expect(resolveMaxRows(undefined, 1000)).toBe(1000)
    expect(resolveMaxRows(0, 500)).toBe(500)
    expect(resolveMaxRows(-3, 500)).toBe(500)
    expect(resolveMaxRows(25.7, 500)).toBe(25)
    expect(resolveMaxRows(10_000_000, 500)).toBe(100000)
  })
})

describe('executeScript', () => {
  it('runs statements sequentially on the same session and maps results', async () => {
    const session = fakeSession((sql, max) =>
      sql.startsWith('SELECT') ? rows(3, max) : okHeader(2, 9)
    )
    const out = await executeScript(session, "INSERT INTO t VALUES (1);\nSELECT 'a;b';", {
      schema: 'app'
    })
    expect(session.schema).toBe('app')
    expect(session.executed).toEqual(['INSERT INTO t VALUES (1)', "SELECT 'a;b'"])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      affectedRows: 2,
      insertId: 9,
      changedRows: 2,
      warnings: 1,
      resultSet: null,
      error: null
    })
    expect(out[1]).toMatchObject({
      affectedRows: null,
      insertId: null,
      warnings: 0,
      error: null,
      resultSet: {
        columns: [{ name: 'n', type: 'BIGINT' }],
        rows: [['0'], ['1'], ['2']],
        truncated: false
      }
    })
    expect(typeof out[1].durationMs).toBe('number')
  })

  it('caps rows with maxRows and flags truncation', async () => {
    const session = fakeSession((_sql, max) => rows(10, max))
    const [r] = await executeScript(session, 'SELECT 1', { maxRows: 4 })
    expect(r.resultSet?.rows).toHaveLength(4)
    expect(r.resultSet?.truncated).toBe(true)
  })

  it('stops at the first error by default and records it', async () => {
    const session = fakeSession((sql) =>
      sql.includes('bad')
        ? Object.assign(new Error('You have an error'), { code: 'ER_PARSE_ERROR', errno: 1064 })
        : okHeader(1)
    )
    const out = await executeScript(session, 'SELECT ok; SELECT bad; SELECT never')
    expect(out.map((r) => r.error)).toEqual([null, 'You have an error (ER_PARSE_ERROR 1064)'])
    expect(session.executed).toEqual(['SELECT ok', 'SELECT bad'])
  })

  it('continues after errors when stopOnError is false', async () => {
    const session = fakeSession((sql) => (sql.includes('bad') ? new Error('nope') : okHeader(1)))
    const out = await executeScript(session, 'SELECT bad; SELECT ok', { stopOnError: false })
    expect(out.map((r) => r.error)).toEqual(['nope', null])
  })

  it('returns an empty list for an empty script', async () => {
    const session = fakeSession(() => okHeader(0))
    expect(await executeScript(session, '-- nothing\n')).toEqual([])
  })
})
