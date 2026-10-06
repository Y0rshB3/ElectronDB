import { format } from 'mysql2'
import type {
  TableFilter,
  TableFilterCondition,
  TableFilterGroup,
  TableFilterJoin,
  TableFilterNode,
  TableFilterOperator
} from '@shared/types'
import { MysqlUserError } from './errors'
import { escapeId } from './introspect'

/**
 * Navicat-style filter builder -> WHERE clause.
 *
 * Identifiers are checked against the table's real columns and escaped with
 * escapeId; every value is a `?` placeholder whose parameter is escaped by the
 * mysql2 driver (`format`, the same escaping `conn.query(sql, params)` uses).
 * Nothing from the renderer is concatenated into SQL except `custom` rows,
 * which are the user's own SQL fragment exactly like the raw WHERE box.
 *
 * Each condition is compiled to `{ sql, params }` and rendered to plain SQL on
 * its own, so a `?` inside a custom row (for example `name = 'why?'`) never
 * consumes another condition's parameter.
 *
 * The filter is a tree (Navicat brackets): every item carries the connector
 * ("y"/"o") that joins it with its next sibling; AND binds tighter than OR,
 * as in SQL, and brackets give any other order. Disabled items and empty
 * groups are skipped.
 *
 * Semantics (documented for the user in the README):
 * - "está vacío" is `(col = '' OR col IS NULL)` and "no está vacío" its negation,
 *   like Navicat: an empty string and NULL both count as empty.
 * - "!=", "no contiene", "no está en la lista"... follow SQL: NULL never matches.
 * - LIKE patterns escape `\`, `%` and `_` with the default `\` escape character
 *   (assumes the server does not run with NO_BACKSLASH_ESCAPES, like the driver).
 */

export interface CompiledCondition {
  sql: string
  params: string[]
}

export const MAX_FILTER_CONDITIONS = 200
export const MAX_IN_VALUES = 1000
export const MAX_FILTER_DEPTH = 8

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

/** Only plain strings and finite numbers are values: objects/arrays would expand in `format`. */
function scalar(value: unknown, what: string): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  throw new MysqlUserError(`Falta ${what}`)
}

/**
 * Resolves `column` to the real column name (exact first, then case-insensitive
 * like MySQL) or throws: unknown names never reach the SQL.
 */
export function resolveColumn(column: unknown, columns: readonly string[]): string {
  if (typeof column !== 'string' || !column) {
    throw new MysqlUserError('Elige una columna en cada condición del filtro')
  }
  if (columns.includes(column)) return column
  const lower = column.toLowerCase()
  const found = columns.find((c) => c.toLowerCase() === lower)
  if (found) return found
  throw new MysqlUserError(`La columna «${column}» no existe en la tabla`)
}

/** Compiles one enabled, non-custom condition. */
export function compileCondition(
  cond: TableFilterCondition,
  columns: readonly string[]
): CompiledCondition {
  if (!OPERATORS.has(cond.operator) || cond.operator === 'custom') {
    throw new MysqlUserError(`Operador de filtro no válido: ${String(cond.operator)}`)
  }
  const col = escapeId(resolveColumn(cond.column, columns))
  const op = cond.operator
  const values: unknown[] = Array.isArray(cond.values) ? cond.values : []
  const label = `el valor de la condición sobre «${cond.column}»`

  const cmp = COMPARISON[op]
  if (cmp) return { sql: `${col} ${cmp} ?`, params: [scalar(values[0], label)] }

  const like = LIKE[op]
  if (like) {
    const pattern = like.pattern(escapeLike(scalar(values[0], label)))
    return { sql: `${col} ${like.not ? 'NOT LIKE' : 'LIKE'} ?`, params: [pattern] }
  }

  switch (op) {
    case 'isNull':
      return { sql: `${col} IS NULL`, params: [] }
    case 'isNotNull':
      return { sql: `${col} IS NOT NULL`, params: [] }
    case 'isEmpty':
      return { sql: `(${col} = '' OR ${col} IS NULL)`, params: [] }
    case 'isNotEmpty':
      return { sql: `(${col} <> '' AND ${col} IS NOT NULL)`, params: [] }
    case 'in':
    case 'notIn': {
      if (!values.length)
        throw new MysqlUserError(`Falta la lista de valores sobre «${cond.column}»`)
      if (values.length > MAX_IN_VALUES) {
        throw new MysqlUserError(`La lista admite como máximo ${MAX_IN_VALUES} valores`)
      }
      const params = values.map((v) => scalar(v, label))
      const marks = params.map(() => '?').join(', ')
      return { sql: `${col} ${op === 'in' ? 'IN' : 'NOT IN'} (${marks})`, params }
    }
    case 'between':
    case 'notBetween': {
      const from = scalar(values[0], `el valor inicial de «${cond.column}»`)
      const to = scalar(values[1], `el valor final de «${cond.column}»`)
      return {
        sql: `${col} ${op === 'between' ? 'BETWEEN' : 'NOT BETWEEN'} ? AND ?`,
        params: [from, to]
      }
    }
  }
  /* c8 ignore next */
  throw new MysqlUserError(`Operador de filtro no válido: ${String(op)}`)
}

function renderCondition(cond: TableFilterCondition, columns: readonly string[]): string | null {
  if (cond.operator === 'custom') {
    const raw = typeof cond.sql === 'string' ? cond.sql.trim() : ''
    // Own lines: a trailing "-- note" in the fragment cannot comment out what follows.
    return raw ? `(\n${raw}\n)` : null
  }
  const { sql, params } = compileCondition(cond, columns)
  // Generated SQL only: escapeId'd identifiers and `?` replaced by driver-escaped values.
  return `(${format(sql, params)})`
}

function checkJoin(op: unknown): TableFilterJoin {
  if (op === 'AND' || op === 'OR') return op
  throw new MysqlUserError('Las condiciones del filtro se combinan con AND u OR')
}

function isNode(value: unknown): value is TableFilterNode {
  return typeof value === 'object' && value !== null && 'kind' in value
}

/** True when the filter has at least one enabled condition that needs the column list. */
export function filterNeedsColumns(filter: TableFilterNode | null | undefined): boolean {
  if (!isNode(filter) || !filter.enabled) return false
  if (filter.kind === 'condition') return filter.operator !== 'custom'
  return Array.isArray(filter.children) && filter.children.some((c) => filterNeedsColumns(c))
}

interface Walk {
  columns: readonly string[]
  count: number
}

/**
 * Renders a group's enabled children joined by the connector of the item before
 * each one (skipped items do not contribute their connector). Returns null when
 * nothing is left. AND/OR precedence is SQL's: every item is parenthesised, the
 * sequence itself is not, exactly like typing it.
 */
function renderGroup(group: TableFilterGroup, walk: Walk, depth: number): string | null {
  if (depth > MAX_FILTER_DEPTH) {
    throw new MysqlUserError(
      `El filtro admite como máximo ${MAX_FILTER_DEPTH} niveles de paréntesis`
    )
  }
  if (!Array.isArray(group.children)) throw new MysqlUserError('Filtro no válido')
  let sql = ''
  let pending: TableFilterJoin | null = null
  for (const child of group.children) {
    if (!isNode(child)) throw new MysqlUserError('Filtro no válido')
    if (!child.enabled) continue
    let part: string | null
    if (child.kind === 'group') {
      const inner = renderGroup(child, walk, depth + 1)
      part = inner === null ? null : `(${inner})`
    } else {
      if (++walk.count > MAX_FILTER_CONDITIONS) {
        throw new MysqlUserError(
          `El filtro admite como máximo ${MAX_FILTER_CONDITIONS} condiciones`
        )
      }
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
 * Builds the WHERE body (without the keyword) for `filter`, or '' when it has no
 * enabled condition. `columns` are the table's real column names.
 */
export function buildFilterWhere(
  filter: TableFilter | null | undefined,
  columns: readonly string[]
): string {
  if (filter === null || filter === undefined) return ''
  if (!isNode(filter) || filter.kind !== 'group') throw new MysqlUserError('Filtro no válido')
  if (!filter.enabled) return ''
  return renderGroup(filter, { columns, count: 0 }, 0) ?? ''
}
