import { describe, expect, it } from 'vitest'
import { isObviousWrite, leadingKeyword } from './productionGuard'

describe('leadingKeyword', () => {
  it('skips whitespace and comments', () => {
    expect(leadingKeyword('  /* a */ -- b\n# c\n  delete from t')).toBe('DELETE')
    expect(leadingKeyword('--\nSELECT 1')).toBe('SELECT')
    expect(leadingKeyword('/* unterminated')).toBe('')
  })
})

describe('isObviousWrite', () => {
  it('flags data, structure and privilege changes', () => {
    for (const sql of [
      'INSERT INTO t VALUES (1)',
      'update t set a = 1',
      'DELETE FROM t',
      'REPLACE INTO t VALUES (1)',
      'DROP TABLE t',
      'CREATE TABLE t (id int)',
      'ALTER TABLE t ADD c int',
      'TRUNCATE t',
      'RENAME TABLE a TO b',
      'GRANT SELECT ON *.* TO x',
      'REVOKE ALL ON *.* FROM x',
      "LOAD DATA INFILE 'f' INTO TABLE t",
      'CALL p()'
    ]) {
      expect(isObviousWrite(sql), sql).toBe(true)
    }
  })

  it('leaves read-only statements alone', () => {
    for (const sql of [
      'SELECT 1',
      'SHOW TABLES',
      'DESCRIBE t',
      'EXPLAIN SELECT 1',
      'USE app',
      'SET @a = 1'
    ]) {
      expect(isObviousWrite(sql), sql).toBe(false)
    }
  })
})
