/**
 * SQLite dialect (docs/multi-engine-design.md, sections 6 and 10). Every
 * function reads the same token stream (sqliteLexer.ts), so the splitter, both
 * production-guard functions and the destructive-statement check agree on
 * what is a string, an identifier or a comment.
 *
 * - splitStatements: `;` ends a statement only outside strings, identifiers,
 *   comments and `CREATE TRIGGER … BEGIN … END` bodies (CASE … END nests
 *   inside them), like sqlite3_complete().
 * - isObviousWrite (main): small denylist on the leading keyword.
 * - analyzeWrites (renderer): allowlist. SELECT/VALUES/WITH without DML,
 *   EXPLAIN of a read, read-only PRAGMAs and bare setting PRAGMAs are reads;
 *   anything else is a write with a Spanish reason.
 */
import { sqliteCodeTokens, tokenizeSqlite, type SqliteToken } from './sqliteLexer'
import type {
  DestructiveStatementInfo,
  LexRules,
  SqlDialect,
  SqlStatement,
  WriteCheck
} from './types'

/**
 * SQLite keywords (sqlite.org/lang_keywords.html, 3.53). Any of them is
 * quoted when used as an identifier: over-quoting is always valid.
 */
export const SQLITE_KEYWORDS: ReadonlySet<string> = new Set(
  (
    'abort action add after all alter always analyze and as asc attach autoincrement before begin ' +
    'between by cascade case cast check collate column commit conflict constraint create cross ' +
    'current current_date current_time current_timestamp database default deferrable deferred ' +
    'delete desc detach distinct do drop each else end escape except exclude exclusive exists ' +
    'explain fail filter first following for foreign from full generated glob group groups having ' +
    'if ignore immediate in index indexed initially inner insert instead intersect into is isnull ' +
    'join key last left like limit match materialized natural no not nothing notnull null nulls of ' +
    'offset on or order others outer over partition plan pragma preceding primary query raise range ' +
    'recursive references regexp reindex release rename replace restrict returning right rollback ' +
    'row rows savepoint select set table temp temporary then ties to transaction trigger unbounded ' +
    'union unique update using vacuum values view virtual when where window with without'
  ).split(' ')
)

const PLAIN_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * `users` and `Users` stay bare (SQLite identifiers are case-insensitive);
 * `order`, `a b`, `1x` and `a"b` are double-quoted. `force` always quotes.
 */
export function quoteIdent(name: string, force = false): string {
  if (!force && PLAIN_IDENT.test(name) && !SQLITE_KEYWORDS.has(name.toLowerCase())) return name
  return '"' + name.replace(/"/g, '""') + '"'
}

/** String literal: the quote is doubled; backslashes are plain characters in SQLite. */
export function quoteString(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

/** `"aux".t` — the attached database alias (main, temp, …) and the object name. */
export function qualified(schema: string | null | undefined, name: string): string {
  return schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name)
}

// ---------------------------------------------------------------------------
// Splitter
// ---------------------------------------------------------------------------

const upperOf = (t: SqliteToken | undefined): string =>
  t && t.kind === 'word' ? t.value.toUpperCase() : ''

const isWord = (t: SqliteToken | undefined, ...words: string[]): boolean =>
  !!t && t.kind === 'word' && words.includes(t.value.toUpperCase())

const isPunct = (t: SqliteToken | undefined, value: string): boolean =>
  !!t && (t.kind === 'punct' || t.kind === 'op') && t.value === value

export function splitStatements(script: string): SqlStatement[] {
  const src = script.replace(/\r\n/g, '\n')
  const tokens = tokenizeSqlite(src)
  const out: SqlStatement[] = []
  let start = 0
  let first: SqliteToken | null = null
  /** Leading code words of the current statement (to recognise CREATE … TRIGGER). */
  let lead: string[] = []
  let trigger = false
  /** BEGIN/CASE … END nesting inside a trigger. */
  let block = 0

  const flush = (end: number): void => {
    if (first) {
      const sql = src.slice(start, end).trim()
      if (sql) out.push({ sql, startLine: first.line })
    }
    first = null
    lead = []
    trigger = false
    block = 0
  }

  for (const t of tokens) {
    if (t.kind === 'comment') continue
    if (isPunct(t, ';') && block === 0) {
      flush(t.start)
      start = t.end
      continue
    }
    if (!first) first = t
    if (lead.length < 3) {
      lead.push(upperOf(t))
      if (
        lead[0] === 'CREATE' &&
        (lead[1] === 'TRIGGER' ||
          ((lead[1] === 'TEMP' || lead[1] === 'TEMPORARY') && lead[2] === 'TRIGGER'))
      )
        trigger = true
    }
    if (trigger && t.kind === 'word') {
      const w = t.value.toUpperCase()
      if (w === 'BEGIN' || w === 'CASE') block++
      else if (w === 'END' && block > 0) block--
    }
  }
  flush(src.length)
  return out
}

// ---------------------------------------------------------------------------
// Statement analysis helpers
// ---------------------------------------------------------------------------

/** Code tokens of a statement without a trailing `;`. */
function body(statement: string): SqliteToken[] {
  const code = sqliteCodeTokens(tokenizeSqlite(statement))
  let end = code.length
  while (end > 0 && isPunct(code[end - 1], ';')) end--
  return code.slice(0, end)
}

/** Depth of every token (inside how many parentheses it sits). */
function depths(tokens: SqliteToken[]): number[] {
  const out: number[] = []
  let d = 0
  for (const t of tokens) {
    if (isPunct(t, ')')) d = Math.max(0, d - 1)
    out.push(d)
    if (isPunct(t, '(')) d++
  }
  return out
}

function topLevelWord(tokens: SqliteToken[], d: number[], words: string[], from = 0): number {
  for (let i = from; i < tokens.length; i++) if (d[i] === 0 && isWord(tokens[i], ...words)) return i
  return -1
}

/** True when tokens[i] starts INSERT / UPDATE / DELETE / REPLACE INTO. */
function startsDml(tokens: SqliteToken[], i: number): boolean {
  const w = upperOf(tokens[i])
  if (w === 'INSERT' || w === 'DELETE') return true
  // `replace(x, 'a', 'b')` is the string function; REPLACE INTO is the statement.
  if (w === 'REPLACE') return isWord(tokens[i + 1], 'INTO')
  if (w === 'UPDATE') {
    // ON CONFLICT … DO UPDATE belongs to an INSERT, which is detected on its own.
    if (isWord(tokens[i - 1], 'DO')) return false
    const next = tokens[i + 1]
    return !!next && (next.kind === 'word' || next.kind === 'ident')
  }
  return false
}

/** "DELETE" / "DELETE sin WHERE" (same for UPDATE), "INSERT", "REPLACE". */
function dmlReason(tokens: SqliteToken[]): { reason: string; allRows: boolean } {
  const d = depths(tokens)
  const w = upperOf(tokens[0])
  if (w === 'DELETE' || w === 'UPDATE') {
    const allRows = topLevelWord(tokens, d, ['WHERE']) < 0
    return { reason: allRows ? `${w} sin WHERE` : w, allRows }
  }
  return { reason: w, allRows: false }
}

/** Index of the main statement of a WITH (first depth-0 SELECT/VALUES/DML after the CTEs). */
function withMain(tokens: SqliteToken[], d: number[]): number {
  return topLevelWord(tokens, d, ['SELECT', 'VALUES', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE'], 1)
}

/** Functions with side effects (only reachable when extensions are enabled). */
const SIDE_EFFECT_FUNCTIONS = new Set(['load_extension', 'writefile', 'edit'])

function sideEffectCalls(tokens: SqliteToken[]): string[] {
  const found: string[] = []
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i]
    if (t.kind !== 'word' && t.kind !== 'ident') continue
    if (!isPunct(tokens[i + 1], '(')) continue
    const name = t.value.toLowerCase()
    if (SIDE_EFFECT_FUNCTIONS.has(name) && !found.includes(name)) found.push(name)
  }
  return found
}

// ---------------------------------------------------------------------------
// PRAGMAs
// ---------------------------------------------------------------------------

/** PRAGMAs that only read, with or without an argument in parentheses. */
export const READ_PRAGMAS: ReadonlySet<string> = new Set([
  'table_info',
  'table_xinfo',
  'table_list',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
  'foreign_key_check',
  'database_list',
  'integrity_check',
  'quick_check',
  'compile_options',
  'collation_list',
  'function_list',
  'pragma_list',
  'module_list',
  'page_count',
  'freelist_count'
])

/** Setting PRAGMAs: reading them (bare form) is a read; setting them is a write. */
export const SETTING_PRAGMAS: ReadonlySet<string> = new Set([
  'query_only',
  'foreign_keys',
  'journal_mode',
  'user_version',
  'application_id',
  'encoding',
  'page_size',
  'cache_size',
  'busy_timeout',
  'synchronous',
  'temp_store',
  'auto_vacuum',
  'recursive_triggers',
  'case_sensitive_like',
  'secure_delete',
  'locking_mode',
  'defer_foreign_keys',
  'ignore_check_constraints',
  'automatic_index',
  'cell_size_check',
  'checkpoint_fullfsync',
  'fullfsync',
  'journal_size_limit',
  'max_page_count',
  'mmap_size',
  'reverse_unordered_selects',
  'schema_version',
  'soft_heap_limit',
  'hard_heap_limit',
  'threads',
  'trusted_schema',
  'analysis_limit',
  'legacy_alter_table',
  'wal_autocheckpoint',
  'data_version'
])

interface PragmaParts {
  name: string
  /** `PRAGMA x = v` */
  assigns: boolean
  /** `PRAGMA x(v)` */
  call: boolean
}

function pragmaParts(tokens: SqliteToken[]): PragmaParts | null {
  let i = 1
  const nameOf = (t: SqliteToken | undefined): string | null =>
    t && (t.kind === 'word' || t.kind === 'ident') ? t.value.toLowerCase() : null
  let name = nameOf(tokens[i])
  if (name === null) return null
  if (isPunct(tokens[i + 1], '.')) {
    i += 2
    name = nameOf(tokens[i])
    if (name === null) return null
  }
  const next = tokens[i + 1]
  const call = isPunct(next, '(')
  // Anything after the name other than `(…)` is an argument: treat it as an assignment.
  return { name, assigns: !!next && !call, call }
}

function pragmaWrites(tokens: SqliteToken[]): string | null {
  const p = pragmaParts(tokens)
  if (!p) return 'PRAGMA'
  if (p.assigns) return `PRAGMA de escritura: ${p.name}`
  if (READ_PRAGMAS.has(p.name)) return null
  if (SETTING_PRAGMAS.has(p.name)) return p.call ? `PRAGMA de escritura: ${p.name}` : null
  return `PRAGMA de escritura: ${p.name}`
}

// ---------------------------------------------------------------------------
// Renderer allowlist (analyzeWrites)
// ---------------------------------------------------------------------------

const NEUTRAL = new Set(['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'])
const QUERY_FIRST = new Set(['SELECT', 'VALUES', 'WITH'])
const TWO_WORD = new Set(['CREATE', 'DROP', 'ALTER'])
const CREATE_MODIFIERS = new Set(['TEMP', 'TEMPORARY', 'UNIQUE', 'VIRTUAL'])

/** Short label of an unknown write: "CREATE TABLE", "VACUUM"… */
function genericReason(tokens: SqliteToken[]): string {
  const w = upperOf(tokens[0]) || (tokens[0]?.value ?? '?')
  if (!TWO_WORD.has(w)) return w
  let i = 1
  const modifiers: string[] = []
  while (CREATE_MODIFIERS.has(upperOf(tokens[i]))) modifiers.push(upperOf(tokens[i++]))
  const second = upperOf(tokens[i])
  if (!second) return w
  return modifiers.includes('VIRTUAL') ? `${w} VIRTUAL ${second}` : `${w} ${second}`
}

function queryWrites(tokens: SqliteToken[]): string | null {
  const d = depths(tokens)
  if (isWord(tokens[0], 'WITH')) {
    const main = withMain(tokens, d)
    if (main >= 0 && startsDml(tokens, main)) return dmlReason(tokens.slice(main)).reason
  }
  for (let i = 0; i < tokens.length; i++) {
    if (startsDml(tokens, i))
      return isWord(tokens[0], 'WITH') ? 'CTE con escritura' : 'Subconsulta con escritura'
  }
  return null
}

function statementWrites(tokens: SqliteToken[]): string | null {
  if (!tokens.length) return null
  const w = upperOf(tokens[0])
  if (QUERY_FIRST.has(w)) return queryWrites(tokens)
  if (NEUTRAL.has(w)) return null
  if (w === 'EXPLAIN') {
    let i = 1
    if (isWord(tokens[1], 'QUERY') && isWord(tokens[2], 'PLAN')) i = 3
    return statementWrites(tokens.slice(i)) ? 'EXPLAIN de una escritura' : null
  }
  if (w === 'PRAGMA') return pragmaWrites(tokens)
  if (w === 'INSERT' || w === 'UPDATE' || w === 'DELETE' || w === 'REPLACE')
    return dmlReason(tokens).reason
  return genericReason(tokens)
}

export function analyzeWrites(script: string): WriteCheck {
  const reasons = new Set<string>()
  for (const { sql } of splitStatements(script)) {
    const tokens = body(sql)
    const reason = statementWrites(tokens)
    if (reason) reasons.add(reason)
    for (const fn of sideEffectCalls(tokens)) reasons.add(`Función con efectos: ${fn}`)
  }
  return { writes: reasons.size > 0, reasons: [...reasons] }
}

// ---------------------------------------------------------------------------
// Main denylist (isObviousWrite)
// ---------------------------------------------------------------------------

const OBVIOUS_WRITES = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'CREATE',
  'ALTER',
  'DROP',
  'VACUUM',
  'REINDEX',
  'ATTACH',
  'DETACH'
])

/**
 * Main side: true only for a statement that surely writes, from its leading
 * keyword. Everything flagged here is also a write for analyzeWrites.
 * A PRAGMA counts when it assigns (`= v`) or takes an argument (`(v)`) and is
 * not one of the read-only PRAGMAs (`table_info(t)` reads).
 */
export function isObviousWrite(statement: string): boolean {
  const tokens = body(statement)
  const w = upperOf(tokens[0])
  if (!w) return false
  if (OBVIOUS_WRITES.has(w)) return true
  if (w === 'PRAGMA') {
    const p = pragmaParts(tokens)
    if (!p) return false
    return p.assigns || (p.call && !READ_PRAGMAS.has(p.name))
  }
  if (w === 'WITH') {
    const main = withMain(tokens, depths(tokens))
    return main >= 0 && startsDml(tokens, main)
  }
  return false
}

// ---------------------------------------------------------------------------
// Destructive statements (renderer «confirmar antes de borrar»)
// ---------------------------------------------------------------------------

function destructiveOf(tokens: SqliteToken[]): { reason: string; allRows: boolean }[] {
  const w = upperOf(tokens[0])
  const d = depths(tokens)
  if (w === 'DROP') return [{ reason: `DROP ${upperOf(tokens[1])}`.trim(), allRows: false }]
  if (w === 'DELETE') return [dmlReason(tokens)]
  if (w === 'UPDATE') {
    const r = dmlReason(tokens)
    return r.allRows ? [r] : []
  }
  if (w === 'ALTER' && isWord(tokens[1], 'TABLE')) {
    for (let i = 2; i < tokens.length; i++) {
      if (d[i] !== 0 || !isWord(tokens[i], 'DROP')) continue
      if (isWord(tokens[i + 1], 'DEFAULT', 'NOT')) continue
      return [{ reason: 'ALTER TABLE … DROP', allRows: false }]
    }
    return []
  }
  if (w === 'WITH') {
    const main = withMain(tokens, d)
    if (main < 0) return []
    const kw = upperOf(tokens[main])
    if (kw !== 'DELETE' && kw !== 'UPDATE') return []
    const r = dmlReason(tokens.slice(main))
    return kw === 'DELETE' || r.allRows ? [r] : []
  }
  return []
}

/** Destructive statements of `script`, in order (empty when nothing needs confirming). */
export function analyzeDestructiveSqlite(script: string): DestructiveStatementInfo[] {
  const out: DestructiveStatementInfo[] = []
  for (const { sql } of splitStatements(script)) {
    const all = tokenizeSqlite(sql)
    const firstCode = all.find((t) => t.kind !== 'comment')
    const shown = firstCode ? sql.slice(firstCode.start).trim() : sql.trim()
    for (const found of destructiveOf(body(sql))) out.push({ sql: shown, ...found })
  }
  return out
}

// ---------------------------------------------------------------------------
// Statement kinds used by the driver
// ---------------------------------------------------------------------------

/** Upper-case first code word of a statement ('' when there is none). */
export function leadingKeyword(statement: string): string {
  return upperOf(body(statement)[0])
}

export type TransactionControl = 'begin' | 'commit' | 'rollback' | 'savepoint' | 'release'

/**
 * Transaction statement kind. END = commit. `ROLLBACK TO …` only rewinds to
 * a savepoint (the transaction stays open), so it is 'savepoint'.
 */
export function transactionControl(statement: string): TransactionControl | null {
  const tokens = body(statement)
  switch (upperOf(tokens[0])) {
    case 'BEGIN':
      return 'begin'
    case 'COMMIT':
    case 'END':
      return 'commit'
    case 'ROLLBACK': {
      const i = isWord(tokens[1], 'TRANSACTION') ? 2 : 1
      return isWord(tokens[i], 'TO') ? 'savepoint' : 'rollback'
    }
    case 'SAVEPOINT':
      return 'savepoint'
    case 'RELEASE':
      return 'release'
    default:
      return null
  }
}

/** ATTACH / DETACH (the tree refreshes its database list after them). */
export function isAttachOrDetach(statement: string): boolean {
  const w = leadingKeyword(statement)
  return w === 'ATTACH' || w === 'DETACH'
}

// ---------------------------------------------------------------------------
// Errors (node:sqlite `errcode`: the extended result code)
// ---------------------------------------------------------------------------

const READONLY =
  'La base de datos está abierta en solo lectura (o el archivo o su carpeta no se pueden escribir).'

const ERROR_EXPLANATIONS: Record<string, string> = {
  '19': 'La operación no cumple una restricción de la tabla.',
  '275': 'Un valor no cumple una restricción CHECK de la tabla.',
  '531': 'Un disparador o una función canceló la confirmación de la transacción.',
  '787':
    'La clave foránea no se cumple: la fila referenciada no existe o hay filas que dependen de esta.',
  '1299': 'Una columna NOT NULL quedaría sin valor: rellénala o dale un valor por defecto.',
  '1555': 'Ya existe una fila con esa clave primaria.',
  '2067': 'Ya existe una fila con ese valor en una columna o índice UNIQUE.',
  '2579': 'Ya existe una fila con ese rowid.',
  '1811': 'Un disparador canceló la operación (RAISE).',
  '3091': 'El valor no es del tipo de la columna (tabla STRICT).',
  '8': READONLY,
  '264': READONLY,
  '520': READONLY,
  '776': READONLY,
  '1032': 'El archivo de la base de datos se ha movido o borrado mientras estaba abierto.',
  '1288': READONLY,
  '1544': READONLY,
  '5': 'El archivo está bloqueado por otra aplicación o conexión: espera y vuelve a intentarlo.',
  '517': 'El archivo está bloqueado por otra aplicación o conexión: espera y vuelve a intentarlo.',
  '6': 'Una tabla está bloqueada dentro de esta conexión: termina la consulta o transacción en curso.',
  '23': 'La operación no está permitida en esta conexión.',
  '14': 'No se pudo abrir el archivo de la base de datos: comprueba que existe y tienes permisos.',
  '26': 'El archivo no es una base de datos SQLite (o está cifrado).',
  '11': 'El archivo de la base de datos está dañado: ejecuta «Comprobar integridad».',
  '13': 'El disco está lleno o se alcanzó el tamaño máximo de la base de datos.',
  '9': 'Consulta interrumpida.'
}

/** Spanish explanation of a node:sqlite errcode (as a string), or null when there is none. */
export function explainSqliteError(code: string): string | null {
  return ERROR_EXPLANATIONS[code] ?? null
}

/** SQLITE_AUTH: refused by the authorizer. */
export function isSqlitePrivilegeError(code: string): boolean {
  return code === '23'
}

// ---------------------------------------------------------------------------
// Dialect object
// ---------------------------------------------------------------------------

export const SQLITE_LEX: Readonly<LexRules> = {
  identQuotes: ['"', '[', '`'],
  stringQuotes: ["'"],
  backslashEscapes: false,
  hashComment: false,
  dashCommentNeedsSpace: false,
  nestedBlockComments: false,
  executableComments: [],
  dollarQuotes: false,
  delimiterCommand: false,
  blockBodies: 'trigger-begin-end'
}

export const sqliteDialect: SqlDialect = {
  id: 'sqlite',
  lex: SQLITE_LEX,
  splitStatements,
  quoteIdent: (name) => quoteIdent(name),
  quoteString,
  qualified,
  isObviousWrite,
  analyzeWrites,
  analyzeDestructive: analyzeDestructiveSqlite,
  explainError: explainSqliteError,
  isPrivilegeError: isSqlitePrivilegeError
}
