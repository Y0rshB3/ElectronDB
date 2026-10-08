import { quoteIdent, SQLITE_KEYWORDS } from '@shared/dialects/sqlite'
import {
  insertCompletionText,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource
} from '@codemirror/autocomplete'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { SQLite, SQLDialect } from '@codemirror/lang-sql'
import type { EditorState, Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/*
 * SQLite completion for the query editor (docs/multi-engine-design.md,
 * section 8.1). The first qualifier is an attached database alias (main,
 * temp, aux…), identifiers match case-insensitively (as SQLite resolves
 * them), and labels are inserted double-quoted whenever SQLite would need it
 * (shared dialect rule). The MySQL (sqlCompletion.ts) and PostgreSQL
 * (pgCompletion.ts) sources are untouched.
 */

/**
 * SQLite dialect of the editor: `"x"`, `` `x` `` and `[x]` are identifiers;
 * a few SQLite-only words highlight as keywords.
 */
export const vortaqSQLite = SQLDialect.define({
  ...SQLite.spec,
  keywords: `${SQLite.spec.keywords ?? ''} strict without returning materialized nothing nulls`,
  identifierQuotes: '"`['
})

/** Metadata the editor can ask for; every call may be slow (results are cached by cachedSqlite). */
export interface SqliteSchemaProvider {
  /** Attached database aliases: main, temp, aux… */
  databases(): Promise<string[]>
  /** The tab's database alias (usually 'main'); null = main. */
  defaultDatabase(): string | null
  tables(db: string): Promise<{ name: string; kind: 'table' | 'view' }[]>
  columns(db: string, table: string): Promise<{ name: string; type: string }[]>
}

/** Longest identifier scanned. */
const MAX_IDENT = 256
/** Characters around the cursor considered when scoping the statement. */
const SCOPE_WINDOW = 20_000
/** Referenced tables whose columns are offered for a bare word. */
const MAX_REFS = 8
/** Databases searched for an unqualified table name. */
const MAX_DBS = 8

/** Pragmas offered after `PRAGMA `. */
export const SQLITE_PRAGMAS: readonly string[] = [
  'analysis_limit',
  'application_id',
  'auto_vacuum',
  'automatic_index',
  'busy_timeout',
  'cache_size',
  'cache_spill',
  'case_sensitive_like',
  'cell_size_check',
  'checkpoint_fullfsync',
  'collation_list',
  'compile_options',
  'data_version',
  'database_list',
  'defer_foreign_keys',
  'encoding',
  'foreign_key_check',
  'foreign_key_list',
  'foreign_keys',
  'freelist_count',
  'fullfsync',
  'function_list',
  'hard_heap_limit',
  'ignore_check_constraints',
  'incremental_vacuum',
  'index_info',
  'index_list',
  'index_xinfo',
  'integrity_check',
  'journal_mode',
  'journal_size_limit',
  'legacy_alter_table',
  'locking_mode',
  'max_page_count',
  'mmap_size',
  'module_list',
  'optimize',
  'page_count',
  'page_size',
  'pragma_list',
  'query_only',
  'quick_check',
  'read_uncommitted',
  'recursive_triggers',
  'reverse_unordered_selects',
  'secure_delete',
  'shrink_memory',
  'soft_heap_limit',
  'synchronous',
  'table_info',
  'table_list',
  'table_xinfo',
  'temp_store',
  'threads',
  'trusted_schema',
  'user_version',
  'wal_autocheckpoint',
  'wal_checkpoint'
]

/** Core, date/time, aggregate, window, math and JSON functions of SQLite 3.53. */
export const SQLITE_FUNCTIONS: readonly string[] = [
  'abs',
  'changes',
  'char',
  'coalesce',
  'concat',
  'concat_ws',
  'format',
  'glob',
  'hex',
  'ifnull',
  'iif',
  'instr',
  'last_insert_rowid',
  'length',
  'like',
  'likelihood',
  'likely',
  'lower',
  'ltrim',
  'max',
  'min',
  'nullif',
  'octet_length',
  'printf',
  'quote',
  'random',
  'randomblob',
  'replace',
  'round',
  'rtrim',
  'sign',
  'soundex',
  'sqlite_version',
  'substr',
  'substring',
  'total_changes',
  'trim',
  'typeof',
  'unhex',
  'unicode',
  'unlikely',
  'upper',
  'zeroblob',
  'date',
  'time',
  'datetime',
  'julianday',
  'unixepoch',
  'strftime',
  'timediff',
  'avg',
  'count',
  'group_concat',
  'string_agg',
  'sum',
  'total',
  'row_number',
  'rank',
  'dense_rank',
  'percent_rank',
  'cume_dist',
  'ntile',
  'lag',
  'lead',
  'first_value',
  'last_value',
  'nth_value',
  'acos',
  'asin',
  'atan',
  'atan2',
  'ceil',
  'cos',
  'degrees',
  'exp',
  'floor',
  'ln',
  'log',
  'log10',
  'log2',
  'mod',
  'pi',
  'pow',
  'power',
  'radians',
  'sin',
  'sqrt',
  'tan',
  'trunc',
  'json',
  'jsonb',
  'json_array',
  'json_array_length',
  'json_each',
  'json_extract',
  'json_group_array',
  'json_group_object',
  'json_insert',
  'json_object',
  'json_patch',
  'json_quote',
  'json_remove',
  'json_replace',
  'json_set',
  'json_tree',
  'json_type',
  'json_valid'
]

/** Quotes a name unless it is a plain identifier that is not a keyword (shared dialect rule). */
export function sqliteQuoteIdent(name: string, force = false): string {
  return quoteIdent(name, force)
}

/** Name an identifier as typed refers to: `"x"`, `[x]` and `` `x` `` lose their quotes. */
export function sqliteIdentName(id: string): string {
  const open = id[0]
  if (open === '"' || open === '`') {
    const body = id.length > 1 && id.endsWith(open) ? id.slice(1, -1) : id.slice(1)
    return body.split(open + open).join(open)
  }
  if (open === '[') return id.length > 1 && id.endsWith(']') ? id.slice(1, -1) : id.slice(1)
  return id
}

/** Wraps a provider with per-key promise caching; failures and empty column lists retry. */
export function cachedSqlite(
  provider: SqliteSchemaProvider
): SqliteSchemaProvider & { clear(): void } {
  const store = new Map<string, Promise<unknown>>()
  const memo = <T>(key: string, load: () => Promise<T>, keepEmpty = true): Promise<T> => {
    let p = store.get(key) as Promise<T> | undefined
    if (!p) {
      p = load().then(
        (value) => {
          if (!keepEmpty && Array.isArray(value) && !value.length) store.delete(key)
          return value
        },
        (err) => {
          store.delete(key)
          throw err
        }
      )
      store.set(key, p)
    }
    return p
  }
  return {
    databases: () => memo('d', () => provider.databases()),
    defaultDatabase: () => provider.defaultDatabase(),
    tables: (db) => memo(`t:${db.toLowerCase()}`, () => provider.tables(db)),
    columns: (db, t) =>
      memo(`c:${db.toLowerCase()}\u0000${t.toLowerCase()}`, () => provider.columns(db, t), false),
    clear: () => store.clear()
  }
}

/* ---------- lexing ---------- */

/** Unquoted identifier characters: [A-Za-z0-9_$] plus U+0080 and above. */
function isWordCode(c: number): boolean {
  return (
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 95 ||
    c === 36 ||
    c >= 0x80
  )
}

const CLOSE: Record<string, string> = { '"': '"', '`': '`', '[': ']' }

type Token = { kind: 'id'; value: string; quoted: boolean } | { kind: 'punct'; value: string }

/** End (exclusive) of a quoted run opened at `i`; doubling escapes `"` and backticks. */
function endOfQuoted(sql: string, i: number): number {
  const close = CLOSE[sql[i]] ?? "'"
  const doubling = close !== ']'
  let j = i + 1
  while (j < sql.length) {
    if (sql[j] === close) {
      if (doubling && sql[j + 1] === close) {
        j += 2
        continue
      }
      return j + 1
    }
    j++
  }
  return sql.length
}

/** Identifiers and punctuation; strings and comments are skipped. Linear time. */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  const n = sql.length
  let i = 0
  while (i < n) {
    const ch = sql[i]
    const c = sql.charCodeAt(i)
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') i++
    else if (ch === '"' || ch === '`' || ch === '[') {
      const end = endOfQuoted(sql, i)
      tokens.push({ kind: 'id', value: sqliteIdentName(sql.slice(i, end)), quoted: true })
      i = end
    } else if (ch === "'") i = endOfQuoted(sql, i)
    else if (ch === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i)
      i = eol < 0 ? n : eol + 1
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
    } else if (isWordCode(c)) {
      let j = i + 1
      while (j < n && isWordCode(sql.charCodeAt(j))) j++
      tokens.push({ kind: 'id', value: sql.slice(i, j), quoted: false })
      i = j
    } else {
      tokens.push({ kind: 'punct', value: ch })
      i++
    }
  }
  return tokens
}

/** True when the cursor at the end of `text` is inside a string literal or a comment. */
export function insideSqliteLiteral(text: string): boolean {
  const n = text.length
  let i = 0
  while (i < n) {
    const ch = text[i]
    if (ch === "'") {
      let j = i + 1
      for (;;) {
        if (j >= n) return true
        if (text[j] === "'" && text[j + 1] === "'") j += 2
        else if (text[j] === "'") break
        else j++
      }
      i = j + 1
    } else if (ch === '"' || ch === '`' || ch === '[') {
      const end = text.indexOf(CLOSE[ch], i + 1)
      if (end < 0) return false // typing a quoted identifier: completion applies
      i = end + 1
    } else if (ch === '-' && text[i + 1] === '-') {
      const eol = text.indexOf('\n', i)
      if (eol < 0) return true
      i = eol + 1
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) return true
      i = end + 2
    } else i++
  }
  return false
}

const NOT_ALIAS = new Set(
  (
    'WHERE ON USING JOIN INNER LEFT RIGHT FULL CROSS OUTER NATURAL GROUP ORDER LIMIT OFFSET ' +
    'HAVING SET VALUES UNION AS WINDOW SELECT WITH EXCEPT INTERSECT INTO FROM RETURNING ' +
    'INDEXED NOT DEFAULT DO CONFLICT WHEN THEN ELSE END AND OR SELECT BEGIN FOR EACH ROW'
  ).split(' ')
)
const TABLE_KW = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE'])
const LIST_KW = new Set(['FROM'])
const UPDATE_OR = new Set(['OR', 'ROLLBACK', 'ABORT', 'REPLACE', 'FAIL', 'IGNORE'])

const isWord = (t: Token | undefined, words: Set<string>): boolean =>
  !!t && t.kind === 'id' && !t.quoted && words.has(t.value.toUpperCase())
const isPunct = (t: Token | undefined, value: string): boolean =>
  !!t && t.kind === 'punct' && t.value === value

export interface SqliteTableRef {
  /** Attached database alias as written (unquoted), null when unqualified. */
  database: string | null
  table: string
  alias: string | null
}

/** Tables after FROM/JOIN/UPDATE/INTO/TABLE, with aliases and FROM comma lists. */
export function sqliteTableRefs(sql: string): SqliteTableRef[] {
  const refs: SqliteTableRef[] = []
  const tokens = tokenize(sql)
  for (let i = 0; i < tokens.length; i++) {
    if (!isWord(tokens[i], TABLE_KW)) continue
    const keyword = (tokens[i] as { value: string }).value.toUpperCase()
    let j = i + 1
    // UPDATE OR IGNORE t …
    if (keyword === 'UPDATE') while (isWord(tokens[j], UPDATE_OR)) j++
    for (;;) {
      const name = tokens[j]
      if (!name || name.kind !== 'id' || (!name.quoted && NOT_ALIAS.has(name.value.toUpperCase())))
        break
      let database: string | null = null
      let table = name.value
      j++
      const next = tokens[j + 1]
      if (isPunct(tokens[j], '.') && next?.kind === 'id') {
        database = table
        table = next.value
        j += 2
      }
      if (isPunct(tokens[j], '(')) {
        // INSERT INTO t(cols) / CREATE TABLE t(…); after FROM/JOIN it is a table-valued
        // function (pragma_table_info(…), json_each(…)).
        if (keyword === 'INTO' || keyword === 'TABLE') refs.push({ database, table, alias: null })
        break
      }
      if (isWord(tokens[j], new Set(['AS']))) j++
      let alias: string | null = null
      const a = tokens[j]
      if (a?.kind === 'id' && (a.quoted || !NOT_ALIAS.has(a.value.toUpperCase()))) {
        alias = a.value
        j++
      }
      refs.push({ database, table, alias })
      if (LIST_KW.has(keyword) && isPunct(tokens[j], ',')) {
        j++
        continue
      }
      break
    }
    i = Math.max(i, j - 1)
  }
  return refs
}

/* ---------- cursor ---------- */

type Tree = ReturnType<typeof syntaxTree>
type SyntaxNode = ReturnType<Tree['resolveInner']>

const SKIP_NODES = new Set(['String', 'LineComment', 'BlockComment'])

/** Syntax-tree check: inside a string / comment (or at the end of an unclosed one). */
function inLiteralNode(node: SyntaxNode, pos: number, doc: Text): boolean {
  if (!SKIP_NODES.has(node.name) || pos <= node.from) return false
  if (pos < node.to || node.name === 'LineComment') return true
  const text = doc.sliceString(node.from, node.to)
  if (node.name === 'BlockComment') return text.length < 4 || !text.endsWith('*/')
  const body = text.replace(/^[A-Za-z_]*/, '')
  const quote = body[0]
  return body.length < 2 || body[body.length - 1] !== quote
}

/** Start of the identifier (bare or quoted) ending at `end` in `text`, or -1. */
function identStart(text: string, end: number): number {
  const last = text[end - 1]
  const open = last === '"' ? '"' : last === '`' ? '`' : last === ']' ? '[' : null
  if (open) {
    for (let k = end - 2; k >= 0 && end - k <= MAX_IDENT; k--) {
      if (text[k] === '\n') return -1
      if (text[k] !== open) continue
      if (open !== '[' && text[k - 1] === open) {
        k--
        continue
      }
      return k
    }
    return -1
  }
  let k = end
  while (k > 0 && end - k < MAX_IDENT && isWordCode(text.charCodeAt(k - 1))) k--
  return k < end && end - k < MAX_IDENT ? k : -1
}

interface CursorPath {
  word: string
  from: number
  /** Qualifier names, unquoted. */
  qualifiers: string[]
  /** Upper-cased bare keyword just before the word (and its qualifiers), '' when none. */
  previous: string
}

/** Offset of an unclosed `"`, `` ` `` or `[` opening the identifier being typed on this line, or -1. */
function openQuote(line: string): number {
  let open = -1
  let close = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (open >= 0) {
      if (ch === close) {
        if (close !== ']' && line[i + 1] === close) i++
        else open = -1
      }
    } else if (ch === '"' || ch === '`' || ch === '[') {
      open = i
      close = CLOSE[ch]
    } else if (ch === "'") {
      const end = line.indexOf("'", i + 1)
      if (end < 0) return -1
      i = end
    }
  }
  return open
}

function cursorPath(state: EditorState, pos: number): CursorPath | null {
  const doc = state.doc
  const before = doc.sliceString(Math.max(0, pos - MAX_IDENT), pos)
  let from: number
  const line = before.slice(before.lastIndexOf('\n') + 1)
  const open = openQuote(line)
  if (open >= 0) {
    from = pos - (line.length - open)
  } else {
    let k = before.length
    while (k > 0 && isWordCode(before.charCodeAt(k - 1))) k--
    if (k === 0 && before.length === MAX_IDENT) return null
    from = pos - (before.length - k)
  }
  const word = doc.sliceString(from, pos)
  const base = Math.max(0, from - 2 * (MAX_IDENT + 1) - 64)
  const text = doc.sliceString(base, from)
  const qualifiers: string[] = []
  let end = text.length
  while (qualifiers.length < 2 && text[end - 1] === '.') {
    const start = identStart(text, end - 1)
    if (start < 0) break
    qualifiers.unshift(sqliteIdentName(text.slice(start, end - 1)))
    end = start
  }
  const m = /([A-Za-z_]+)\s*$/.exec(text.slice(0, end))
  const previous =
    m && (end - m[0].length === 0 || !isWordCode(text.charCodeAt(end - m[0].length - 1)))
      ? m[1].toUpperCase()
      : ''
  return { word, from, qualifiers, previous }
}

function statementRange(state: EditorState, tree: Tree, pos: number): { from: number; to: number } {
  let stmt: { from: number; to: number } | null = null
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) {
      if (n.name === 'Statement') {
        stmt = n
        break
      }
    }
    if (stmt) break
  }
  return {
    from: Math.max(stmt?.from ?? 0, pos - SCOPE_WINDOW),
    to: Math.min(stmt?.to ?? state.doc.length, pos + SCOPE_WINDOW)
  }
}

/* ---------- options ---------- */

const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
  try {
    return await p
  } catch {
    return fallback
  }
}

/** Exact name first, then case-insensitive (SQLite identifiers are). */
function pick<T>(items: T[], name: string, key: (item: T) => string): T | undefined {
  const lower = name.toLowerCase()
  return items.find((x) => key(x) === name) ?? items.find((x) => key(x).toLowerCase() === lower)
}

function trailingEnd(doc: Text, pos: number, quote: string | null): number {
  const after = doc.sliceString(pos, Math.min(doc.length, pos + MAX_IDENT))
  if (quote) {
    const close = after.indexOf(CLOSE[quote])
    const eol = after.indexOf('\n')
    if (close >= 0 && (eol < 0 || close < eol)) return pos + close + 1
  }
  let k = 0
  while (k < after.length && isWordCode(after.charCodeAt(k))) k++
  return pos + k
}

function applyWhole(quote: string | null) {
  return (view: EditorView, completion: Completion, from: number, to: number): void => {
    const end = trailingEnd(view.state.doc, to, quote)
    view.dispatch({
      ...insertCompletionText(view.state, completion.label, from, end),
      annotations: pickedCompletion.of(completion)
    })
  }
}

function tableOptions(
  rels: { name: string; kind: 'table' | 'view' }[],
  db: string,
  boost: number,
  quote: string | null
): Completion[] {
  return rels.map((r) => ({
    label: quoteIdent(r.name, quote !== null),
    displayLabel: r.name,
    type: r.kind === 'view' ? 'type' : 'class',
    detail: `${r.kind === 'view' ? 'vista' : 'tabla'} · ${db}`,
    boost,
    apply: applyWhole(quote)
  }))
}

function columnOptions(
  cols: { name: string; type: string }[],
  table: string,
  boost: number,
  quote: string | null
): Completion[] {
  return cols.map((c) => ({
    label: quoteIdent(c.name, quote !== null),
    displayLabel: c.name,
    type: 'property',
    detail: `${c.type || 'sin tipo'} · ${table}`,
    boost,
    apply: applyWhole(quote)
  }))
}

function databaseOptions(dbs: string[], boost: number, quote: string | null): Completion[] {
  return dbs.map((d) => ({
    label: quoteIdent(d, quote !== null),
    displayLabel: d,
    type: 'namespace',
    detail: 'base de datos',
    boost,
    apply: applyWhole(quote)
  }))
}

const PRAGMA_OPTIONS: Completion[] = SQLITE_PRAGMAS.map((p) => ({
  label: p,
  type: 'property',
  detail: 'pragma',
  boost: 3
}))

const FUNCTION_OPTIONS: Completion[] = SQLITE_FUNCTIONS.map((f) => ({
  label: f,
  type: 'function',
  detail: 'función',
  boost: -1
}))

const KEYWORD_OPTIONS: Completion[] = [...SQLITE_KEYWORDS].map((k) => ({
  label: k.toUpperCase(),
  type: 'keyword',
  boost: -2
}))

/** Keywords after which a table name is expected. */
const TABLE_CONTEXT = new Set([...TABLE_KW, 'EXISTS'])

/**
 * Context-aware SQLite completion: pragma names after PRAGMA, tables of the
 * tab's database (and database aliases) after FROM/JOIN/INTO/UPDATE/TABLE,
 * tables after `db.`, columns after `table.`, `alias.` or `db.table.`, and
 * otherwise columns of the tables used in the statement, tables, functions
 * and keywords.
 */
export function sqliteCompletionSource(provider: SqliteSchemaProvider): CompletionSource {
  const dbOf = async (name: string): Promise<string | null> =>
    pick(await safe(provider.databases(), []), name, (d) => d) ?? null
  const defaultDb = (): string => provider.defaultDatabase() || 'main'
  /** Search order of an unqualified name: the tab's database, temp, main, then attached ones. */
  const searchOrder = async (): Promise<string[]> => {
    const dbs = await safe(provider.databases(), [])
    const order = [defaultDb(), 'temp', 'main', ...dbs]
    const seen = new Set<string>()
    return order
      .filter((d) => {
        const k = d.toLowerCase()
        if (seen.has(k)) return false
        seen.add(k)
        return d === defaultDb() || dbs.some((x) => x.toLowerCase() === k)
      })
      .slice(0, MAX_DBS)
  }
  const resolve = async (
    db: string | null,
    table: string
  ): Promise<{ db: string; table: string } | null> => {
    const candidates = db ? [(await dbOf(db)) ?? db] : await searchOrder()
    for (const d of candidates) {
      const found = pick(await safe(provider.tables(d), []), table, (r) => r.name)
      if (found) return { db: d, table: found.name }
    }
    return null
  }
  const columnsOf = async (db: string | null, table: string) => {
    const r = await resolve(db, table)
    return r ? { table: r.table, cols: await safe(provider.columns(r.db, r.table), []) } : null
  }

  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const { state, pos } = ctx
    const tree =
      ensureSyntaxTree(state, Math.min(state.doc.length, pos + SCOPE_WINDOW), 50) ??
      syntaxTree(state)
    if (inLiteralNode(tree.resolveInner(pos, -1), pos, state.doc)) return null
    const range = statementRange(state, tree, pos)
    if (insideSqliteLiteral(state.doc.sliceString(range.from, pos))) return null
    const path = cursorPath(state, pos)
    if (!path) return null
    const { word, from, qualifiers, previous } = path
    if (!qualifiers.length && !word && !ctx.explicit) return null

    const quote = word[0] === '"' || word[0] === '`' || word[0] === '[' ? word[0] : null
    const validFor = /^(?:"[^"]*"?|`[^`]*`?|\[[^\]]*\]?|[\w$\u0080-￿]*)$/

    if (previous === 'PRAGMA' && qualifiers.length <= 1 && !quote)
      return { from, options: PRAGMA_OPTIONS, validFor }

    const refs = sqliteTableRefs(state.doc.sliceString(range.from, range.to))

    if (qualifiers.length === 2) {
      const found = await columnsOf(qualifiers[0], qualifiers[1])
      if (!found) return null
      return { from, options: columnOptions(found.cols, found.table, 0, quote), validFor }
    }

    if (qualifiers.length === 1) {
      const q = qualifiers[0]
      const lower = q.toLowerCase()
      const options: Completion[] = []
      const ref = refs.find((r) =>
        r.alias ? r.alias.toLowerCase() === lower : r.table.toLowerCase() === lower
      )
      const found = ref ? await columnsOf(ref.database, ref.table) : await columnsOf(null, q)
      if (found) options.push(...columnOptions(found.cols, found.table, 2, quote))
      const db = await dbOf(q)
      if (db) options.push(...tableOptions(await safe(provider.tables(db), []), db, 1, quote))
      return options.length ? { from, options, validFor } : null
    }

    const db = defaultDb()
    const [dbs, tables] = await Promise.all([
      safe(provider.databases(), []),
      safe(provider.tables(db), [])
    ])
    const options: Completion[] = []
    if (TABLE_CONTEXT.has(previous)) {
      options.push(...tableOptions(tables, db, 3, quote), ...databaseOptions(dbs, 2, quote))
      return { from, options, validFor }
    }
    options.push(...tableOptions(tables, db, 1, quote), ...databaseOptions(dbs, 0, quote))
    const seen = new Set<string>()
    const lookups: ReturnType<typeof columnsOf>[] = []
    for (const r of refs) {
      const key = `${(r.database ?? '').toLowerCase()}\u0000${r.table.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      lookups.push(columnsOf(r.database, r.table))
      if (lookups.length >= MAX_REFS) break
    }
    for (const found of await Promise.all(lookups))
      if (found) options.push(...columnOptions(found.cols, found.table, 2, quote))
    if (!quote) options.push(...FUNCTION_OPTIONS, ...KEYWORD_OPTIONS)
    return { from, options, validFor }
  }
}
