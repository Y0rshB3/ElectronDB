import { describe, expect, it } from 'vitest'
import type { TableDataRequest } from '@shared/types'
import { buildCountSql, buildSelectSql, fetchTableData } from './tableData'
import type { FullSession, RawStatementResult } from './session'

const base: TableDataRequest = { schema: 'app', table: 'users', limit: 50, offset: 100 }

describe('buildSelectSql', () => {
  it('builds the minimal paged select', () => {
    expect(buildSelectSql(base)).toEqual({
      sql: 'SELECT * FROM `app`.`users` LIMIT ? OFFSET ?',
      params: [50, 100]
    })
  })

  it('adds raw WHERE and escaped ORDER BY', () => {
    const { sql } = buildSelectSql({
      ...base,
      where: " status = 'a' ",
      orderBy: { column: 'we`ird', direction: 'DESC' }
    })
    expect(sql).toBe(
      "SELECT * FROM `app`.`users` WHERE (\nstatus = 'a'\n) ORDER BY `we``ird` DESC LIMIT ? OFFSET ?"
    )
  })

  it('keeps LIMIT effective when the filter ends with a line comment', () => {
    const { sql } = buildSelectSql({ ...base, where: 'id > 0 -- note' })
    expect(sql.split('\n').at(-1)).toBe(') LIMIT ? OFFSET ?')
  })

  it('ignores blank WHERE', () => {
    expect(buildSelectSql({ ...base, where: '   ' }).sql).toBe(
      'SELECT * FROM `app`.`users` LIMIT ? OFFSET ?'
    )
  })

  it('rejects invalid pagination and direction', () => {
    expect(() => buildSelectSql({ ...base, limit: 0 })).toThrow(/límite/)
    expect(() => buildSelectSql({ ...base, limit: 1.5 })).toThrow(/límite/)
    expect(() => buildSelectSql({ ...base, offset: -1 })).toThrow(/desplazamiento/)
    expect(() =>
      buildSelectSql({ ...base, orderBy: { column: 'a', direction: 'UP' as 'ASC' } })
    ).toThrow(/ASC o DESC/)
    expect(() => buildSelectSql({ ...base, table: '' })).toThrow(/esquema o la tabla/)
  })
})

describe('buildCountSql', () => {
  it('uses a MAX_EXECUTION_TIME hint and the same WHERE', () => {
    expect(buildCountSql({ ...base, where: 'id > 5' })).toBe(
      'SELECT /*+ MAX_EXECUTION_TIME(3000) */ COUNT(*) AS total FROM `app`.`users` WHERE (\nid > 5\n)'
    )
  })
})

describe('fetchTableData', () => {
  function fake(opts: { countFails?: boolean } = {}) {
    const queries: { sql: string; params?: unknown[] }[] = []
    const raw: RawStatementResult = {
      header: null,
      resultSets: [
        {
          fields: [
            { name: 'id', columnType: 0x03, flags: 2, orgTable: 'users', db: 'app' },
            { name: 'name', columnType: 0x0f, flags: 0, orgTable: 'users', db: 'app' }
          ] as never,
          rows: [[1, 'a']],
          rowCount: 1,
          truncated: false
        }
      ]
    }
    const session = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params })
        if (sql.includes('STATISTICS')) return [{ COLUMN_NAME: 'id' }]
        if (sql.includes('COUNT(*)')) {
          if (opts.countFails)
            throw Object.assign(new Error('timeout'), { code: 'ER_QUERY_TIMEOUT' })
          return [{ total: '42' }]
        }
        return []
      },
      runStatement: async (sql: string, _max: number, params?: unknown[]) => {
        queries.push({ sql, params })
        return raw
      }
    } as unknown as FullSession
    return { session, queries }
  }

  it('returns columns, rows, primary key and total', async () => {
    const { session, queries } = fake()
    const page = await fetchTableData(session, base)
    expect(page.primaryKey).toEqual(['id'])
    expect(page.total).toBe(42)
    expect(page.rows).toEqual([[1, 'a']])
    expect(page.columns).toEqual([
      { name: 'id', type: 'INT', table: 'users', schema: 'app', primaryKey: true },
      { name: 'name', type: 'VARCHAR', table: 'users', schema: 'app' }
    ])
    expect(queries.find((q) => q.sql.startsWith('SELECT *'))?.params).toEqual([50, 100])
    expect(queries.find((q) => q.sql.includes('STATISTICS'))?.params).toEqual(['app', 'users'])
  })

  it('reports total = null when COUNT(*) fails or times out', async () => {
    const { session } = fake({ countFails: true })
    const page = await fetchTableData(session, base)
    expect(page.total).toBeNull()
    expect(page.rows).toHaveLength(1)
  })
})
