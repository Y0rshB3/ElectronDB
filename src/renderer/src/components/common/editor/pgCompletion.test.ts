import { describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { sql } from '@codemirror/lang-sql'
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import {
  cachedPg,
  insideLiteral,
  pgCompletionSource,
  pgQuoteIdent,
  pgTableRefs,
  vortaqPostgreSQL,
  type PgSchemaProvider
} from './pgCompletion'

const META: Record<string, Record<string, string[]>> = {
  app: { orders: ['id', 'total', 'CreatedAt'], MyTable: ['Id', 'user'] },
  public: { users: ['id', 'email'], spatial_ref_sys: ['srid'], orders: ['shadowed'] },
  audit: { log: ['at', 'what'] }
}

function provider(path = ['app', 'public']): PgSchemaProvider {
  return {
    searchPath: () => path,
    schemas: vi.fn(async () => Object.keys(META)),
    tables: vi.fn(async (s: string) =>
      Object.keys(META[s] ?? {}).map((name) => ({ name, kind: 'table' as const }))
    ),
    columns: vi.fn(async (s: string, t: string) =>
      (META[s]?.[t] ?? []).map((name) => ({ name, type: 'integer' }))
    ),
    functions: vi.fn(async (s: string) =>
      s === 'public' ? [{ name: 'uuid_generate_v4', signature: '' }] : []
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
  const state = EditorState.create({ doc: text, extensions: sql({ dialect: vortaqPostgreSQL }) })
  return pgCompletionSource(p)(
    new CompletionContext(state, pos, explicit)
  ) as Promise<CompletionResult | null>
}

const labels = (r: CompletionResult | null): string[] =>
  (r?.options ?? []).map((o) => o.displayLabel ?? o.label)
const option = (r: CompletionResult | null, name: string) =>
  r?.options.find((o) => (o.displayLabel ?? o.label) === name)

describe('pgQuoteIdent', () => {
  it('quotes mixed case, reserved words and special characters only', () => {
    expect(pgQuoteIdent('users')).toBe('users')
    expect(pgQuoteIdent('MyTable')).toBe('"MyTable"')
    expect(pgQuoteIdent('user')).toBe('"user"')
    expect(pgQuoteIdent('a b')).toBe('"a b"')
    expect(pgQuoteIdent('a"b')).toBe('"a""b"')
    expect(pgQuoteIdent('users', true)).toBe('"users"')
  })
})

describe('pgTableRefs', () => {
  it('reads schema-qualified, quoted and aliased relations', () => {
    expect(
      pgTableRefs('SELECT * FROM app."MyTable" AS m JOIN Users u ON true, audit.log l')
    ).toEqual([
      { schema: 'app', table: 'MyTable', alias: 'm' },
      { schema: null, table: 'users', alias: 'u' }
    ])
    expect(pgTableRefs('SELECT 1 FROM a x, b y')).toEqual([
      { schema: null, table: 'a', alias: 'x' },
      { schema: null, table: 'b', alias: 'y' }
    ])
    expect(pgTableRefs("SELECT 'FROM fake' FROM $$ FROM nope $$, real")).toEqual([])
  })
})

describe('pgCompletionSource', () => {
  it('offers relations of every search_path schema, first schema boosted', async () => {
    const r = await complete('SELECT * FROM |', provider(), true)
    expect(labels(r)).toEqual(
      expect.arrayContaining(['orders', 'MyTable', 'users', 'spatial_ref_sys', 'app', 'audit'])
    )
    // app.orders shadows public.orders: only one entry, from app.
    expect(r?.options.filter((o) => o.displayLabel === 'orders')).toHaveLength(1)
    expect(option(r, 'orders')?.detail).toBe('tabla · app')
    expect(option(r, 'orders')!.boost!).toBeGreaterThan(option(r, 'users')!.boost!)
    // Extension objects in public stay visible with the tab on another schema.
    expect(option(r, 'uuid_generate_v4')?.type).toBe('function')
    expect(labels(r)).not.toContain('log')
  })

  it('inserts quoted labels for mixed-case and reserved names', async () => {
    const r = await complete('SELECT * FROM my|')
    expect(option(r, 'MyTable')?.label).toBe('"MyTable"')
    const cols = await complete('SELECT m.| FROM "MyTable" m')
    expect(labels(cols)).toEqual(['Id', 'user'])
    expect(option(cols, 'Id')?.label).toBe('"Id"')
    expect(option(cols, 'user')?.label).toBe('"user"')
  })

  it('matches unquoted input case-insensitively against folded names', async () => {
    const r = await complete('SELECT * FROM ORDERS o WHERE O.|')
    expect(labels(r)).toEqual(['id', 'total', 'CreatedAt'])
    expect(labels(await complete('SELECT * FROM APP.|'))).toEqual(
      expect.arrayContaining(['orders', 'MyTable'])
    )
  })

  it('lists relations after "schema." and columns after "schema.rel."', async () => {
    expect(labels(await complete('SELECT * FROM audit.|'))).toEqual(['log'])
    expect(labels(await complete('SELECT audit.log.| FROM audit.log'))).toEqual(['at', 'what'])
    expect(labels(await complete('SELECT * FROM public.|'))).toEqual(
      expect.arrayContaining(['users', 'uuid_generate_v4'])
    )
  })

  it('resolves an unqualified relation through the search_path in order', async () => {
    expect(labels(await complete('SELECT orders.| FROM orders'))).toEqual([
      'id',
      'total',
      'CreatedAt'
    ])
    expect(labels(await complete('SELECT u.| FROM users u'))).toEqual(['id', 'email'])
  })

  it('adds columns of referenced relations to bare words', async () => {
    const r = await complete('SELECT em| FROM users')
    expect(labels(r)).toEqual(expect.arrayContaining(['email', 'users']))
  })

  it('filters inside an opened double quote and keeps labels quoted', async () => {
    const r = await complete('SELECT * FROM "My|')
    expect(r?.from).toBe('SELECT * FROM '.length)
    expect(option(r, 'MyTable')?.label).toBe('"MyTable"')
    expect(option(r, 'users')?.label).toBe('"users"')
  })

  it('replaces the whole identifier under the cursor', async () => {
    const r = await complete('SELECT * FROM us|ers_old')
    const state = EditorState.create({ doc: 'SELECT * FROM users_old' })
    const view = new EditorView({ state })
    const users = option(r, 'users')!
    ;(users.apply as (v: EditorView, c: unknown, f: number, t: number) => void)(
      view,
      users,
      r!.from,
      'SELECT * FROM us'.length
    )
    expect(view.state.doc.toString()).toBe('SELECT * FROM users')
    view.destroy()
  })

  it('never completes inside strings, comments or dollar-quoted bodies', async () => {
    expect(await complete("SELECT 'us|'", provider(), true)).toBeNull()
    expect(await complete("SELECT E'it\\'s us|'", provider(), true)).toBeNull()
    expect(await complete('SELECT 1 -- us|', provider(), true)).toBeNull()
    expect(await complete('SELECT /* outer /* inner */ us| */', provider(), true)).toBeNull()
    expect(
      await complete(
        'CREATE FUNCTION f() RETURNS int AS $$ SELECT us| $$ LANGUAGE sql',
        provider(),
        true
      )
    ).toBeNull()
    expect(await complete('DO $body$ BEGIN PERFORM us|; END $body$', provider(), true)).toBeNull()
    // After a closed dollar body completion works again.
    expect(labels(await complete('SELECT $$x$$, us|'))).toContain('users')
  })

  it('stays quiet on an empty word unless asked', async () => {
    expect(await complete('SELECT |')).toBeNull()
  })
})

describe('insideLiteral', () => {
  it('detects unclosed literals at the end of the text', () => {
    expect(insideLiteral("SELECT 'a")).toBe(true)
    expect(insideLiteral("SELECT 'a''b")).toBe(true)
    expect(insideLiteral("SELECT 'a'")).toBe(false)
    expect(insideLiteral('SELECT $t$ x')).toBe(true)
    expect(insideLiteral('SELECT $t$ x $t$')).toBe(false)
    expect(insideLiteral('SELECT "MyTa')).toBe(false)
    expect(insideLiteral('SELECT a$1 b')).toBe(false)
  })
})

describe('cachedPg', () => {
  it('caches lookups and retries empty column lists', async () => {
    const p = provider()
    const c = cachedPg(p)
    await c.tables('app')
    await c.tables('app')
    expect(p.tables).toHaveBeenCalledTimes(1)
    await c.columns('app', 'missing')
    await c.columns('app', 'missing')
    expect(p.columns).toHaveBeenCalledTimes(2)
    await c.functions!('public')
    await c.functions!('public')
    expect(p.functions).toHaveBeenCalledTimes(1)
    c.clear()
    await c.tables('app')
    expect(p.tables).toHaveBeenCalledTimes(2)
    expect(c.searchPath()).toEqual(['app', 'public'])
  })
})
