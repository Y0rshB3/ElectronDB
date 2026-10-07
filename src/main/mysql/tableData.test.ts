import { describe, expect, it } from 'vitest'
import type { TableFilter } from '@shared/types'
import type { TableDataRequest } from './tableData'
import { buildCountSql, buildSelectSql, fetchTableData } from './tableData'
import type { FullSession, RawStatementResult } from './session'

const base: TableDataRequest = { schema: 'app', table: 'users', limit: 50, offset: 100 }

describe('buildSelectSql', () => {
  it('builds the minimal paged select', () => {
    expect(buildSelectSql(base)).toBe('SELECT * FROM `app`.`users` LIMIT 50 OFFSET 100')
  })

  it('adds raw WHERE and escaped ORDER BY', () => {
    const sql = buildSelectSql({
      ...base,
      where: " status = 'a' ",
      orderBy: { column: 'we`ird', direction: 'DESC' }
    })
    expect(sql).toBe(
      "SELECT * FROM `app`.`users` WHERE (\nstatus = 'a'\n) ORDER BY `we``ird` DESC LIMIT 50 OFFSET 100"
    )
  })

  it('keeps LIMIT effective when the filter ends with a line comment', () => {
    const sql = buildSelectSql({ ...base, where: 'id > 0 -- note' })
    expect(sql.split('\n').at(-1)).toBe(') LIMIT 50 OFFSET 100')
  })

  it('ignores blank WHERE', () => {
    expect(buildSelectSql({ ...base, where: '   ' })).toBe(
      'SELECT * FROM `app`.`users` LIMIT 50 OFFSET 100'
    )
  })

  // Regression: mysql2 replaced the first `?` of the text, even inside a quoted literal.
  it('does not take a ? inside the raw WHERE for a placeholder', () => {
    const sql = buildSelectSql({ ...base, where: "name = 'why?'" })
    expect(sql).toBe("SELECT * FROM `app`.`users` WHERE (\nname = 'why?'\n) LIMIT 50 OFFSET 100")
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

describe('structured filter', () => {
  const filter: TableFilter = {
    kind: 'group',
    enabled: true,
    connector: 'AND',
    children: [
      {
        kind: 'condition',
        enabled: true,
        column: 'name',
        operator: 'contains',
        values: ["50%_o'k"],
        connector: 'AND'
      }
    ]
  }

  it('combines raw WHERE and filter with AND, the same in SELECT and COUNT', () => {
    const req = { ...base, where: 'id > 5', filter }
    const where = "WHERE (\nid > 5\n) AND ((`name` LIKE '%50\\\\%\\\\_o\\'k%'))"
    expect(buildSelectSql(req, ['id', 'name'])).toBe(
      `SELECT * FROM \`app\`.\`users\` ${where} LIMIT 50 OFFSET 100`
    )
    expect(buildCountSql(req, ['id', 'name'])).toBe(
      `SELECT /*+ MAX_EXECUTION_TIME(3000) */ COUNT(*) AS total FROM \`app\`.\`users\` ${where}`
    )
  })

  it('rejects a column the table does not have', () => {
    expect(() => buildSelectSql({ ...base, filter }, ['id'])).toThrow('La columna «name» no existe')
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
        if (sql.includes('information_schema.COLUMNS'))
          return [{ COLUMN_NAME: 'id' }, { COLUMN_NAME: 'name' }]
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
    const select = queries.find((q) => q.sql.startsWith('SELECT *'))
    expect(select?.sql).toBe('SELECT * FROM `app`.`users` LIMIT 50 OFFSET 100')
    expect(select?.params).toBeUndefined()
    // No structured filter: the column list is not fetched.
    expect(queries.some((q) => q.sql.includes('COLUMNS'))).toBe(false)
    expect(queries.find((q) => q.sql.includes('STATISTICS'))?.params).toEqual(['app', 'users'])
  })

  it('reports total = null when COUNT(*) fails or times out', async () => {
    const { session } = fake({ countFails: true })
    const page = await fetchTableData(session, base)
    expect(page.total).toBeNull()
    expect(page.rows).toHaveLength(1)
  })

  it('validates filter columns against the table and uses one WHERE for page and total', async () => {
    const { session, queries } = fake()
    await fetchTableData(session, {
      ...base,
      filter: {
        kind: 'group',
        enabled: true,
        connector: 'AND',
        children: [
          {
            kind: 'condition',
            enabled: true,
            column: 'ID',
            operator: 'in',
            values: ['1', '2'],
            connector: 'OR'
          },
          {
            kind: 'condition',
            enabled: true,
            column: 'name',
            operator: 'isEmpty',
            values: [],
            connector: 'AND'
          }
        ]
      }
    })
    const where = "WHERE ((`id` IN ('1', '2')) OR ((`name` = '' OR `name` IS NULL)))"
    expect(queries.find((q) => q.sql.startsWith('SELECT *'))?.sql).toContain(where)
    expect(queries.find((q) => q.sql.includes('COUNT(*)'))?.sql).toContain(where)
    expect(queries.find((q) => q.sql.includes('COLUMNS'))?.params).toEqual(['app', 'users'])
  })
})
