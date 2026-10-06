import { describe, expect, it } from 'vitest'
import {
  ALL_ROWS_WARNING,
  analyzeDestructiveScript,
  destructiveItems,
  destructiveTitle,
  truncateStatement
} from './destructiveGuard'

const reasons = (sql: string) => analyzeDestructiveScript(sql).map((s) => s.reason)

describe('analyzeDestructiveScript', () => {
  it('flags DROP of any object with its kind', () => {
    expect(
      reasons(
        [
          'DROP TABLE t',
          'drop view v',
          'DROP DATABASE shop',
          'DROP SCHEMA IF EXISTS s',
          'DROP FUNCTION f',
          'DROP PROCEDURE p',
          'DROP EVENT e',
          'DROP TRIGGER tr',
          'DROP INDEX i ON t',
          'DROP USER u',
          'DROP TEMPORARY TABLE tmp'
        ].join(';\n')
      )
    ).toEqual([
      'DROP TABLE',
      'DROP VIEW',
      'DROP DATABASE',
      'DROP SCHEMA',
      'DROP FUNCTION',
      'DROP PROCEDURE',
      'DROP EVENT',
      'DROP TRIGGER',
      'DROP INDEX',
      'DROP USER',
      'DROP TEMPORARY TABLE'
    ])
  })

  it('flags TRUNCATE with or without the TABLE keyword', () => {
    expect(reasons('TRUNCATE TABLE t; truncate t2')).toEqual(['TRUNCATE TABLE', 'TRUNCATE TABLE'])
  })

  it('flags DELETE and calls out the ones without WHERE', () => {
    const found = analyzeDestructiveScript('DELETE FROM t WHERE id = 1; DELETE FROM t')
    expect(found).toEqual([
      { sql: 'DELETE FROM t WHERE id = 1', reason: 'DELETE', allRows: false },
      { sql: 'DELETE FROM t', reason: 'DELETE sin WHERE', allRows: true }
    ])
  })

  it('does not count a WHERE inside a subquery, a string or a comment', () => {
    expect(analyzeDestructiveScript('DELETE FROM t -- WHERE id = 1')[0].allRows).toBe(true)
    expect(analyzeDestructiveScript('DELETE FROM t /* where */ ')[0].allRows).toBe(true)
    expect(
      analyzeDestructiveScript("UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1), c = 'WHERE'")[0]
    ).toMatchObject({ reason: 'UPDATE sin WHERE', allRows: true })
    expect(
      analyzeDestructiveScript('DELETE FROM t WHERE id IN (SELECT id FROM u)')[0].allRows
    ).toBe(false)
  })

  it('treats DELETE … LIMIT as bounded', () => {
    expect(analyzeDestructiveScript('DELETE FROM t ORDER BY id LIMIT 10')[0]).toMatchObject({
      reason: 'DELETE',
      allRows: false
    })
  })

  it('flags UPDATE only without WHERE', () => {
    expect(reasons('UPDATE t SET a = 1 WHERE id = 2')).toEqual([])
    expect(analyzeDestructiveScript('UPDATE t SET a = 1')).toEqual([
      { sql: 'UPDATE t SET a = 1', reason: 'UPDATE sin WHERE', allRows: true }
    ])
  })

  it('flags ALTER TABLE … DROP of columns, indexes, keys, constraints and partitions', () => {
    for (const sql of [
      'ALTER TABLE t DROP COLUMN c',
      'ALTER TABLE t DROP c',
      'ALTER TABLE t DROP INDEX i',
      'ALTER TABLE t DROP KEY i',
      'ALTER TABLE t DROP PRIMARY KEY',
      'ALTER TABLE t DROP FOREIGN KEY fk',
      'ALTER TABLE t DROP CONSTRAINT ck',
      'ALTER TABLE t DROP CHECK ck',
      'ALTER TABLE t DROP PARTITION p0',
      'ALTER TABLE t TRUNCATE PARTITION p0',
      'ALTER TABLE t ADD COLUMN x INT, DROP COLUMN y'
    ])
      expect(reasons(sql), sql).toEqual(['ALTER TABLE … DROP'])
  })

  it('ignores ALTER TABLE without drops and DROP DEFAULT', () => {
    expect(reasons('ALTER TABLE t ADD COLUMN drop_at DATETIME')).toEqual([])
    expect(reasons('ALTER TABLE t ALTER COLUMN c DROP DEFAULT')).toEqual([])
    expect(reasons("ALTER TABLE t COMMENT = 'drop me'")).toEqual([])
    expect(reasons('ALTER TABLE t ADD COLUMN `drop` INT')).toEqual([])
  })

  it('never prompts for plain reads and harmless writes', () => {
    expect(
      reasons(
        [
          'SELECT * FROM t WHERE note = "DROP TABLE x"',
          "INSERT INTO log (msg) VALUES ('DELETE FROM t; TRUNCATE t')",
          'UPDATE t SET a = 1 WHERE id = 3',
          'CREATE TABLE x (id INT)',
          'RENAME TABLE a TO b',
          'SHOW TABLES',
          'SELECT deleted_at FROM t'
        ].join(';\n')
      )
    ).toEqual([])
  })

  it('ignores words inside comments', () => {
    expect(reasons('-- DROP TABLE t\nSELECT 1')).toEqual([])
    expect(reasons('# TRUNCATE t\nSELECT 1')).toEqual([])
    expect(reasons('/* DELETE FROM t; */ SELECT 1')).toEqual([])
  })

  it('unwraps executable comments, which MySQL runs', () => {
    expect(reasons('/*!40101 DROP TABLE t */')).toEqual(['DROP TABLE'])
  })

  it('handles several statements and keeps their original text without leading comments', () => {
    const found = analyzeDestructiveScript(
      'SELECT 1;\n-- limpiar\nDELETE FROM `log`;\nINSERT INTO t VALUES (1);\nDROP TABLE `tmp`'
    )
    expect(found.map((s) => s.sql)).toEqual(['DELETE FROM `log`', 'DROP TABLE `tmp`'])
  })

  it('splits DELIMITER blocks like the mysql CLI and does not flag statements inside routine bodies', () => {
    const script = [
      'DROP PROCEDURE IF EXISTS purge;',
      'DELIMITER $$',
      'CREATE PROCEDURE purge()',
      'BEGIN',
      '  DELETE FROM log;',
      '  TRUNCATE stats;',
      'END$$',
      'DELIMITER ;',
      'CALL purge();'
    ].join('\n')
    expect(reasons(script)).toEqual(['DROP PROCEDURE'])
  })

  it('flags DELETE / UPDATE behind a CTE', () => {
    expect(reasons('WITH old AS (SELECT id FROM t WHERE x < 1) DELETE FROM t')).toEqual([
      'DELETE sin WHERE'
    ])
    expect(
      reasons('WITH old AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM old)')
    ).toEqual(['DELETE'])
    expect(reasons('WITH a AS (SELECT 1) SELECT * FROM a FOR UPDATE')).toEqual([])
  })

  it('flags parenthesised statements', () => {
    expect(reasons('(DELETE FROM t)')).toEqual(['DELETE sin WHERE'])
  })
})

describe('confirmation helpers', () => {
  it('builds rows with the all-rows warning and truncated statements', () => {
    const long = `DELETE FROM t WHERE id IN (${Array.from({ length: 200 }, (_, i) => i).join(', ')})`
    const items = destructiveItems(analyzeDestructiveScript(`DELETE FROM t; ${long}`))
    expect(items[0]).toEqual({ tag: 'DELETE', text: 'DELETE FROM t', warning: ALL_ROWS_WARNING })
    expect(items[1].tag).toBe('DELETE')
    expect(items[1].warning).toBeUndefined()
    expect(items[1].text.length).toBeLessThanOrEqual(301)
    expect(items[1].text.endsWith('…')).toBe(true)
    expect(truncateStatement('  DROP TABLE t  ')).toBe('DROP TABLE t')
  })

  it('pluralises the title', () => {
    expect(destructiveTitle(1)).toBe('¿Ejecutar 1 sentencia destructiva?')
    expect(destructiveTitle(2)).toBe('¿Ejecutar 2 sentencias destructivas?')
  })
})
