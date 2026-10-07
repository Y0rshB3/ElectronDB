import { describe, expect, it } from 'vitest'
import { splitStatements } from './mysql'

describe('splitStatements', () => {
  it('splits simple statements and drops empty ones', () => {
    const out = splitStatements('SELECT 1;\n\nSELECT 2 ; ;\n  ')
    expect(out).toEqual([
      { sql: 'SELECT 1', startLine: 1 },
      { sql: 'SELECT 2', startLine: 3 }
    ])
  })

  it('keeps a trailing statement without terminator', () => {
    expect(splitStatements('SELECT 1; SELECT 2')).toEqual([
      { sql: 'SELECT 1', startLine: 1 },
      { sql: 'SELECT 2', startLine: 1 }
    ])
  })

  it('ignores semicolons inside single, double and backtick quotes', () => {
    const script = `INSERT INTO t VALUES ('a;b', "c;d", 'it''s', 'x\\';y');\nSELECT \`we;ird\` FROM t;`
    const out = splitStatements(script)
    expect(out.map((s) => s.sql)).toEqual([
      `INSERT INTO t VALUES ('a;b', "c;d", 'it''s', 'x\\';y')`,
      'SELECT `we;ird` FROM t'
    ])
  })

  it('ignores semicolons in -- and # line comments and in block comments', () => {
    const script = [
      '-- first; not a split',
      '# second; neither',
      'SELECT 1; -- trailing; comment',
      '/* multi',
      ' line; comment */ SELECT 2;',
      'SELECT 3 --not-a-comment;'
    ].join('\n')
    const out = splitStatements(script)
    expect(out.map((s) => s.sql)).toEqual([
      '-- first; not a split\n# second; neither\nSELECT 1',
      '-- trailing; comment\n/* multi\n line; comment */ SELECT 2',
      'SELECT 3 --not-a-comment'
    ])
    expect(out.map((s) => s.startLine)).toEqual([3, 5, 6])
  })

  it('keeps executable /*! */ comments inside the statement', () => {
    const out = splitStatements('/*!40101 SET NAMES utf8mb4 */;\nSELECT 1;')
    expect(out.map((s) => s.sql)).toEqual(['/*!40101 SET NAMES utf8mb4 */', 'SELECT 1'])
  })

  it('keeps optimizer hints and starts the statement at a leading /*! */', () => {
    const out = splitStatements(
      '-- c\n/*!50001 CREATE VIEW v AS SELECT 1 */;\nSELECT /*+ MAX_EXECUTION_TIME(5) */ 1;'
    )
    expect(out.map((s) => s.sql)).toEqual([
      '-- c\n/*!50001 CREATE VIEW v AS SELECT 1 */',
      'SELECT /*+ MAX_EXECUTION_TIME(5) */ 1'
    ])
    expect(out.map((s) => s.startLine)).toEqual([2, 3])
  })

  it('honours DELIMITER for stored procedures', () => {
    const script = [
      'DROP PROCEDURE IF EXISTS p;',
      'DELIMITER $$',
      'CREATE PROCEDURE p()',
      'BEGIN',
      '  SELECT 1;',
      "  SELECT 'a$$b';",
      'END$$',
      'DELIMITER ;',
      'CALL p();'
    ].join('\n')
    const out = splitStatements(script)
    expect(out).toEqual([
      { sql: 'DROP PROCEDURE IF EXISTS p', startLine: 1 },
      { sql: "CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 'a$$b';\nEND", startLine: 3 },
      { sql: 'CALL p()', startLine: 9 }
    ])
  })

  it('accepts lower-case delimiter and // style delimiters', () => {
    const script =
      'delimiter //\nCREATE TRIGGER x BEFORE INSERT ON t FOR EACH ROW SET NEW.a = 1;//\ndelimiter ;\nSELECT 1;'
    expect(splitStatements(script).map((s) => s.sql)).toEqual([
      'CREATE TRIGGER x BEFORE INSERT ON t FOR EACH ROW SET NEW.a = 1;',
      'SELECT 1'
    ])
  })

  it('does not treat DELIMITER inside a string as a command', () => {
    const out = splitStatements("SELECT 'x\nDELIMITER $$\ny';\nSELECT 2;")
    expect(out.map((s) => s.sql)).toEqual(["SELECT 'x\nDELIMITER $$\ny'", 'SELECT 2'])
  })

  it('returns nothing for whitespace or comment-only scripts', () => {
    expect(splitStatements('')).toEqual([])
    expect(splitStatements('  \n\t')).toEqual([])
    expect(splitStatements('-- only a comment\n/* and a block */')).toEqual([])
  })

  it('normalises CRLF line endings and counts lines correctly', () => {
    const out = splitStatements('SELECT 1;\r\n\r\nSELECT 2;')
    expect(out[1]).toEqual({ sql: 'SELECT 2', startLine: 3 })
  })
})
