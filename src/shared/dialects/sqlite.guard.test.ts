import { describe, expect, it } from 'vitest'
import {
  analyzeDestructiveSqlite,
  analyzeWrites,
  explainSqliteError,
  isObviousWrite,
  isSqlitePrivilegeError,
  splitStatements,
  sqliteDialect
} from './sqlite'

/** [statement, renderer reasons ([] = read), main denylist] */
const CORPUS: [string, string[], boolean][] = [
  // reads
  ['SELECT * FROM t', [], false],
  ["select replace(name, 'a', 'b') from t", [], false],
  ["SELECT 'DELETE FROM t' /* UPDATE t SET x = 1 */ -- INSERT INTO t", [], false],
  ['SELECT "update", [delete], `insert` FROM "replace"', [], false],
  ['VALUES (1), (2)', [], false],
  ['WITH x AS (SELECT 1) SELECT * FROM x', [], false],
  ['WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT * FROM r', [], false],
  ['EXPLAIN SELECT 1', [], false],
  ['EXPLAIN QUERY PLAN SELECT * FROM t WHERE a = 1', [], false],
  ['PRAGMA table_info(t)', [], false],
  ["PRAGMA main.table_xinfo('t')", [], false],
  ['PRAGMA table_list', [], false],
  ['PRAGMA index_list(t)', [], false],
  ['PRAGMA index_xinfo(ix)', [], false],
  ['PRAGMA foreign_key_list(t)', [], false],
  ['PRAGMA foreign_key_check', [], false],
  ['PRAGMA aux.foreign_key_check(t)', [], false],
  ['PRAGMA database_list', [], false],
  ['PRAGMA integrity_check', [], false],
  ['PRAGMA quick_check(10)', [], false],
  ['PRAGMA compile_options', [], false],
  ['PRAGMA page_count', [], false],
  ['PRAGMA freelist_count', [], false],
  ['PRAGMA query_only', [], false],
  ['PRAGMA foreign_keys', [], false],
  ['PRAGMA main.journal_mode', [], false],
  ['PRAGMA user_version', [], false],
  ['PRAGMA encoding', [], false],
  ['BEGIN', [], false],
  ['BEGIN IMMEDIATE TRANSACTION', [], false],
  ['COMMIT', [], false],
  ['END', [], false],
  ['ROLLBACK', [], false],
  ['ROLLBACK TO sp', [], false],
  ['SAVEPOINT sp', [], false],
  ['RELEASE sp', [], false],
  // writes the main denylist also blocks
  ['INSERT INTO t VALUES (1)', ['INSERT'], true],
  ['INSERT OR REPLACE INTO t VALUES (1)', ['INSERT'], true],
  ['REPLACE INTO t VALUES (1)', ['REPLACE'], true],
  ['UPDATE t SET a = 1 WHERE id = 2', ['UPDATE'], true],
  ['UPDATE OR IGNORE t SET a = 1', ['UPDATE sin WHERE'], true],
  ['DELETE FROM t', ['DELETE sin WHERE'], true],
  ['DELETE FROM t WHERE id IN (SELECT id FROM u WHERE x)', ['DELETE'], true],
  ['WITH t AS (SELECT 1) DELETE FROM users', ['DELETE sin WHERE'], true],
  ['WITH t AS (SELECT 1) INSERT INTO u SELECT * FROM t', ['INSERT'], true],
  ['WITH t AS (SELECT 1) UPDATE u SET a = 1 WHERE b', ['UPDATE'], true],
  ['CREATE TABLE t (a)', ['CREATE TABLE'], true],
  ['CREATE TEMP TABLE t (a)', ['CREATE TABLE'], true],
  ['CREATE UNIQUE INDEX ix ON t (a)', ['CREATE INDEX'], true],
  ['CREATE VIRTUAL TABLE f USING fts5(a)', ['CREATE VIRTUAL TABLE'], true],
  ['CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END', ['CREATE TRIGGER'], true],
  ['ALTER TABLE t ADD COLUMN b', ['ALTER TABLE'], true],
  ['DROP TABLE IF EXISTS t', ['DROP TABLE'], true],
  ['DROP VIEW v', ['DROP VIEW'], true],
  ['VACUUM', ['VACUUM'], true],
  ["VACUUM INTO '/tmp/x.db'", ['VACUUM'], true],
  ['REINDEX', ['REINDEX'], true],
  ["ATTACH DATABASE '/x.db' AS aux", ['ATTACH'], true],
  ['DETACH aux', ['DETACH'], true],
  ['PRAGMA query_only = 0', ['PRAGMA de escritura: query_only'], true],
  ['PRAGMA query_only(0)', ['PRAGMA de escritura: query_only'], true],
  ['PRAGMA main.foreign_keys = ON', ['PRAGMA de escritura: foreign_keys'], true],
  ["PRAGMA journal_mode = 'wal'", ['PRAGMA de escritura: journal_mode'], true],
  ['PRAGMA user_version = 3', ['PRAGMA de escritura: user_version'], true],
  ['PRAGMA table_info = 1', ['PRAGMA de escritura: table_info'], true],
  ['PRAGMA wal_checkpoint(TRUNCATE)', ['PRAGMA de escritura: wal_checkpoint'], true],
  ['PRAGMA incremental_vacuum(10)', ['PRAGMA de escritura: incremental_vacuum'], true],
  // writes only the renderer flags (allowlist)
  ['ANALYZE', ['ANALYZE'], false],
  ['PRAGMA optimize', ['PRAGMA de escritura: optimize'], false],
  ['PRAGMA wal_checkpoint', ['PRAGMA de escritura: wal_checkpoint'], false],
  ['PRAGMA shrink_memory', ['PRAGMA de escritura: shrink_memory'], false],
  ['PRAGMA writable_schema', ['PRAGMA de escritura: writable_schema'], false],
  ['EXPLAIN DELETE FROM t', ['EXPLAIN de una escritura'], false],
  ["SELECT load_extension('x')", ['Función con efectos: load_extension'], false],
  ['SELECT * FROM t RETURNING x', [], false],
  ['FOO BAR', ['FOO'], false]
]

describe('SQLite analyzeWrites / isObviousWrite', () => {
  it.each(CORPUS)('%s', (sql, reasons, obvious) => {
    expect(analyzeWrites(sql)).toEqual({ writes: reasons.length > 0, reasons })
    expect(isObviousWrite(sql)).toBe(obvious)
  })

  it('main never flags what the renderer lets through (property over the corpus)', () => {
    for (const [sql] of CORPUS) {
      for (const { sql: stmt } of splitStatements(sql)) {
        if (isObviousWrite(stmt)) expect(analyzeWrites(stmt).writes, stmt).toBe(true)
      }
    }
  })

  it('catches the query_only bypass as two writes', () => {
    const script = 'PRAGMA query_only(0); WITH t AS (SELECT 1) DELETE FROM users'
    expect(analyzeWrites(script)).toEqual({
      writes: true,
      reasons: ['PRAGMA de escritura: query_only', 'DELETE sin WHERE']
    })
    expect(splitStatements(script).map((s) => isObviousWrite(s.sql))).toEqual([true, true])
  })

  it('collects the reasons of every statement once', () => {
    expect(analyzeWrites('SELECT 1; DELETE FROM a; DELETE FROM b; VACUUM')).toEqual({
      writes: true,
      reasons: ['DELETE sin WHERE', 'VACUUM']
    })
    expect(analyzeWrites('')).toEqual({ writes: false, reasons: [] })
  })

  it('is exposed by the dialect object', () => {
    expect(sqliteDialect.analyzeWrites('DROP TABLE t').writes).toBe(true)
    expect(sqliteDialect.isObviousWrite('SELECT 1')).toBe(false)
  })
})

describe('SQLite analyzeDestructive', () => {
  it('lists drops, deletes, updates without WHERE and ALTER … DROP', () => {
    expect(
      analyzeDestructiveSqlite(
        [
          '-- clean up\nDROP TABLE t',
          'DROP INDEX ix',
          'DROP TRIGGER tr',
          'DELETE FROM a WHERE id = 1',
          'DELETE FROM b',
          'UPDATE c SET x = 1',
          'UPDATE d SET x = 1 WHERE id = 2',
          'ALTER TABLE e DROP COLUMN f',
          'ALTER TABLE e2 ALTER COLUMN g DROP NOT NULL',
          'WITH x AS (SELECT 1) DELETE FROM g WHERE id IN x',
          'SELECT 1'
        ].join(';\n')
      )
    ).toEqual([
      { sql: 'DROP TABLE t', reason: 'DROP TABLE', allRows: false },
      { sql: 'DROP INDEX ix', reason: 'DROP INDEX', allRows: false },
      { sql: 'DROP TRIGGER tr', reason: 'DROP TRIGGER', allRows: false },
      { sql: 'DELETE FROM a WHERE id = 1', reason: 'DELETE', allRows: false },
      { sql: 'DELETE FROM b', reason: 'DELETE sin WHERE', allRows: true },
      { sql: 'UPDATE c SET x = 1', reason: 'UPDATE sin WHERE', allRows: true },
      { sql: 'ALTER TABLE e DROP COLUMN f', reason: 'ALTER TABLE … DROP', allRows: false },
      {
        sql: 'WITH x AS (SELECT 1) DELETE FROM g WHERE id IN x',
        reason: 'DELETE',
        allRows: false
      }
    ])
  })

  it('ignores DML inside a trigger body', () => {
    expect(
      analyzeDestructiveSqlite('CREATE TRIGGER t AFTER INSERT ON a BEGIN DELETE FROM b; END')
    ).toEqual([])
  })
})

describe('SQLite errors', () => {
  it('explains the extended result codes', () => {
    expect(explainSqliteError('2067')).toMatch(/UNIQUE/)
    expect(explainSqliteError('787')).toMatch(/clave foránea/)
    expect(explainSqliteError('1299')).toMatch(/NOT NULL/)
    expect(explainSqliteError('8')).toMatch(/solo lectura/)
    expect(explainSqliteError('5')).toMatch(/bloqueado/)
    expect(explainSqliteError('3091')).toMatch(/STRICT/)
    expect(explainSqliteError('99999')).toBeNull()
    expect(isSqlitePrivilegeError('23')).toBe(true)
    expect(isSqlitePrivilegeError('8')).toBe(false)
    expect(sqliteDialect.explainError?.('1555')).toMatch(/clave primaria/)
  })
})
