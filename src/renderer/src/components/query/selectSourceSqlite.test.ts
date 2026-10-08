import { describe, expect, it } from 'vitest'
import {
  REASON_CTE,
  REASON_DERIVED,
  REASON_GROUPED,
  REASON_MULTI,
  REASON_NO_TABLE,
  REASON_NOT_SIMPLE,
  REASON_SUBQUERY,
  REASON_UNION,
  REASON_UNPARSED
} from './selectSource'
import { sqliteSingleTableSelect } from './selectSourceSqlite'

const ok = (schema: string | null, table: string, alias: string | null) => ({
  ok: true,
  ref: { schema, table, alias }
})

describe('sqliteSingleTableSelect', () => {
  it.each([
    ['SELECT * FROM t', ok(null, 't', null)],
    ['select a, b from Users;', ok(null, 'Users', null)],
    [
      'SELECT rowid, * FROM "my table" AS m WHERE x = 1 ORDER BY 1 LIMIT 5',
      ok(null, 'my table', 'm')
    ],
    ['SELECT * FROM [aux db].[t 1] x', ok('aux db', 't 1', 'x')],
    ['SELECT * FROM `main`.`order`', ok('main', 'order', null)],
    ['SELECT * FROM t INDEXED BY ix WHERE a = 1', ok(null, 't', null)],
    ['SELECT * FROM t AS u NOT INDEXED', ok(null, 't', 'u')],
    ["SELECT * FROM t WHERE a IN (1, 2) AND b LIKE 'x;y' -- c", ok(null, 't', null)],
    ['SELECT * FROM t LIMIT 10 OFFSET 20', ok(null, 't', null)],
    // A subquery in WHERE only filters: rows still map 1:1 to the table (as on PostgreSQL).
    ['SELECT * FROM t WHERE id IN (SELECT id FROM u)', ok(null, 't', null)]
  ])('accepts %s', (sql, expected) => {
    expect(sqliteSingleTableSelect(sql)).toEqual(expected)
  })

  it.each([
    ['WITH x AS (SELECT 1) SELECT * FROM x', REASON_CTE],
    ['UPDATE t SET a = 1', REASON_NOT_SIMPLE],
    ['PRAGMA table_info(t)', REASON_NOT_SIMPLE],
    ['SELECT 1; SELECT 2', REASON_NOT_SIMPLE],
    ['SELECT DISTINCT a FROM t', REASON_GROUPED],
    ['SELECT a FROM t GROUP BY a', REASON_GROUPED],
    ['SELECT a FROM t WHERE b HAVING 1', REASON_GROUPED],
    ['SELECT * FROM a, b', REASON_MULTI],
    ['SELECT * FROM a JOIN b ON a.id = b.id', REASON_MULTI],
    ['SELECT * FROM a LEFT JOIN b USING (id)', REASON_MULTI],
    ['SELECT * FROM (SELECT * FROM t)', REASON_DERIVED],
    ['SELECT (SELECT 1) AS x, * FROM t', REASON_SUBQUERY],
    ['SELECT a FROM t UNION SELECT a FROM u', REASON_UNION],
    ['SELECT 1 + 1', REASON_NO_TABLE],
    ["SELECT * FROM pragma_table_info('t')", REASON_NOT_SIMPLE],
    ['SELECT * FROM a.b.c', REASON_UNPARSED],
    ['SELECT * FROM t WHERE (a = 1', REASON_UNPARSED]
  ])('refuses %s', (sql, reason) => {
    expect(sqliteSingleTableSelect(sql)).toEqual({ ok: false, reason })
  })

  it('keeps REASON_DERIVED for a parenthesised source without SELECT', () => {
    expect(sqliteSingleTableSelect('SELECT * FROM (t)')).toEqual({
      ok: false,
      reason: REASON_DERIVED
    })
  })
})
