import {
  insertCompletionText,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource
} from '@codemirror/autocomplete'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { MySQL, SQLDialect } from '@codemirror/lang-sql'
import type { EditorState, Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/**
 * MySQL as the server parses it by default: backslash escapes inside string
 * literals are on unless sql_mode has NO_BACKSLASH_ESCAPES. Without this the
 * editor (and the string detection below) misreads `'it\'s'`.
 */
export const electronDBMySQL = SQLDialect.define({ ...MySQL.spec, backslashEscapes: true })

type Tree = ReturnType<typeof syntaxTree>
type SyntaxNode = ReturnType<Tree['resolveInner']>

/** Metadata the editor can ask for; every call may be slow, results are cached here. */
export interface SchemaProvider {
  /** Database selected in the query tab (unqualified names resolve against it). */
  defaultSchema(): string | null
  databases(): Promise<string[]>
  /** Tables and views of one database. */
  tables(schema: string): Promise<{ name: string; kind: 'table' | 'view' }[]>
  columns(schema: string, table: string): Promise<{ name: string; type: string }[]>
}

/** Longest identifier we scan for (MySQL caps names at 64 chars; quoted ones a bit more). */
const MAX_IDENT = 256
/** Characters around the cursor considered when scoping the statement (bounds work on dumps). */
const SCOPE_WINDOW = 20_000
/** Referenced tables whose columns are offered for a bare word. */
const MAX_REFS = 8

const NOT_ALIAS = new Set(
  'WHERE ON USING JOIN INNER LEFT RIGHT CROSS OUTER NATURAL GROUP ORDER LIMIT HAVING SET VALUES VALUE UNION AS STRAIGHT_JOIN WINDOW FOR LOCK PARTITION USE IGNORE FORCE SELECT WITH EXCEPT INTERSECT INTO FROM RETURNING'.split(
    ' '
  )
)
/** Keywords followed by a table name. */
const TABLE_KW = new Set(['FROM', 'JOIN', 'STRAIGHT_JOIN', 'UPDATE', 'INTO'])
/** Keywords whose table list may continue with commas (`FROM a, b`, `UPDATE a, b SET`). */
const LIST_KW = new Set(['FROM', 'UPDATE'])
/** Modifiers that may sit between the keyword and the table (`UPDATE IGNORE t`). */
const MODIFIERS = new Set(['LOW_PRIORITY', 'IGNORE', 'DELAYED', 'HIGH_PRIORITY', 'QUICK'])
const AS = new Set(['AS'])
/** Words that can follow FROM/INTO without being a table. */
const NOT_TABLE = new Set([...NOT_ALIAS, 'OUTFILE', 'DUMPFILE', 'DUAL'])

export function unquote(id: string): string {
  return id.startsWith('`') ? id.replace(/^`|`$/g, '').replace(/``/g, '`') : id
}

export function quoteIfNeeded(id: string, force = false): string {
  return !force && /^[A-Za-z_$][\w$]*$/.test(id) ? id : '`' + id.replace(/`/g, '``') + '`'
}

/** Splits `a.b.c` into identifier parts, honouring backticks. */
export function splitPath(path: string): string[] {
  const parts: string[] = []
  let cur = ''
  let quoted = false
  for (const ch of path) {
    if (ch === '`') quoted = !quoted
    if (ch === '.' && !quoted) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  return parts
}

/** MySQL unquoted identifier characters: [0-9a-zA-Z$_] plus U+0080 and above. */
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

export interface TableRef {
  schema: string | null
  table: string
  alias: string | null
}

type Token = { kind: 'id'; value: string; quoted: boolean } | { kind: 'punct'; value: string }

/** Identifiers and punctuation of a statement; strings and comments are skipped. Linear time. */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  const n = sql.length
  let i = 0
  while (i < n) {
    const c = sql.charCodeAt(i)
    const ch = sql[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') i++
    else if (ch === '`') {
      let j = i + 1
      let value = ''
      while (j < n) {
        if (sql[j] === '`') {
          if (sql[j + 1] === '`') {
            value += '`'
            j += 2
            continue
          }
          break
        }
        value += sql[j++]
      }
      tokens.push({ kind: 'id', value, quoted: true })
      i = j + 1
    } else if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < n && sql[j] !== ch) j += sql[j] === '\\' ? 2 : 1
      i = j + 1
    } else if (ch === '#' || (ch === '-' && sql[i + 1] === '-' && /\s/.test(sql[i + 2] ?? ' '))) {
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

const isWord = (t: Token | undefined, words: Set<string>): boolean =>
  !!t && t.kind === 'id' && !t.quoted && words.has(t.value.toUpperCase())
const isPunct = (t: Token | undefined, value: string): boolean =>
  !!t && t.kind === 'punct' && t.value === value

/**
 * Tables referenced after FROM/JOIN/STRAIGHT_JOIN/UPDATE/INTO, with their aliases,
 * including comma-separated lists (`FROM a x, b y`, `UPDATE a, b SET`).
 */
export function tableRefs(sql: string): TableRef[] {
  const refs: TableRef[] = []
  const tokens = tokenize(sql)
  for (let i = 0; i < tokens.length; i++) {
    if (!isWord(tokens[i], TABLE_KW)) continue
    const keyword = (tokens[i] as { value: string }).value.toUpperCase()
    let j = i + 1
    while (isWord(tokens[j], MODIFIERS)) j++
    for (;;) {
      const name = tokens[j]
      if (!name || name.kind !== 'id' || isWord(name, NOT_TABLE)) break
      let schema: string | null = null
      let table = name.value
      j++
      const next = tokens[j + 1]
      if (isPunct(tokens[j], '.') && next?.kind === 'id') {
        schema = table
        table = next.value
        j += 2
      }
      if (isWord(tokens[j], AS)) j++
      let alias: string | null = null
      const a = tokens[j]
      if (a?.kind === 'id' && (a.quoted || !NOT_ALIAS.has(a.value.toUpperCase()))) {
        alias = a.value
        j++
      }
      refs.push({ schema, table, alias })
      if (LIST_KW.has(keyword) && isPunct(tokens[j], ',')) {
        j++
        continue
      }
      break
    }
    // Resume at the first token not consumed (it may be the next JOIN).
    i = Math.max(i, j - 1)
  }
  return refs
}

/**
 * Wraps a provider with per-key promise caching. Failed lookups and tables with
 * no columns (not created yet) are retried next time. Keys keep the exact case:
 * with lower_case_table_names=0 `USERS` and `users` are different objects.
 */
export function cached(provider: SchemaProvider): SchemaProvider & { clear(): void } {
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
    defaultSchema: () => provider.defaultSchema(),
    databases: () => memo('db', () => provider.databases()),
    tables: (s) => memo(`t:${s}`, () => provider.tables(s)),
    columns: (s, t) => memo(`c:${s}\u0000${t}`, () => provider.columns(s, t), false),
    clear: () => store.clear()
  }
}

const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
  try {
    return await p
  } catch {
    return fallback
  }
}

const ci = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** Exact match first, then case-insensitive (Navicat finds `USERS` as `users`). */
function pick<T>(items: T[], name: string, key: (item: T) => string): T | undefined {
  return items.find((x) => key(x) === name) ?? items.find((x) => ci(key(x), name))
}

/** Characters after `pos` that belong to the identifier being replaced. */
function trailingEnd(doc: Text, pos: number, quoted: boolean): number {
  const after = doc.sliceString(pos, Math.min(doc.length, pos + MAX_IDENT))
  if (quoted) {
    const close = after.indexOf('`')
    const eol = after.indexOf('\n')
    if (close >= 0 && (eol < 0 || close < eol)) return pos + close + 1
  }
  let k = 0
  while (k < after.length && isWordCode(after.charCodeAt(k))) k++
  return pos + k
}

/** Replaces the whole identifier under the cursor, not just the part before it. */
function applyWhole(quoted: boolean) {
  return (view: EditorView, completion: Completion, from: number, to: number): void => {
    const end = trailingEnd(view.state.doc, to, quoted)
    view.dispatch({
      ...insertCompletionText(view.state, completion.label, from, end),
      annotations: pickedCompletion.of(completion)
    })
  }
}

function columnOptions(
  cols: { name: string; type: string }[],
  table: string,
  boost: number,
  quoted: boolean
): Completion[] {
  return cols.map((c) => ({
    label: quoteIfNeeded(c.name, quoted),
    displayLabel: c.name,
    type: 'property',
    detail: `${c.type} · ${table}`,
    boost,
    apply: applyWhole(quoted)
  }))
}

function tableOptions(
  tables: { name: string; kind: 'table' | 'view' }[],
  schema: string,
  boost: number,
  quoted: boolean
): Completion[] {
  return tables.map((t) => ({
    label: quoteIfNeeded(t.name, quoted),
    displayLabel: t.name,
    type: t.kind === 'view' ? 'type' : 'class',
    detail: `${t.kind === 'view' ? 'vista' : 'tabla'} · ${schema}`,
    boost,
    apply: applyWhole(quoted)
  }))
}

const SKIP_NODES = new Set(['String', 'LineComment', 'BlockComment'])

/** True when `pos` is inside a string literal or comment (or right at the end of an unclosed one). */
function inStringOrComment(node: SyntaxNode, pos: number, doc: Text): boolean {
  if (!SKIP_NODES.has(node.name) || pos <= node.from) return false
  if (pos < node.to || node.name === 'LineComment') return true
  const text = doc.sliceString(node.from, node.to)
  if (node.name === 'BlockComment') return text.length < 4 || !text.endsWith('*/')
  const quote = text.replace(/^[A-Za-z_]*/, '')[0]
  return text.length < 2 || text[text.length - 1] !== quote
}

/** Start of the identifier ending at `end` in `text`, or -1 if there is none. */
function identStart(text: string, end: number): number {
  if (text[end - 1] === '`') {
    for (let k = end - 2; k >= 0 && end - k <= MAX_IDENT; k--) {
      if (text[k] === '\n') return -1
      if (text[k] !== '`') continue
      if (text[k - 1] === '`') {
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
  /** Typed text of the last part (may start with a backtick). */
  word: string
  from: number
  qualifiers: string[]
}

/**
 * The `[db.][table.]word` being typed at `pos`. Scans backwards from the cursor
 * over a bounded window, so long lines (hex blobs in dumps) cost nothing.
 */
function cursorPath(state: EditorState, tree: Tree, pos: number): CursorPath | null {
  const doc = state.doc
  const node = tree.resolveInner(pos, -1)
  let from: number
  if (node.name === 'QuotedIdentifier' && pos > node.from) {
    from = node.from
    if (pos - from > MAX_IDENT || doc.sliceString(from, pos).includes('\n')) return null
  } else {
    const before = doc.sliceString(Math.max(0, pos - MAX_IDENT), pos)
    let k = before.length
    while (k > 0 && isWordCode(before.charCodeAt(k - 1))) k--
    if (k === 0 && before.length === MAX_IDENT) return null
    from = pos - (before.length - k)
  }
  const word = doc.sliceString(from, pos)
  const base = Math.max(0, from - 2 * (MAX_IDENT + 1))
  const text = doc.sliceString(base, from)
  const qualifiers: string[] = []
  let end = text.length
  while (qualifiers.length < 2 && text[end - 1] === '.') {
    const start = identStart(text, end - 1)
    if (start < 0) break
    qualifiers.unshift(unquote(text.slice(start, end - 1)))
    end = start
  }
  return { word, from, qualifiers }
}

/** Text of the statement around `pos` (bounded), so other statements' aliases do not leak in. */
function statementText(state: EditorState, tree: Tree, pos: number): string {
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
  const from = Math.max(stmt?.from ?? 0, pos - SCOPE_WINDOW)
  const to = Math.min(stmt?.to ?? state.doc.length, pos + SCOPE_WINDOW)
  return state.doc.sliceString(from, to)
}

/**
 * Navicat-like completion: databases and tables while typing a bare word,
 * tables after `db.`, columns after `table.`, `alias.` or `db.table.`, and
 * columns of tables already used in the current statement.
 */
export function schemaCompletionSource(provider: SchemaProvider): CompletionSource {
  const schemaOf = async (name: string): Promise<string> =>
    pick(await safe(provider.databases(), []), name, (d) => d) ?? name
  /** Real name of a table in `schema`, or null when it does not exist there. */
  const tableOf = async (schema: string, name: string): Promise<string | null> => {
    const tables = await safe(provider.tables(schema), [])
    if (!tables.length) return name
    return pick(tables, name, (t) => t.name)?.name ?? null
  }
  const columnsOf = async (schema: string, table: string) => {
    const s = await schemaOf(schema)
    const t = await tableOf(s, table)
    return t ? { table: t, cols: await safe(provider.columns(s, t), []) } : null
  }

  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const { state, pos } = ctx
    const tree =
      ensureSyntaxTree(state, Math.min(state.doc.length, pos + SCOPE_WINDOW), 50) ??
      syntaxTree(state)
    if (inStringOrComment(tree.resolveInner(pos, -1), pos, state.doc)) return null
    const path = cursorPath(state, tree, pos)
    if (!path) return null
    const { word, from, qualifiers } = path
    if (!qualifiers.length && !word && !ctx.explicit) return null

    // After an opening backtick every label is quoted, so "`us" still filters to `users`.
    const quoted = word.startsWith('`')
    const validFor = /^(?:`[^`]*`?|[\w$\u0080-￿]*)$/
    const def = provider.defaultSchema()
    const refs = tableRefs(statementText(state, tree, pos))

    if (qualifiers.length === 2) {
      const found = await columnsOf(qualifiers[0], qualifiers[1])
      if (!found) return null
      return { from, options: columnOptions(found.cols, found.table, 0, quoted), validFor }
    }

    if (qualifiers.length === 1) {
      const q = qualifiers[0]
      const ref = refs.find((r) => (r.alias ? ci(r.alias, q) : ci(r.table, q)))
      const options: Completion[] = []
      const found = ref
        ? await columnsOf(ref.schema ?? def ?? '', ref.table)
        : def
          ? await columnsOf(def, q)
          : null
      if (found) options.push(...columnOptions(found.cols, found.table, 2, quoted))
      const db = pick(await safe(provider.databases(), []), q, (d) => d)
      if (db) options.push(...tableOptions(await safe(provider.tables(db), []), db, 1, quoted))
      return options.length ? { from, options, validFor } : null
    }

    const [dbs, tables] = await Promise.all([
      safe(provider.databases(), []),
      def ? safe(provider.tables(def), []) : Promise.resolve([])
    ])
    const options: Completion[] = [
      ...tableOptions(tables, def ?? '', 3, quoted),
      ...dbs.map((d) => ({
        label: quoteIfNeeded(d, quoted),
        displayLabel: d,
        type: 'namespace',
        detail: 'base de datos',
        boost: 2,
        apply: applyWhole(quoted)
      }))
    ]
    const seen = new Set<string>()
    const lookups: ReturnType<typeof columnsOf>[] = []
    for (const r of refs) {
      const schema = r.schema ?? def
      if (!schema) continue
      const key = `${schema}\u0000${r.table}`.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      lookups.push(columnsOf(schema, r.table))
      if (lookups.length >= MAX_REFS) break
    }
    for (const found of await Promise.all(lookups))
      if (found) options.push(...columnOptions(found.cols, found.table, 1, quoted))
    return { from, options, validFor }
  }
}
