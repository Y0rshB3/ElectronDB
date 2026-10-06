import { describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { sql } from '@codemirror/lang-sql'
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  CompletionContext,
  completionStatus,
  currentCompletions,
  startCompletion,
  type CompletionResult
} from '@codemirror/autocomplete'
import {
  cached,
  electronDBMySQL,
  schemaCompletionSource,
  splitPath,
  tableRefs,
  type SchemaProvider
} from './sqlCompletion'

const META: Record<string, Record<string, string[]>> = {
  accounts: { users: ['id', 'email'], session: ['id', 'userID'] },
  billing: { account: ['id', 'status'], 'order items': ['qty'] }
}

function provider(def: string | null = 'accounts'): SchemaProvider {
  return {
    defaultSchema: () => def,
    databases: vi.fn(async () => Object.keys(META)),
    tables: vi.fn(async (s: string) =>
      Object.keys(META[s] ?? {}).map((name) => ({ name, kind: 'table' as const }))
    ),
    columns: vi.fn(async (s: string, t: string) =>
      (META[s]?.[t] ?? []).map((name) => ({ name, type: 'varchar(10)' }))
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
  const state = EditorState.create({ doc: text, extensions: sql({ dialect: electronDBMySQL }) })
  return schemaCompletionSource(p)(
    new CompletionContext(state, pos, explicit)
  ) as Promise<CompletionResult | null>
}

const labels = (r: CompletionResult | null): string[] =>
  (r?.options ?? []).map((o) => o.displayLabel ?? o.label)

describe('schemaCompletionSource', () => {
  it('suggests databases and current-database tables while typing a bare word', async () => {
    const r = await complete('SELECT * FROM aut|')
    expect(labels(r)).toEqual(expect.arrayContaining(['accounts', 'billing', 'users', 'session']))
    expect(r?.from).toBe('SELECT * FROM '.length)
  })

  it('lists the tables of a database after "db."', async () => {
    const r = await complete('SELECT * FROM billing.|')
    expect(labels(r)).toEqual(['account', 'order items'])
    expect(r?.options.find((o) => o.displayLabel === 'order items')?.label).toBe('`order items`')
  })

  it('lists columns after an alias, a table name or db.table', async () => {
    expect(labels(await complete('SELECT u.| FROM users u'))).toEqual(['id', 'email'])
    expect(labels(await complete('SELECT session.| FROM session'))).toEqual(['id', 'userID'])
    expect(labels(await complete('SELECT * FROM billing.account WHERE billing.account.|'))).toEqual(
      ['id', 'status']
    )
    expect(labels(await complete('SELECT a.| FROM billing.account AS a'))).toEqual(['id', 'status'])
  })

  it('adds columns of referenced tables to bare-word suggestions', async () => {
    expect(labels(await complete('SELECT em| FROM users'))).toContain('email')
  })

  it('stays quiet inside strings, comments and on empty input', async () => {
    expect(await complete("SELECT 'aut|")).toBeNull()
    expect(await complete('-- aut|')).toBeNull()
    expect(await complete('SELECT |')).toBeNull()
  })

  it('caches lookups and retries after a failure', async () => {
    const base = provider()
    let fail = true
    base.databases = vi.fn(async () => {
      if (fail) throw new Error('down')
      return ['accounts']
    })
    const p = cached(base)
    await expect(p.databases()).rejects.toThrow()
    fail = false
    expect(await p.databases()).toEqual(['accounts'])
    await p.databases()
    expect(base.databases).toHaveBeenCalledTimes(2)
  })
})

describe('helpers', () => {
  it('splits backticked paths and finds table refs with aliases', () => {
    expect(splitPath('`a.b`.c')).toEqual(['`a.b`', 'c'])
    expect(
      tableRefs('SELECT * FROM accounts.users u JOIN session s ON s.userID = u.id WHERE 1')
    ).toEqual([
      { schema: 'accounts', table: 'users', alias: 'u' },
      { schema: null, table: 'session', alias: 's' }
    ])
    expect(tableRefs('SELECT * FROM users WHERE id = 1')[0].alias).toBeNull()
  })
})

/** Real editor with only the schema source, so accepted text can be checked end to end. */
async function openCompletion(
  doc: string,
  p: SchemaProvider = provider()
): Promise<{ view: EditorView; labels: string[] }> {
  const pos = doc.indexOf('|')
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: doc.replace('|', ''),
      selection: { anchor: pos },
      extensions: [
        sql({ dialect: electronDBMySQL }),
        closeBrackets(),
        autocompletion({ override: [schemaCompletionSource(p)], interactionDelay: 0 })
      ]
    })
  })
  startCompletion(view)
  await vi.waitFor(() => expect(completionStatus(view.state)).toBe('active'))
  await vi.waitFor(() => expect(currentCompletions(view.state).length).toBeGreaterThan(0))
  return { view, labels: currentCompletions(view.state).map((o) => o.label) }
}

describe('regressions', () => {
  it('ignores backticked identifiers earlier on the line', async () => {
    const r = await complete('SELECT `id`, em| FROM users')
    expect(labels(r)).toContain('email')
    expect(r?.from).toBe('SELECT `id`, '.length)
    expect(labels(await complete('SELECT * FROM users WHERE `status` = 1 AND em|'))).toContain(
      'email'
    )
    expect(labels(await complete('SELECT `id`, u.| FROM users u'))).toEqual(['id', 'email'])
    expect(labels(await complete('SELECT `u`.| FROM users `u`'))).toEqual(['id', 'email'])
  })

  it('keeps tables joined right after an unaliased table, and STRAIGHT_JOIN', () => {
    const names = (s: string): string[] => tableRefs(s).map((r) => r.table)
    expect(names('SELECT * FROM users JOIN session ON 1')).toEqual(['users', 'session'])
    expect(names('SELECT * FROM a JOIN b JOIN c')).toEqual(['a', 'b', 'c'])
    expect(names('SELECT * FROM a STRAIGHT_JOIN b')).toEqual(['a', 'b'])
    expect(names('UPDATE a JOIN b ON 1 SET x = 1')).toEqual(['a', 'b'])
    expect(tableRefs('SELECT * FROM users\nJOIN session s ON 1')[1]).toEqual({
      schema: null,
      table: 'session',
      alias: 's'
    })
  })

  it('resolves aliases of a plain JOIN after an unaliased table', async () => {
    expect(labels(await complete('SELECT s.| FROM users\nJOIN session s ON 1'))).toEqual([
      'id',
      'userID'
    ])
  })

  it('parses comma joins in FROM and UPDATE', async () => {
    expect(tableRefs('SELECT * FROM a, b c')).toEqual([
      { schema: null, table: 'a', alias: null },
      { schema: null, table: 'b', alias: 'c' }
    ])
    expect(tableRefs('UPDATE t1, x.t2 SET a = 1').map((r) => r.table)).toEqual(['t1', 't2'])
    expect(labels(await complete('SELECT s.| FROM users u, session s'))).toEqual(['id', 'userID'])
    expect(labels(await complete('SELECT userI| FROM users, session'))).toContain('userID')
  })

  it('replaces the whole word when accepting in the middle of it', async () => {
    const { view } = await openCompletion('SELECT * FROM acc|ounts WHERE 1')
    expect(acceptCompletion(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('SELECT * FROM accounts WHERE 1')
    view.destroy()
  })

  it('still filters unquoted names after an opening backtick', async () => {
    const { view, labels: shown } = await openCompletion('SELECT * FROM `us|')
    expect(shown).toContain('`users`')
    view.destroy()
    const r = await complete('SELECT * FROM billing.`ord|')
    expect(r?.options.map((o) => o.label)).toEqual(['`account`', '`order items`'])
    expect(r?.from).toBe('SELECT * FROM billing.'.length)
  })

  it('does not leave a doubled backtick after accepting a quoted name', async () => {
    const p = provider(null)
    p.databases = vi.fn(async () => ['nd-scratch', 'accounts'])
    const { view, labels: shown } = await openCompletion('SELECT * FROM `nd-s|`', p)
    expect(shown).toEqual(['`nd-scratch`'])
    expect(acceptCompletion(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('SELECT * FROM `nd-scratch`')
    view.destroy()
  })

  it('scopes table refs to the statement under the cursor', async () => {
    expect(
      labels(await complete('SELECT * FROM billing.account u;\nSELECT u.| FROM users u'))
    ).toEqual(['id', 'email'])
    const script = Array.from({ length: 9 }, (_, i) => `SELECT * FROM t${i};`).join('\n')
    expect(labels(await complete(`${script}\nSELECT em| FROM users`))).toContain('email')
  })

  it('stays fast on very long lines (hex blobs in dumps)', async () => {
    const doc = `INSERT INTO t VALUES (1,0x${'AB'.repeat(100_000)}), (2, |`
    const started = performance.now()
    await complete(doc, provider(), true)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('uses the parsed syntax tree for strings and comments', async () => {
    expect(await complete('/* aut|')).toBeNull()
    expect(await complete("SELECT 'abc\naut|")).toBeNull()
    expect(await complete('SELECT "aut|')).toBeNull()
    expect(await complete("INSERT INTO users VALUES ('line1\nline2 em|')")).toBeNull()
    expect(await complete('# aut|')).toBeNull()
    expect(labels(await complete("SELECT * FROM users WHERE n = 'it\\'s' AND em|"))).toContain(
      'email'
    )
    expect(labels(await complete("SELECT `it's`, em| FROM users"))).toContain('email')
    expect(labels(await complete('SELECT `a#b`, em| FROM users'))).toContain('email')
    expect(labels(await complete('SELECT /* x */ em| FROM users'))).toContain('email')
  })

  it('keeps cache keys case-sensitive, retries empty column lists and can be cleared', async () => {
    const base = provider()
    const p = cached(base)
    expect(await p.columns('accounts', 'USERS')).toEqual([])
    expect(await p.columns('accounts', 'users')).toHaveLength(2)
    await p.columns('accounts', 'USERS')
    expect(base.columns).toHaveBeenCalledTimes(3)
    await p.columns('accounts', 'users')
    expect(base.columns).toHaveBeenCalledTimes(3)
    p.clear()
    await p.columns('accounts', 'users')
    expect(base.columns).toHaveBeenCalledTimes(4)
  })

  it('resolves names typed in another case to the real object', async () => {
    const p = provider()
    expect(labels(await complete('SELECT u.| FROM USERS u', p))).toEqual(['id', 'email'])
    expect(p.columns).toHaveBeenCalledWith('accounts', 'users')
    expect(p.columns).not.toHaveBeenCalledWith('accounts', 'USERS')
    expect(labels(await complete('SELECT * FROM BILLING.|'))).toEqual(['account', 'order items'])
  })
})
