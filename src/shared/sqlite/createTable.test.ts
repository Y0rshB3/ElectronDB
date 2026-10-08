import { describe, expect, it } from 'vitest'
import { clauseOf, collationOf, hasAutoincrement, parseCreateTable } from './createTable'
import { affinityOf, sqliteTypeKind } from './affinity'

describe('parseCreateTable', () => {
  it('keeps every column definition and its clauses as written', () => {
    const sql = `CREATE TABLE "order items" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      [name] VARCHAR(40) NOT NULL COLLATE NOCASE DEFAULT 'x, y',
      price DECIMAL(10, 2) CONSTRAINT positive CHECK (price > 0) DEFAULT NULL,
      cat INT REFERENCES cats(id) ON DELETE SET NULL NOT NULL,
      total REAL GENERATED ALWAYS AS (price * 2) STORED,
      note,
      CONSTRAINT uq UNIQUE (name, cat),
      CHECK (length(name) > 0),
      FOREIGN KEY (cat) REFERENCES cats (id) ON UPDATE CASCADE
    ) WITHOUT ROWID, STRICT`
    const t = parseCreateTable(sql)
    expect(t.parsed).toBe(true)
    expect(t.name).toBe('order items')
    expect(t.withoutRowid).toBe(true)
    expect(t.strict).toBe(true)
    expect(t.columns.map((c) => [c.name, c.type])).toEqual([
      ['id', 'INTEGER'],
      ['name', 'VARCHAR(40)'],
      ['price', 'DECIMAL(10, 2)'],
      ['cat', 'INT'],
      ['total', 'REAL'],
      ['note', '']
    ])
    expect(t.columns[0].clauses.map((c) => c.kind)).toEqual(['primary'])
    expect(t.columns[0].clauses[0].body).toBe('AUTOINCREMENT')
    expect(t.columns[1].clauses.map((c) => c.kind)).toEqual(['notnull', 'collate', 'default'])
    expect(clauseOf(t.columns[1], 'default')?.body).toBe("'x, y'")
    expect(collationOf(t.columns[1])).toBe('NOCASE')
    const price = t.columns[2].clauses
    expect(price.map((c) => [c.kind, c.name])).toEqual([
      ['check', 'positive'],
      ['default', null]
    ])
    expect(price[0].text).toBe('CONSTRAINT positive CHECK (price > 0)')
    expect(price[1].body).toBe('NULL')
    expect(t.columns[3].clauses.map((c) => c.kind)).toEqual(['references', 'notnull'])
    expect(t.columns[3].clauses[0].text).toBe('REFERENCES cats(id) ON DELETE SET NULL')
    expect(t.columns[4].clauses.map((c) => c.kind)).toEqual(['generated'])
    expect(t.columns[4].clauses[0].body).toBe('(price * 2) STORED')
    expect(t.constraints.map((c) => [c.kind, c.name, c.columns])).toEqual([
      ['unique', 'uq', ['name', 'cat']],
      ['check', null, []],
      ['foreign', null, ['cat']]
    ])
  })

  it('reads qualified and temporary names, and refuses other shapes', () => {
    expect(parseCreateTable('CREATE TEMP TABLE IF NOT EXISTS aux.t (a)')).toMatchObject({
      parsed: true,
      temp: true,
      schema: 'aux',
      name: 't'
    })
    expect(parseCreateTable('CREATE TABLE t AS SELECT 1').parsed).toBe(false)
    expect(parseCreateTable('CREATE VIRTUAL TABLE f USING fts5(a)').parsed).toBe(false)
    expect(parseCreateTable(null).parsed).toBe(false)
  })

  it('finds AUTOINCREMENT only as a keyword', () => {
    expect(hasAutoincrement('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)')).toBe(true)
    expect(hasAutoincrement("CREATE TABLE t (a TEXT DEFAULT 'AUTOINCREMENT')")).toBe(false)
  })
})

describe('affinity', () => {
  it('follows the five SQLite rules', () => {
    expect(affinityOf('BIGINT')).toBe('INTEGER')
    expect(affinityOf('VARCHAR(10)')).toBe('TEXT')
    expect(affinityOf('')).toBe('BLOB')
    expect(affinityOf('DOUBLE PRECISION')).toBe('REAL')
    expect(affinityOf('DECIMAL(10,2)')).toBe('NUMERIC')
    expect(affinityOf('POINT')).toBe('INTEGER') // contains INT, as in SQLite
    expect(affinityOf('MONEY')).toBe('NUMERIC')
  })

  it('maps declared types to type kinds', () => {
    expect(sqliteTypeKind('DATETIME')).toBe('datetime')
    expect(sqliteTypeKind('date')).toBe('date')
    expect(sqliteTypeKind('INTEGER')).toBe('integer')
    expect(sqliteTypeKind('BOOLEAN')).toBe('integer')
    expect(sqliteTypeKind('TEXT')).toBe('text')
    expect(sqliteTypeKind('JSON')).toBe('json')
    expect(sqliteTypeKind('BLOB')).toBe('binary')
    expect(sqliteTypeKind('')).toBe('other')
    expect(sqliteTypeKind('REAL')).toBe('float')
    expect(sqliteTypeKind('NUMERIC')).toBe('decimal')
  })
})
