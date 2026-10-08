import { describe, expect, it } from 'vitest'
import type { ColumnInfo, TableStructure } from '@shared/types'
import { mentionsTable } from '@shared/sqlite/rebuild'
import {
  defaultSql,
  renameIdentifiers,
  sqliteBuildAlter,
  sqliteBuildCreatePlan,
  sqliteDraftFromStructure,
  sqliteEmptyColumn,
  sqliteNewTableDraft
} from './planner'

function col(name: string, type: string, over: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    ordinal: 1,
    columnType: type,
    dataType: type.toLowerCase(),
    nullable: true,
    key: '',
    defaultValue: null,
    extra: '',
    characterSet: null,
    collation: null,
    comment: '',
    primaryKey: false,
    autoIncrement: false,
    generated: null,
    ...over
  }
}

const CREATE = `CREATE TABLE item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE CHECK (length(name) > 0),
  price REAL DEFAULT 0,
  qty INTEGER,
  total REAL GENERATED ALWAYS AS (price * qty) VIRTUAL,
  cat INTEGER REFERENCES cat(id) ON DELETE CASCADE,
  CONSTRAINT price_ok CHECK (price >= 0 AND qty >= 0),
  UNIQUE (name, cat)
)`

function structure(over: Partial<TableStructure> = {}): TableStructure {
  return {
    schema: 'main',
    name: 'item',
    kind: 'table',
    tableType: 'BASE TABLE',
    columns: [
      col('id', 'INTEGER', {
        primaryKey: true,
        autoIncrement: true,
        nullable: false,
        extra: 'AUTOINCREMENT',
        key: 'PRI'
      }),
      col('name', 'TEXT', { nullable: false }),
      col('price', 'REAL', { defaultValue: '0' }),
      col('qty', 'INTEGER'),
      col('total', 'REAL', { generated: 'virtual' }),
      col('cat', 'INTEGER')
    ],
    indexes: [
      {
        name: 'PRIMARY',
        unique: true,
        type: 'PRIMARY KEY',
        columns: ['id'],
        comment: '',
        primary: true,
        constraint: 'pk'
      },
      {
        name: 'sqlite_autoindex_item_1',
        unique: true,
        type: 'UNIQUE',
        columns: ['name', 'cat'],
        comment: '',
        primary: false,
        constraint: 'u'
      },
      {
        name: 'ix_item_qty',
        unique: false,
        type: 'INDEX',
        columns: ['qty'],
        comment: '',
        primary: false,
        constraint: null,
        definition: 'CREATE INDEX ix_item_qty ON item(qty) WHERE qty > 0'
      }
    ],
    foreignKeys: [
      {
        name: 'fk_1',
        columns: ['cat'],
        referencedSchema: 'main',
        referencedTable: 'cat',
        referencedColumns: ['id'],
        onUpdate: 'NO ACTION',
        onDelete: 'CASCADE'
      }
    ],
    engine: null,
    collation: null,
    comment: '',
    autoIncrement: 7,
    createSql: CREATE,
    constraints: [],
    options: { withoutRowid: false, strict: false, autoincrement: true, virtual: false },
    ...over
  }
}

describe('SQLite planner: in place', () => {
  it('renames the table and a column, adds a nullable column and changes an index in place', () => {
    const s = structure()
    const draft = sqliteDraftFromStructure(s)
    draft.name = 'items'
    draft.columns[3].name = 'quantity'
    draft.columns.push({ ...sqliteEmptyColumn(), name: 'note', defaultValue: "'x'" })
    draft.indexes[0].columns = ['quantity', 'price']
    const plan = sqliteBuildAlter(s, draft)
    expect(plan.rebuild).toBeUndefined()
    expect(plan.problems).toEqual([])
    expect(plan.statements).toEqual([
      'ALTER TABLE "main".item RENAME TO items',
      'ALTER TABLE "main".items RENAME COLUMN qty TO quantity',
      'DROP INDEX "main".ix_item_qty',
      `ALTER TABLE "main".items ADD COLUMN note TEXT DEFAULT 'x'`,
      'CREATE INDEX "main".ix_item_qty ON items (quantity, price)'
    ])
    expect(plan.request).toMatchObject({ table: 'item', newName: 'items', rebuild: null })
  })

  it('drops a free column in place but rebuilds for indexed, constrained or key columns', () => {
    const s = structure()
    const free = sqliteDraftFromStructure(s)
    free.columns = free.columns.filter((c) => c.name !== 'total')
    expect(sqliteBuildAlter(s, free).statements).toEqual([
      'ALTER TABLE "main".item DROP COLUMN total'
    ])
    const indexed = sqliteDraftFromStructure(s)
    indexed.columns = indexed.columns.filter((c) => c.name !== 'qty')
    indexed.indexes = []
    expect(sqliteBuildAlter(s, indexed).rebuild?.reason).toContain('«qty» está en un índice')
  })

  it('needs no statements when nothing changed', () => {
    const s = structure()
    const plan = sqliteBuildAlter(s, sqliteDraftFromStructure(s))
    expect(plan.statements).toEqual([])
    expect(plan.request).toBeNull()
  })
})

describe('SQLite planner: rebuild', () => {
  it('keeps COLLATE/CHECK/GENERATED text, regenerates the changed column and the FKs', () => {
    const s = structure()
    const draft = sqliteDraftFromStructure(s)
    draft.columns[2].columnType = 'NUMERIC'
    draft.columns[2].nullable = false
    const plan = sqliteBuildAlter(s, draft)
    expect(plan.rebuild?.reason).toContain('«price»')
    expect(plan.risks.join('\n')).toContain('pasa a NOT NULL')
    const def = plan.request!.rebuild!
    expect(def.createBody).toBe(
      [
        '(',
        '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
        '  name TEXT NOT NULL COLLATE NOCASE CHECK (length(name) > 0),',
        '  price NUMERIC NOT NULL DEFAULT 0,',
        '  qty INTEGER,',
        '  total REAL GENERATED ALWAYS AS (price * qty) VIRTUAL,',
        '  cat INTEGER,',
        '  CONSTRAINT price_ok CHECK (price >= 0 AND qty >= 0),',
        '  UNIQUE (name, cat),',
        '  FOREIGN KEY (cat) REFERENCES cat (id) ON DELETE CASCADE',
        ')'
      ].join('\n')
    )
    // Generated columns are not copied; the rowid is the INTEGER PRIMARY KEY.
    expect(def.columnMap.map((c) => c.target)).toEqual(['id', 'name', 'price', 'qty', 'cat'])
    expect(def.keepRowid).toBe(false)
    expect(def.autoincrement).toBe(true)
    // The partial index keeps its original text.
    expect(def.indexes).toEqual(['CREATE INDEX ix_item_qty ON item(qty) WHERE qty > 0'])
  })

  it('renames columns inside carried constraints and indexes', () => {
    const s = structure()
    const draft = sqliteDraftFromStructure(s)
    draft.columns[2].name = 'cost'
    draft.columns[2].columnType = 'NUMERIC'
    draft.columns[3].name = 'n'
    const def = sqliteBuildAlter(s, draft).request!.rebuild!
    expect(def.createBody).toContain('total REAL GENERATED ALWAYS AS (cost * n) VIRTUAL')
    expect(def.createBody).toContain('CONSTRAINT price_ok CHECK (cost >= 0 AND n >= 0)')
    expect(def.indexes).toEqual(['CREATE INDEX ix_item_qty ON item(n) WHERE n > 0'])
    expect(def.columnMap).toContainEqual({ target: 'cost', source: 'price' })
  })

  it('refuses a carried constraint that uses a dropped column', () => {
    const s = structure()
    const draft = sqliteDraftFromStructure(s)
    draft.columns = draft.columns.filter((c) => c.name !== 'price')
    const plan = sqliteBuildAlter(s, draft)
    expect(plan.problems.some((p) => p.includes('columna eliminada «price»'))).toBe(true)
    expect(plan.request).toBeNull()
  })

  it('rebuilds for WITHOUT ROWID / STRICT, key changes and moved columns', () => {
    const s = structure()
    const strict = sqliteDraftFromStructure(s)
    strict.options = { withoutRowid: false, strict: true }
    expect(sqliteBuildAlter(s, strict).request!.rebuild!.createBody.endsWith(') STRICT')).toBe(true)
    const noAuto = sqliteDraftFromStructure(s)
    noAuto.columns[0].autoIncrement = false
    const plan = sqliteBuildAlter(s, noAuto)
    expect(plan.rebuild?.reason).toBe('cambia la clave primaria')
    expect(plan.request!.rebuild!.createBody).toContain('id INTEGER PRIMARY KEY,')
    expect(plan.request!.rebuild!.autoincrement).toBe(false)
    const moved = sqliteDraftFromStructure(s)
    moved.columns.unshift(moved.columns.splice(3, 1)[0])
    expect(sqliteBuildAlter(s, moved).rebuild?.reason).toBe('cambia el orden de las columnas')
  })

  it('only offers AUTOINCREMENT on a single INTEGER PRIMARY KEY', () => {
    const s = structure()
    const draft = sqliteDraftFromStructure(s)
    draft.columns[3].autoIncrement = true
    expect(sqliteBuildAlter(s, draft).problems[0]).toContain('AUTOINCREMENT solo se puede usar')
  })
})

describe('SQLite planner: create', () => {
  it('creates a table with an INTEGER PRIMARY KEY, FKs, options and indexes', () => {
    const draft = sqliteNewTableDraft()
    draft.name = 'order'
    draft.columns[0].autoIncrement = true
    draft.columns.push({
      ...sqliteEmptyColumn(),
      name: 'ref',
      nullable: false,
      defaultValue: "lower('X')"
    })
    draft.indexes.push({
      id: 'i',
      originalName: null,
      name: 'ix_ref',
      unique: true,
      type: 'INDEX',
      columns: ['ref'],
      comment: ''
    })
    draft.options = { withoutRowid: false, strict: true }
    const plan = sqliteBuildCreatePlan('main', draft)
    expect(plan.statements).toEqual([
      `CREATE TABLE "main"."order" (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  ref TEXT NOT NULL DEFAULT (lower('X'))\n) STRICT`,
      'CREATE UNIQUE INDEX "main".ix_ref ON "order" (ref)'
    ])
    expect(plan.request).toMatchObject({ table: null, newName: 'order', rebuild: null })
  })
})

describe('helpers', () => {
  it('quotes DEFAULT expressions only when needed', () => {
    expect(defaultSql('0')).toBe('0')
    expect(defaultSql("'a''b'")).toBe("'a''b'")
    expect(defaultSql('CURRENT_TIMESTAMP')).toBe('CURRENT_TIMESTAMP')
    expect(defaultSql("datetime('now')")).toBe("(datetime('now'))")
    expect(defaultSql('(1 + 1)')).toBe('(1 + 1)')
  })

  it('renames identifiers token by token, never inside strings', () => {
    expect(renameIdentifiers(`CHECK (qty > 0 AND 'qty' <> "qty")`, new Map([['qty', 'n']]))).toBe(
      `CHECK (n > 0 AND 'qty' <> n)`
    )
    expect(mentionsTable(`SELECT 'item' FROM other`, 'item')).toBe(false)
    expect(mentionsTable('SELECT * FROM "Item"', 'item')).toBe(true)
  })
})
