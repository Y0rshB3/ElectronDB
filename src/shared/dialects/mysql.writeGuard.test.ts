import { describe, expect, it } from 'vitest'
import { analyzeWrites } from './mysql'

describe('analyzeWrites', () => {
  it.each([
    'SELECT * FROM t',
    'select 1; show tables; describe t; explain select 1; use shop',
    '(SELECT 1) UNION (SELECT 2)',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    "SELECT 'DELETE FROM t' AS txt -- it's fine\n",
    "SELECT REPLACE(name, 'a', 'b'), INSERT('abc', 1, 1, 'z') FROM t",
    'SET @x = 1; SET NAMES utf8mb4; SET SESSION sql_mode = ""',
    '/* DROP TABLE t */ SELECT 1'
  ])('treats %s as read-only', (sql) => {
    expect(analyzeWrites(sql)).toEqual({ writes: false, reasons: [] })
  })

  it.each([
    ['CALL purge_all()', 'CALL'],
    ["LOAD DATA INFILE '/x' INTO TABLE t", 'LOAD DATA'],
    ['WITH x AS (SELECT 1) DELETE FROM t', 'WITH + DML'],
    ['(DELETE FROM t)', 'DELETE'],
    ['SET GLOBAL read_only = 1', 'SET GLOBAL'],
    ["IMPORT TABLE FROM '/tmp/t.sdi'", 'IMPORT TABLE'],
    ['/*!40000 DROP TABLE t */', 'DROP'],
    ["SELECT * FROM t INTO OUTFILE '/tmp/x'", 'SELECT con efectos'],
    ['SELECT * FROM t FOR UPDATE', 'SELECT con efectos'],
    ['INSERT INTO t VALUES (1)', 'INSERT'],
    ['UPDATE t SET a = 1 WHERE id = 1', 'UPDATE'],
    ['DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;', 'CREATE'],
    ['SELECT 1; OPTIMIZE TABLE t', 'OPTIMIZE']
  ])('flags %s as a write', (sql, reason) => {
    const check = analyzeWrites(sql)
    expect(check.writes).toBe(true)
    expect(check.reasons).toContain(reason)
  })
})
