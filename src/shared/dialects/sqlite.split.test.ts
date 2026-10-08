import { describe, expect, it } from 'vitest'
import {
  isAttachOrDetach,
  leadingKeyword,
  qualified,
  quoteIdent,
  quoteString,
  splitStatements,
  sqliteDialect,
  transactionControl
} from './sqlite'

const sqls = (script: string): string[] => splitStatements(script).map((s) => s.sql)

describe('SQLite splitStatements', () => {
  it('splits on semicolons and reports start lines', () => {
    expect(splitStatements('SELECT 1;\n\n-- note\nSELECT 2;\nSELECT 3')).toEqual([
      { sql: 'SELECT 1', startLine: 1 },
      { sql: '-- note\nSELECT 2', startLine: 4 },
      { sql: 'SELECT 3', startLine: 5 }
    ])
  })

  it('ignores semicolons in strings, identifiers and comments', () => {
    expect(sqls(`SELECT 'a;b', "x;y", [c;d], \`e;f\` /* g; */ FROM t;SELECT--x;\n2`)).toEqual([
      `SELECT 'a;b', "x;y", [c;d], \`e;f\` /* g; */ FROM t`,
      'SELECT--x;\n2'
    ])
  })

  it('drops empty statements', () => {
    expect(sqls(';;  ; -- only a comment\n;SELECT 1;;')).toEqual(['SELECT 1'])
    expect(splitStatements('-- nothing\n/* here */')).toEqual([])
  })

  it('keeps CREATE TRIGGER bodies whole, CASE … END included', () => {
    const trigger = `CREATE TRIGGER trg AFTER INSERT ON t
WHEN NEW.x > 0
BEGIN
  UPDATE c SET n = n + 1;
  INSERT INTO log VALUES (CASE WHEN NEW.x > 10 THEN 'big' ELSE 'small' END);
  SELECT CASE WHEN 1 THEN RAISE(ABORT, 'no;') END;
END`
    expect(sqls(`${trigger};\nSELECT 1;`)).toEqual([trigger, 'SELECT 1'])
    const temp = 'CREATE TEMP TRIGGER IF NOT EXISTS t2 BEFORE DELETE ON t BEGIN DELETE FROM u; END'
    expect(sqls(`${temp}; DELETE FROM t`)).toEqual([temp, 'DELETE FROM t'])
    const temporary = 'create temporary trigger t3 after update on t begin select 1; end'
    expect(sqls(`${temporary};select 2`)).toEqual([temporary, 'select 2'])
  })

  it('treats BEGIN / END outside triggers as ordinary statements', () => {
    expect(
      sqls('BEGIN; INSERT INTO t VALUES (1); END; BEGIN IMMEDIATE TRANSACTION; COMMIT')
    ).toEqual(['BEGIN', 'INSERT INTO t VALUES (1)', 'END', 'BEGIN IMMEDIATE TRANSACTION', 'COMMIT'])
    expect(sqls("SELECT CASE WHEN a THEN 'x' END FROM t; SELECT 2")).toEqual([
      "SELECT CASE WHEN a THEN 'x' END FROM t",
      'SELECT 2'
    ])
  })

  it('normalises CRLF', () => {
    expect(splitStatements('SELECT 1;\r\nSELECT 2')).toEqual([
      { sql: 'SELECT 1', startLine: 1 },
      { sql: 'SELECT 2', startLine: 2 }
    ])
  })
})

describe('SQLite quoting', () => {
  it('quotes keywords and non-plain names only', () => {
    expect(quoteIdent('users')).toBe('users')
    expect(quoteIdent('Users')).toBe('Users')
    expect(quoteIdent('order')).toBe('"order"')
    expect(quoteIdent('a b')).toBe('"a b"')
    expect(quoteIdent('1x')).toBe('"1x"')
    expect(quoteIdent('a"b')).toBe('"a""b"')
    expect(quoteIdent('t', true)).toBe('"t"')
    expect(quoteString("it's \\n")).toBe("'it''s \\n'")
    expect(qualified('aux one', 'order')).toBe('"aux one"."order"')
    expect(qualified(null, 't')).toBe('t')
    expect(sqliteDialect.quoteIdent('select')).toBe('"select"')
  })
})

describe('SQLite statement kinds', () => {
  it('classifies transaction control', () => {
    expect(transactionControl('BEGIN')).toBe('begin')
    expect(transactionControl('begin exclusive transaction;')).toBe('begin')
    expect(transactionControl('COMMIT')).toBe('commit')
    expect(transactionControl('END TRANSACTION')).toBe('commit')
    expect(transactionControl('ROLLBACK')).toBe('rollback')
    expect(transactionControl('ROLLBACK TRANSACTION')).toBe('rollback')
    expect(transactionControl('ROLLBACK TO sp')).toBe('savepoint')
    expect(transactionControl('ROLLBACK TRANSACTION TO SAVEPOINT sp')).toBe('savepoint')
    expect(transactionControl('SAVEPOINT sp')).toBe('savepoint')
    expect(transactionControl('RELEASE sp')).toBe('release')
    expect(transactionControl('/* c */ SELECT 1')).toBeNull()
  })

  it('recognises ATTACH / DETACH and the leading keyword', () => {
    expect(isAttachOrDetach("ATTACH DATABASE '/x.db' AS aux")).toBe(true)
    expect(isAttachOrDetach('-- x\ndetach aux')).toBe(true)
    expect(isAttachOrDetach("SELECT 'ATTACH'")).toBe(false)
    expect(leadingKeyword('  -- c\n  pragma table_info(t)')).toBe('PRAGMA')
    expect(leadingKeyword('-- only')).toBe('')
  })
})
