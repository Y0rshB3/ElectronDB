/**
 * Visual filter builder -> WHERE clause for SQLite (same filter model, limits
 * and messages as the MySQL and PostgreSQL builders).
 *
 * Identifiers are checked against the table's real columns and double-quoted;
 * values are string literals ('' doubling; backslashes are plain in SQLite).
 * Nothing from the renderer is concatenated into SQL except `custom` rows,
 * which are the user's own SQL fragment exactly like the raw WHERE box.
 *
 * Dialect choices:
 * - comparisons use a text literal ('5'): a column with INTEGER, REAL or
 *   NUMERIC affinity converts it to a number, as SQLite does for any
 *   comparison. A column without a declared type (no affinity) compares a
 *   number-looking value as a number, otherwise '5' would never match 5;
 * - booleans do not exist: they are 1 and 0 (sí/no/true/false… accepted);
 * - "contiene", "empieza por"… use LIKE with `\`, `%` and `_` escaped and an
 *   explicit ESCAPE '\'. **SQLite's LIKE ignores case only for ASCII letters**
 *   (a = A, but á ≠ Á and ñ ≠ Ñ) unless PRAGMA case_sensitive_like is on;
 * - "está vacío" is `(CAST(col AS TEXT) = '' OR col IS NULL)`.
 */
import type {
  TableFilter,
  TableFilterCondition,
  TableFilterGroup,
  TableFilterJoin,
  TableFilterNode,
  TableFilterOperator,
  TypeKind
} from '@shared/types'
import { quoteIdent, quoteString } from '@shared/dialects/sqlite'
import { affinityOf } from '@shared/sqlite/affinity'
import { DbUserError } from '../db/errors'

export const MAX_FILTER_CONDITIONS = 200
export const MAX_IN_VALUES = 1000
export const MAX_FILTER_DEPTH = 8

/** What the builder needs to know about a column. */
export interface SqliteFilterColumn {
  name: string
  typeKind?: TypeKind
  /** Declared type as written ('' for an untyped column). */
  dataType?: string
}

const ERROR_CODE = 'E_SQLITE_FILTER'
function fail(message: string): never {
  throw new DbUserError(message, ERROR_CODE)
}

const COMPARISON: Partial<Record<TableFilterOperator, string>> = {
  eq: '=',
  ne: '<>',
  lt: '<',
  le: '<=',
  gt: '>',
  ge: '>='
}

const LIKE: Partial<Record<TableFilterOperator, { not: boolean; pattern: (v: string) => string }>> =
  {
    contains: { not: false, pattern: (v) => `%${v}%` },
    notContains: { not: true, pattern: (v) => `%${v}%` },
    beginsWith: { not: false, pattern: (v) => `${v}%` },
    notBeginsWith: { not: true, pattern: (v) => `${v}%` },
    endsWith: { not: false, pattern: (v) => `%${v}` },
    notEndsWith: { not: true, pattern: (v) => `%${v}` }
  }

const OPERATORS: ReadonlySet<string> = new Set<TableFilterOperator>([
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'contains',
  'notContains',
  'beginsWith',
  'notBeginsWith',
  'endsWith',
  'notEndsWith',
  'isNull',
  'isNotNull',
  'isEmpty',
  'isNotEmpty',
  'in',
  'notIn',
  'between',
  'notBetween',
  'custom'
])

/** Escapes LIKE wildcards so the value matches literally (`\` first). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** Only plain strings and finite numbers are values (no NUL characters). */
function scalar(value: unknown, what: string): string {
  let text: string | null = null
  if (typeof value === 'string') text = value
  else if (typeof value === 'number' && Number.isFinite(value)) text = String(value)
  if (text === null) return fail(`Falta ${what}`)
  if (text.includes('\0'))
    return fail(`${what[0].toUpperCase()}${what.slice(1)} contiene un carácter nulo`)
  return text
}

/**
 * Resolves `column` to a real column: the exact name first, then a unique
 * case-insensitive match (SQLite names are case-insensitive). Unknown names
 * never reach the SQL.
 */
export function resolveColumn(
  column: unknown,
  columns: readonly SqliteFilterColumn[]
): SqliteFilterColumn {
  if (typeof column !== 'string' || !column)
    return fail('Elige una columna en cada condición del filtro')
  const exact = columns.find((c) => c.name === column)
  if (exact) return exact
  const lower = column.toLowerCase()
  const matches = columns.filter((c) => c.name.toLowerCase() === lower)
  if (matches.length === 1) return matches[0]
  return fail(`La columna «${column}» no existe en la tabla`)
}

type ValueKind = 'boolean' | 'untyped' | 'plain'

function valueKind(c: SqliteFilterColumn): ValueKind {
  const type = (c.dataType ?? '').toLowerCase().trim()
  if (type === 'boolean' || type === 'bool') return 'boolean'
  if (affinityOf(type) === 'BLOB' && !type.includes('blob')) return 'untyped'
  return 'plain'
}

const TRUE_WORDS = new Set(['true', 't', '1', 'yes', 'y', 'on', 'si', 'sí', 'verdadero'])
const FALSE_WORDS = new Set(['false', 'f', '0', 'no', 'n', 'off', 'falso'])

function booleanLiteral(value: string, column: string): string {
  const v = value.trim().toLowerCase()
  if (TRUE_WORDS.has(v)) return '1'
  if (FALSE_WORDS.has(v)) return '0'
  return fail(`El valor «${value}» de la columna «${column}» no es un booleano (usa 1 o 0)`)
}

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

/** Column expression and literal renderer for comparisons on this column. */
function comparable(c: SqliteFilterColumn): { expr: string; literal: (v: string) => string } {
  const id = quoteIdent(c.name)
  switch (valueKind(c)) {
    case 'boolean':
      return { expr: id, literal: (v) => booleanLiteral(v, c.name) }
    case 'untyped':
      return { expr: id, literal: (v) => (NUMBER.test(v.trim()) ? v.trim() : quoteString(v)) }
    default:
      return { expr: id, literal: quoteString }
  }
}

/** Renders one enabled, non-custom condition to SQL (without outer parentheses). */
export function compileCondition(
  cond: TableFilterCondition,
  columns: readonly SqliteFilterColumn[]
): string {
  if (!OPERATORS.has(cond.operator) || cond.operator === 'custom')
    return fail(`Operador de filtro no válido: ${String(cond.operator)}`)
  const column = resolveColumn(cond.column, columns)
  const id = quoteIdent(column.name)
  const op = cond.operator
  const values: unknown[] = Array.isArray(cond.values) ? cond.values : []
  const label = `el valor de la condición sobre «${cond.column}»`
  const { expr, literal } = comparable(column)

  const cmp = COMPARISON[op]
  if (cmp) return `${expr} ${cmp} ${literal(scalar(values[0], label))}`

  const like = LIKE[op]
  if (like) {
    const pattern = like.pattern(escapeLike(scalar(values[0], label)))
    return `${id} ${like.not ? 'NOT LIKE' : 'LIKE'} ${quoteString(pattern)} ESCAPE '\\'`
  }

  switch (op) {
    case 'isNull':
      return `${id} IS NULL`
    case 'isNotNull':
      return `${id} IS NOT NULL`
    case 'isEmpty':
      return `(CAST(${id} AS TEXT) = '' OR ${id} IS NULL)`
    case 'isNotEmpty':
      return `(CAST(${id} AS TEXT) <> '' AND ${id} IS NOT NULL)`
    case 'in':
    case 'notIn': {
      if (!values.length) return fail(`Falta la lista de valores sobre «${cond.column}»`)
      if (values.length > MAX_IN_VALUES)
        return fail(`La lista admite como máximo ${MAX_IN_VALUES} valores`)
      const list = values.map((v) => literal(scalar(v, label))).join(', ')
      return `${expr} ${op === 'in' ? 'IN' : 'NOT IN'} (${list})`
    }
    case 'between':
    case 'notBetween': {
      const from = literal(scalar(values[0], `el valor inicial de «${cond.column}»`))
      const to = literal(scalar(values[1], `el valor final de «${cond.column}»`))
      return `${expr} ${op === 'between' ? 'BETWEEN' : 'NOT BETWEEN'} ${from} AND ${to}`
    }
  }
  /* c8 ignore next */
  return fail(`Operador de filtro no válido: ${String(op)}`)
}

function renderCondition(
  cond: TableFilterCondition,
  columns: readonly SqliteFilterColumn[]
): string | null {
  if (cond.operator === 'custom') {
    const raw = typeof cond.sql === 'string' ? cond.sql.trim() : ''
    // Own lines: a trailing "-- note" in the fragment cannot comment out what follows.
    return raw ? `(\n${raw}\n)` : null
  }
  return `(${compileCondition(cond, columns)})`
}

function checkJoin(op: unknown): TableFilterJoin {
  if (op === 'AND' || op === 'OR') return op
  return fail('Las condiciones del filtro se combinan con AND u OR')
}

function isNode(value: unknown): value is TableFilterNode {
  return typeof value === 'object' && value !== null && 'kind' in value
}

/** True when the filter has at least one enabled condition that needs the column list. */
export function sqliteFilterNeedsColumns(filter: TableFilterNode | null | undefined): boolean {
  if (!isNode(filter) || !filter.enabled) return false
  if (filter.kind === 'condition') return filter.operator !== 'custom'
  return Array.isArray(filter.children) && filter.children.some((c) => sqliteFilterNeedsColumns(c))
}

interface Walk {
  columns: readonly SqliteFilterColumn[]
  count: number
}

function renderGroup(group: TableFilterGroup, walk: Walk, depth: number): string | null {
  if (depth > MAX_FILTER_DEPTH)
    fail(`El filtro admite como máximo ${MAX_FILTER_DEPTH} niveles de paréntesis`)
  if (!Array.isArray(group.children)) fail('Filtro no válido')
  let sql = ''
  let pending: TableFilterJoin | null = null
  for (const child of group.children) {
    if (!isNode(child)) fail('Filtro no válido')
    if (!child.enabled) continue
    let part: string | null
    if (child.kind === 'group') {
      const inner = renderGroup(child, walk, depth + 1)
      part = inner === null ? null : `(${inner})`
    } else {
      if (++walk.count > MAX_FILTER_CONDITIONS)
        fail(`El filtro admite como máximo ${MAX_FILTER_CONDITIONS} condiciones`)
      part = renderCondition(child, walk.columns)
    }
    const connector = checkJoin(child.connector ?? 'AND')
    if (part === null) continue
    sql = pending === null ? part : `${sql} ${pending} ${part}`
    pending = connector
  }
  return sql || null
}

/**
 * Builds the WHERE body (without the keyword) for `filter`, or '' when it has
 * no enabled condition. `columns` are the table's real columns.
 */
export function buildSqliteFilterWhere(
  filter: TableFilter | null | undefined,
  columns: readonly SqliteFilterColumn[]
): string {
  if (filter === null || filter === undefined) return ''
  if (!isNode(filter) || filter.kind !== 'group') fail('Filtro no válido')
  if (!filter.enabled) return ''
  return renderGroup(filter, { columns, count: 0 }, 0) ?? ''
}
