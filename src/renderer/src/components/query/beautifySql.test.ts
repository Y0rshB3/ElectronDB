import { describe, expect, it } from 'vitest'
import { beautifySql } from './beautifySql'

describe('beautifySql', () => {
  it('puts each clause on its own line with tab-indented contents, like Navicat', () => {
    const { sql, structured } = beautifySql(
      "select u.id, u.email, count(s.id) as sesiones from accounts.users u left join accounts.session s on s.userID = u.id where u.email like '%select%' group by u.id order by sesiones desc limit 10"
    )
    expect(structured).toBe(true)
    expect(sql).toBe(
      [
        'SELECT',
        '\tu.id,',
        '\tu.email,',
        '\tCOUNT(s.id) AS sesiones',
        'FROM',
        '\taccounts.users u',
        '\tLEFT JOIN accounts.session s ON s.userID = u.id',
        'WHERE',
        "\tu.email LIKE '%select%'",
        'GROUP BY',
        '\tu.id',
        'ORDER BY',
        '\tsesiones DESC',
        'LIMIT',
        '\t10'
      ].join('\n')
    )
  })

  it('keeps strings, backticked identifiers and comments intact and separates statements', () => {
    const { sql } = beautifySql(
      "select `order` from t -- from here\n; update t set note = 'from x' where id = 1;"
    )
    expect(sql).toContain('`order`')
    expect(sql).toContain('-- from here')
    expect(sql).toContain("'from x'")
    expect(sql).toMatch(/;\n\nUPDATE/)
  })

  it('leaves DELIMITER blocks laid out as written and formats the SQL around them', () => {
    const src = [
      'select 1;',
      'DELIMITER $$',
      'create procedure p()',
      'begin',
      '  select 2;',
      'end$$',
      'DELIMITER ;',
      'call p();'
    ].join('\n')
    const { sql } = beautifySql(src)
    expect(sql).toContain(
      'DELIMITER $$\n\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 2;\nEND$$\n\nDELIMITER ;'
    )
    expect(sql.startsWith('SELECT\n\t1;')).toBe(true)
    expect(sql.trim().endsWith('CALL p();')).toBe(true)
  })

  it('falls back to keyword upper-casing when the input cannot be parsed', () => {
    const { sql, structured } = beautifySql("select 'unterminated from t")
    expect(structured).toBe(false)
    expect(sql.startsWith('SELECT')).toBe(true)
  })

  it('returns blank input unchanged', () => {
    expect(beautifySql('  \n')).toEqual({ sql: '  \n', structured: true })
  })
})
