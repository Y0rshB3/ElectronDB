import { describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { sql } from '@codemirror/lang-sql'
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import {
  cachedSqlite,
  insideSqliteLiteral,
  sqliteCompletionSource,
  sqliteIdentName,
  sqliteQuoteIdent,
  sqliteTableRefs,
  vortaqSQLite,
  type SqliteSchemaProvider
} from './sqliteCompletion'

const META: Record<string, Record<string, string[]>> = {
  main: { orders: ['id', 'total', 'CreatedAt'], 'Order Items': ['id', 'order'], users: ['id'] },
  temp: { scratch: ['x'] },
  aux: { log: ['at', 'what'] }
}

function provider(db: string | null = 'main'): SqliteSchemaProvider {
  return {
    databases: vi.fn(async () => Object.keys(META)),
    defaultDatabase: () => db,
    tables: vi.fn(async (d: string) =>
      Object.keys(META[d] ?? {}).map((name) => ({
        name,
        kind: name === 'users' ? ('view' as const) : ('table' as const)
      }))
    ),
    columns: vi.fn(async (d: string, t: string) =>
      (META[d]?.[t] ?? []).map((name) => ({ name, type: 'INTEGER' }))
    )
  }
}

async function complete(
  doc: string,
  p = provider(),
  explicit = false
): Promise<CompletionResult | null> {
  const pos = doc.indexOf('|')
  const text = doc.replace('|', '')
  const state = EditorState.create({ doc: text, extensions: sql({ dialect: vortaqSQLite }) })
  return sqliteCompletionSource(p)(
    new CompletionContext(state, pos, explicit)
  ) as Promise<CompletionResult | null>
}

const labels = (r: CompletionResult | null): string[] =>
  (r?.options ?? []).map((o) => o.displayLabel ?? o.label)
const option = (r: CompletionResult | null, name: string) =>
  r?.options.find((o) => (o.displayLabel ?? o.label) === name)

describe('quoting helpers', () => {
  it('quotes keywords and special names only (SQLite is case-insensitive)', () => {
    expect(sqliteQuoteIdent('users')).toBe('users')
    expect(sqliteQuoteIdent('MyTable')).toBe('MyTable')
    expect(sqliteQuoteIdent('order')).toBe('"order"')
    expect(sqliteQuoteIdent('Order Items')).toBe('"Order Items"')
    expect(sqliteQuoteIdent('a"b')).toBe('"a""b"')
    expect(sqliteQuoteIdent('users', true)).toBe('"users"')
  })

  it('unquotes every SQLite identifier form', () => {
    expect(sqliteIdentName('"a""b"')).toBe('a"b')
    expect(sqliteIdentName('[Order Items]')).toBe('Order Items')
    expect(sqliteIdentName('`x``y`')).toBe('x`y')
    expect(sqliteIdentName('Plain')).toBe('Plain')
    expect(sqliteIdentName('"open')).toBe('open')
  })
})

describe('sqliteTableRefs', () => {
  it('reads tables, databases, aliases and FROM lists', () => {
    expect(
      sqliteTableRefs('SELECT * FROM orders o, aux.log AS l JOIN [Order Items] i ON i.id = o.id')
    ).toEqual([
      { database: null, table: 'orders', alias: 'o' },
      { database: 'aux', table: 'log', alias: 'l' },
      { database: null, table: 'Order Items', alias: 'i' }
    ])
  })

  it('handles UPDATE OR …, INSERT INTO and backticks; skips table-valued functions', () => {
    expect(sqliteTableRefs('UPDATE OR IGNORE `orders` SET total = 1')).toEqual([
      { database: null, table: 'orders', alias: null }
    ])
    expect(sqliteTableRefs('INSERT INTO "main"."users"(id) VALUES (1)')).toEqual([
      { database: 'main', table: 'users', alias: null }
    ])
    expect(sqliteTableRefs("SELECT * FROM pragma_table_info('orders')")).toEqual([])
  })

  it('ignores names inside strings and comments', () => {
    expect(sqliteTableRefs("SELECT 'FROM fake' -- FROM nope\n/* FROM x */ FROM users")).toEqual([
      { database: null, table: 'users', alias: null }
    ])
  })
})

describe('insideSqliteLiteral', () => {
  it('detects open strings and comments, not open identifiers', () => {
    expect(insideSqliteLiteral("SELECT 'abc")).toBe(true)
    expect(insideSqliteLiteral("SELECT 'it''s")).toBe(true)
    expect(insideSqliteLiteral("SELECT 'done' ")).toBe(false)
    expect(insideSqliteLiteral('SELECT 1 -- note')).toBe(true)
    expect(insideSqliteLiteral('SELECT /* open')).toBe(true)
    expect(insideSqliteLiteral('SELECT "open')).toBe(false)
    expect(insideSqliteLiteral('SELECT [open')).toBe(false)
  })
})

describe('sqliteCompletionSource', () => {
  it('offers the tab database tables and the aliases after FROM', async () => {
    const r = await complete('SELECT * FROM o|')
    expect(labels(r)).toEqual(
      expect.arrayContaining(['orders', 'Order Items', 'users', 'main', 'temp', 'aux'])
    )
    expect(labels(r)).not.toContain('log')
    expect(labels(r)).not.toContain('SELECT')
    expect(option(r, 'Order Items')?.label).toBe('"Order Items"')
    expect(option(r, 'users')?.detail).toBe('vista · main')
  })

  it('offers the tables of an attached database after `aux.`', async () => {
    const r = await complete('SELECT * FROM aux.|')
    expect(labels(r)).toEqual(['log'])
  })

  it('offers columns after an alias, a table and db.table', async () => {
    expect(labels(await complete('SELECT o.| FROM orders o'))).toEqual(['id', 'total', 'CreatedAt'])
    expect(labels(await complete('SELECT ORDERS.| FROM orders'))).toEqual(
      expect.arrayContaining(['id', 'total'])
    )
    expect(labels(await complete('SELECT aux.log.| FROM aux.log'))).toEqual(['at', 'what'])
    expect(labels(await complete('SELECT l.| FROM aux.log l'))).toEqual(['at', 'what'])
    expect(labels(await complete('SELECT i.| FROM [Order Items] i'))).toEqual(['id', 'order'])
  })

  it('quotes keyword columns on insert', async () => {
    const r = await complete('SELECT i.| FROM [Order Items] i')
    expect(option(r, 'order')?.label).toBe('"order"')
  })

  it('offers columns in scope, functions and keywords for a bare word', async () => {
    const r = await complete('SELECT t| FROM orders WHERE 1')
    expect(labels(r)).toEqual(expect.arrayContaining(['total', 'orders', 'typeof', 'TABLE']))
  })

  it('resolves unqualified tables through temp after the tab database', async () => {
    expect(labels(await complete('SELECT s.| FROM scratch s'))).toEqual(['x'])
  })

  it('offers pragma names after PRAGMA', async () => {
    const r = await complete('PRAGMA table_|')
    expect(labels(r)).toEqual(expect.arrayContaining(['table_info', 'foreign_keys']))
    expect(labels(r)).not.toContain('orders')
  })

  it('stays quiet inside strings and comments, and on an empty implicit word', async () => {
    expect(await complete("SELECT 'or|' FROM orders")).toBeNull()
    expect(await complete('SELECT 1 -- or|')).toBeNull()
    expect(await complete('SELECT |')).toBeNull()
    expect(await complete('SELECT |', provider(), true)).not.toBeNull()
  })

  it('completes an opened quoted identifier and replaces through the closing quote', async () => {
    const r = await complete('SELECT * FROM "Ord|"')
    const opt = option(r, 'Order Items')
    expect(opt?.label).toBe('"Order Items"')
    const doc = 'SELECT * FROM "Ord"'
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: sql({ dialect: vortaqSQLite }) })
    })
    const apply = opt!.apply as (v: EditorView, c: typeof opt, f: number, t: number) => void
    apply(view, opt, r!.from, doc.length - 1)
    expect(view.state.doc.toString()).toBe('SELECT * FROM "Order Items"')
    view.destroy()
  })

  it('falls back to main when the tab has no database', async () => {
    const r = await complete('SELECT * FROM |', provider(null), true)
    expect(option(r, 'orders')?.detail).toBe('tabla · main')
  })

  it('caches per database and table; clear() reloads', async () => {
    const p = provider()
    const c = cachedSqlite(p)
    await c.tables('main')
    await c.tables('MAIN')
    await c.columns('main', 'orders')
    await c.columns('main', 'ORDERS')
    expect(p.tables).toHaveBeenCalledTimes(1)
    expect(p.columns).toHaveBeenCalledTimes(1)
    c.clear()
    await c.tables('main')
    expect(p.tables).toHaveBeenCalledTimes(2)
  })
})
