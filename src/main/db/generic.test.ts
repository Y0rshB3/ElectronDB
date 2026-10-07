import { describe, expect, it } from 'vitest'
import type { QueryStatementResult, RowChange } from '@shared/types'
import { executeScript, type ScriptTarget } from './query'
import { applyRowChangesAtomically, type RowChangeRunner } from './rowChanges'
import { fetchTablePage } from './tableData'

// The engine-neutral loops, driven by a fake engine that is not MySQL.

const lineSplitter = {
  splitStatements: (script: string) =>
    script
      .split('\n')
      .filter((s) => s.trim())
      .map((sql, i) => ({ sql, startLine: i + 1 }))
}

function fakeTarget(fail: (sql: string) => boolean) {
  const calls: string[] = []
  const target: ScriptTarget<{ n: number }> = {
    useSchema: async (schema) => {
      calls.push(`schema:${schema}`)
    },
    runStatement: async (sql, maxRows) => {
      calls.push(`${sql}@${maxRows}`)
      if (fail(sql)) throw new Error(`no: ${sql}`)
      return { n: 1 }
    },
    toResult: (sql, raw, durationMs): QueryStatementResult => ({
      sql,
      durationMs,
      affectedRows: raw.n,
      insertId: null,
      changedRows: null,
      warnings: 0,
      resultSet: null,
      error: null
    }),
    describeError: (err) => `motor: ${(err as Error).message}`
  }
  return { target, calls }
}

describe('executeScript (generic)', () => {
  it('uses the dialect splitter, the schema and the row cap, and stops at the first error', async () => {
    const { target, calls } = fakeTarget((sql) => sql === 'b')
    const results = await executeScript(target, lineSplitter, 'a\nb\nc', {
      schema: 'app',
      maxRows: 10
    })
    expect(calls).toEqual(['schema:app', 'a@10', 'b@10'])
    expect(results.map((r) => [r.sql, r.affectedRows, r.error])).toEqual([
      ['a', 1, null],
      ['b', null, 'motor: no: b']
    ])
  })

  it('continues past errors when asked and applies the default row limit', async () => {
    const { target, calls } = fakeTarget((sql) => sql === 'a')
    const results = await executeScript(target, lineSplitter, 'a\nb', { stopOnError: false }, 7)
    expect(calls).toEqual(['a@7', 'b@7'])
    expect(results).toHaveLength(2)
  })
})

describe('fetchTablePage (generic)', () => {
  const page = { columns: [], rows: [['1']] }

  it('runs primary key, page and count in order', async () => {
    const order: string[] = []
    const result = await fetchTablePage({
      primaryKey: async () => (order.push('pk'), ['id']),
      page: async () => (order.push('page'), page),
      count: async () => (order.push('count'), 42)
    })
    expect(order).toEqual(['pk', 'page', 'count'])
    expect(result).toMatchObject({ primaryKey: ['id'], rows: [['1']], total: 42 })
  })

  it('reports a failing count as an unknown total', async () => {
    const result = await fetchTablePage({
      primaryKey: async () => [],
      page: async () => page,
      count: async () => {
        throw new Error('timeout')
      }
    })
    expect(result.total).toBeNull()
  })
})

describe('applyRowChangesAtomically (generic)', () => {
  const changes: RowChange[] = [
    { kind: 'insert', values: { a: 1 } },
    { kind: 'update', key: { id: 1 }, values: { a: 2 } }
  ]

  function runner(affected: number[], failAt = -1) {
    const log: string[] = []
    let i = 0
    const r: RowChangeRunner<string> = {
      begin: async () => void log.push('begin'),
      execute: async (stmt) => {
        log.push(stmt)
        if (i === failAt) throw new Error('server says no')
        return { affectedRows: affected[i++], insertId: 7 }
      },
      commit: async () => void log.push('commit'),
      rollback: async () => void log.push('rollback'),
      display: (stmt) => `shown ${stmt}`,
      explainError: () => 'la columna «a» no admite NULL',
      toError: (message) => new Error(message)
    }
    return { r, log }
  }

  it('commits when every change hits its row', async () => {
    const { r, log } = runner([1, 1])
    const result = await applyRowChangesAtomically(changes, ['s1', 's2'], r)
    expect(log).toEqual(['begin', 's1', 's2', 'commit'])
    expect(result).toEqual({
      applied: 2,
      statements: ['shown s1', 'shown s2'],
      insertIds: [7, null]
    })
  })

  it('rolls back when an update hits no row or the server refuses', async () => {
    const missing = runner([1, 0])
    await expect(applyRowChangesAtomically(changes, ['s1', 's2'], missing.r)).rejects.toThrow(
      /la fila ya no existe/
    )
    expect(missing.log).toEqual(['begin', 's1', 's2', 'rollback'])

    const refused = runner([1, 1], 0)
    await expect(applyRowChangesAtomically(changes, ['s1', 's2'], refused.r)).rejects.toThrow(
      /no admite NULL/
    )
    expect(refused.log).toEqual(['begin', 's1', 'rollback'])
  })
})
