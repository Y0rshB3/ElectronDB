import { describe, expect, it } from 'vitest'
import {
  postgresqlDialect,
  qualified,
  quoteIdent,
  quoteString,
  splitStatements
} from './postgresql'

const sqls = (script: string): string[] => splitStatements(script).map((s) => s.sql)

describe('PostgreSQL splitStatements', () => {
  it('splits on top-level semicolons and reports start lines', () => {
    expect(splitStatements('SELECT 1;\n\n-- note\nSELECT 2;\nSELECT 3')).toEqual([
      { sql: 'SELECT 1', startLine: 1 },
      { sql: '-- note\nSELECT 2', startLine: 4 },
      { sql: 'SELECT 3', startLine: 5 }
    ])
  })

  it('keeps CREATE FUNCTION bodies in dollar quotes, nested tags included', () => {
    const fn = `CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $body$
BEGIN
  PERFORM $q$;$q$;
  RAISE NOTICE 'hi;';
  RETURN 1;
END;
$body$`
    expect(sqls(`${fn};\nSELECT f();`)).toEqual([fn, 'SELECT f()'])
    expect(sqls("DO $$ BEGIN RAISE NOTICE 'a;b'; END $$; SELECT 1")).toEqual([
      "DO $$ BEGIN RAISE NOTICE 'a;b'; END $$",
      'SELECT 1'
    ])
  })

  it('ignores semicolons in strings, E strings, identifiers and nested comments', () => {
    expect(
      sqls(`SELECT 'a;b', E'it\\'s;', "x;y" /* c; /* d; */ e; */ FROM t;SELECT--x;\n2`)
    ).toEqual([`SELECT 'a;b', E'it\\'s;', "x;y" /* c; /* d; */ e; */ FROM t`, 'SELECT--x;\n2'])
  })

  it('keeps jsonb operators and casts', () => {
    expect(sqls("SELECT d #>> '{a,b}', d ?| array['k'], x::int FROM t; SELECT 2")).toEqual([
      "SELECT d #>> '{a,b}', d ?| array['k'], x::int FROM t",
      'SELECT 2'
    ])
  })

  it('does not split inside parentheses (rules with several actions)', () => {
    expect(
      sqls(
        'CREATE RULE r AS ON INSERT TO t DO ALSO (INSERT INTO a VALUES (1); INSERT INTO b VALUES (2)); SELECT 1'
      )
    ).toEqual([
      'CREATE RULE r AS ON INSERT TO t DO ALSO (INSERT INTO a VALUES (1); INSERT INTO b VALUES (2))',
      'SELECT 1'
    ])
  })

  it('keeps SQL-standard BEGIN ATOMIC bodies whole', () => {
    const fn =
      'CREATE FUNCTION g(a int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN a > 0 THEN 1 ELSE 0 END; SELECT 2; END'
    expect(sqls(`${fn}; SELECT 3`)).toEqual([fn, 'SELECT 3'])
  })

  it('returns psql meta-commands as their own statements', () => {
    expect(splitStatements('SELECT 1;\n\\copy t to stdout\nSELECT 2')).toEqual([
      { sql: 'SELECT 1', startLine: 1 },
      { sql: '\\copy t to stdout', startLine: 2 },
      { sql: 'SELECT 2', startLine: 3 }
    ])
  })

  it('drops empty and comment-only statements', () => {
    expect(sqls(';;  -- only a comment\n/* x */;')).toEqual([])
  })
})

describe('PostgreSQL quoting', () => {
  it('quotes only what case folding or keywords would change', () => {
    expect(quoteIdent('users')).toBe('users')
    expect(quoteIdent('Users')).toBe('"Users"')
    expect(quoteIdent('user')).toBe('"user"')
    expect(quoteIdent('select')).toBe('"select"')
    expect(quoteIdent('a"b')).toBe('"a""b"')
    expect(quoteIdent('a b')).toBe('"a b"')
    expect(quoteIdent('_x$1')).toBe('_x$1')
    expect(quoteIdent('1a')).toBe('"1a"')
    expect(quoteIdent('ñandú')).toBe('"ñandú"')
  })

  it('doubles quotes in strings and leaves backslashes alone', () => {
    expect(quoteString("it's")).toBe("'it''s'")
    expect(quoteString('a\\b')).toBe("'a\\b'")
  })

  it('qualifies with a schema', () => {
    expect(qualified('public', 'Order')).toBe('public."Order"')
    expect(qualified(null, 'order')).toBe('"order"')
    expect(postgresqlDialect.qualified('My Schema', 't')).toBe('"My Schema".t')
  })
})
