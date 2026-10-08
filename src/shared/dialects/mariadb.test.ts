import { describe, expect, it } from 'vitest'
import golden from './golden/mysql.json'
import { mysqlDialect } from './mysql'
import {
  MARIADB_LEX,
  analyzeWrites,
  isObviousWrite,
  mariadbDialect,
  splitStatements
} from './mariadb'

const MARIA_CORPUS = [
  'SELECT NEXTVAL(s)',
  'select nextval ( `app`.`s` )',
  'SELECT SETVAL(s, 100)',
  'SELECT NEXT VALUE FOR s',
  'SELECT LASTVAL(s)',
  'SELECT PREVIOUS VALUE FOR s',
  "SELECT 'nextval(s)'",
  'SELECT `nextval`',
  '/*M!100100 DROP TABLE t */',
  '/*M!100100 SELECT 1 */',
  '/*!50000 DROP TABLE t */',
  '/*M!999999\\- enable the sandbox mode */',
  'SET STATEMENT max_statement_time=1 FOR SELECT * FROM t',
  'SET STATEMENT max_statement_time=1 FOR DELETE FROM t',
  "SET STATEMENT sql_mode='' FOR UPDATE t SET a = 1",
  'SET STATEMENT for_x=1 FOR SELECT 1',
  'INSERT INTO t (a) VALUES (1) RETURNING id',
  'DELETE FROM t WHERE id = 1 RETURNING *',
  'REPLACE INTO t VALUES (1) RETURNING id',
  'DELETE HISTORY FROM t BEFORE SYSTEM_TIME NOW()',
  'SELECT * FROM t FOR SYSTEM_TIME AS OF NOW()',
  'CREATE SEQUENCE s START WITH 1 INCREMENT BY 1',
  'ALTER SEQUENCE s RESTART 10',
  'DROP SEQUENCE s',
  'SHOW CREATE SEQUENCE s',
  '(DELETE FROM t)',
  '((SELECT 1))',
  'EXECUTE IMMEDIATE "DELETE FROM t"',
  'BACKUP STAGE START',
  'SELECT JSON_VALUE(doc, "$.a") FROM t',
  'SELECT s.nextval FROM dual',
  'SELECT s.currval FROM dual',
  'PREPARE st FROM @q',
  'EXECUTE st',
  'BEGIN NOT ATOMIC SELECT 1; END',
  'BEGIN',
  'SET GLOBAL max_connections = 10',
  'SET SESSION sql_mode = "ORACLE"',
  'FLUSH PRIVILEGES',
  'DO 1'
]

describe('MariaDB dialect', () => {
  it('declares /*M! as an executable comment', () => {
    expect(mariadbDialect.id).toBe('mariadb')
    expect(MARIADB_LEX.executableComments).toEqual(['/*!', '/*M!', '/*+'])
    expect(mariadbDialect.quoteIdent('a`b')).toBe('`a``b`')
  })

  it('splits exactly like MySQL when there is no /*M! comment', () => {
    for (const entry of golden.sql.filter((e) => !e.input.includes('/*M!'))) {
      expect(splitStatements(entry.input), entry.input).toEqual(
        mysqlDialect.splitStatements(entry.input)
      )
    }
  })

  it('keeps a /*M! statement as code, with the original text', () => {
    const script =
      "/*M!100616 SET @OLD_NOTE_VERBOSITY=@@NOTE_VERBOSITY, NOTE_VERBOSITY=0 */;\r\nSELECT '/*M!x';\n/* plain */;\nSELECT 2"
    expect(splitStatements(script)).toEqual([
      {
        sql: '/*M!100616 SET @OLD_NOTE_VERBOSITY=@@NOTE_VERBOSITY, NOTE_VERBOSITY=0 */',
        startLine: 1
      },
      { sql: "SELECT '/*M!x'", startLine: 2 },
      { sql: 'SELECT 2', startLine: 4 }
    ])
    // MySQL drops the first one as a comment.
    expect(mysqlDialect.splitStatements(script)[0].sql).toBe("SELECT '/*M!x'")
  })

  it('treats sequence functions and hidden statements as writes', () => {
    for (const sql of [
      'SELECT NEXTVAL(s)',
      'SELECT SETVAL(s, 5)',
      'select next value for s',
      '/*M!100100 DROP TABLE t */',
      'SET STATEMENT max_statement_time=1 FOR DELETE FROM t',
      '(DELETE FROM t)',
      'SELECT s.nextval FROM dual',
      "EXECUTE IMMEDIATE 'DELETE FROM t'",
      'PREPARE st FROM @q',
      'BEGIN NOT ATOMIC DELETE FROM t; END',
      'SET GLOBAL max_connections = 10',
      'FLUSH TABLES',
      'DO RELEASE_LOCK("x")'
    ]) {
      expect(isObviousWrite(sql), sql).toBe(true)
      expect(analyzeWrites(sql).writes, sql).toBe(true)
    }
    expect(analyzeWrites('SELECT NEXTVAL(s)').reasons).toContain('Secuencia (NEXTVAL/SETVAL)')
  })

  it('leaves reads alone', () => {
    for (const sql of [
      'SELECT LASTVAL(s)',
      'SELECT PREVIOUS VALUE FOR s',
      "SELECT 'nextval(s)'",
      '/*M!100100 SELECT 1 */',
      'SELECT * FROM t FOR SYSTEM_TIME ALL',
      'SHOW CREATE SEQUENCE s'
    ]) {
      expect(isObviousWrite(sql), sql).toBe(false)
      expect(analyzeWrites(sql).writes, sql).toBe(false)
    }
  })

  it('main never flags what the renderer lets through (isObviousWrite ⇒ analyzeWrites)', () => {
    const corpus = [...golden.sql.map((e) => e.input), ...MARIA_CORPUS]
    // Pairs and comment-wrapped variants of the corpus.
    const generated: string[] = []
    for (let i = 0; i < MARIA_CORPUS.length; i++) {
      const a = MARIA_CORPUS[i]
      const b = MARIA_CORPUS[(i * 7 + 3) % MARIA_CORPUS.length]
      generated.push(`${a};\n${b}`, `/*M!100000 ${a} */`, `/*!50000 ${a} */`, `-- x\n${a}`)
    }
    for (const script of [...corpus, ...generated]) {
      for (const stmt of splitStatements(script)) {
        if (isObviousWrite(stmt.sql)) {
          expect(analyzeWrites(stmt.sql).writes, stmt.sql).toBe(true)
          expect(analyzeWrites(script).writes, script).toBe(true)
        }
      }
    }
  })

  it('flags at least what MySQL flags', () => {
    for (const entry of golden.sql) {
      if (entry.isObviousWrite) expect(isObviousWrite(entry.input), entry.input).toBe(true)
      if (entry.analyzeWrites.writes)
        expect(analyzeWrites(entry.input).writes, entry.input).toBe(true)
    }
  })
})
