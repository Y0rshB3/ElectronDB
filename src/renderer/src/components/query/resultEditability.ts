import type { CellValue, QueryColumn, TableStructure } from '@shared/types'
// Relative (not @renderer): the node typecheck and integration tests compile this file too.
import { isAutoIncrementColumn, isViewLike } from '../../utils/columnMeta'
import { singleTableSelect } from './selectSource'

/**
 * Decides whether a query result set can be edited in place, like Navicat
 * does when a SELECT reads exactly one base table and returns its whole
 * primary key. Pure functions: the component fetches the table structure.
 *
 * Two stages: `resultSource` reads the statement text (a plain single-table
 * SELECT, see selectSource.ts) and names the table it reads; then
 * `decideEditability` checks that table's type and primary key and
 * cross-checks the result metadata (mysql2 field packets mapped in
 * main/mysql/values.ts) against it. Metadata alone is not enough: for merged
 * derived tables, CTEs and views MySQL reports inner table/column names.
 */

export interface ResultSource {
  schema: string
  table: string
  /** Name the statement uses for the table: its alias, or the table name. */
  alias: string
}

export type SourceCheck = { ok: true; source: ResultSource } | { ok: false; reason: string }

export type Editability =
  | {
      editable: true
      schema: string
      table: string
      /** Primary key as source column names, in index order (RowChange keys). */
      primaryKey: string[]
      /** Result column names (aliases) that hold the primary key, for the grid key icon. */
      keyColumns: string[]
      /**
       * Result column that receives the generated id of an insert: the single
       * primary key column when it is the table's AUTO_INCREMENT column, else null.
       */
      generatedKeyColumn: string | null
    }
  | { editable: false; reason: string; schema?: string; table?: string }

export const REASON_COMPUTED = 'columnas calculadas'
export const REASON_MISMATCH = 'el resultado no coincide con la tabla de la consulta'
export const REASON_DUPLICATE_KEYS = 'hay filas repetidas con la misma clave'

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })

/** MySQL column names (and, on macOS, table names) are case-insensitive. */
const norm = (name: string): string => name.toLowerCase()
const same = (a: string | undefined, b: string): boolean => a !== undefined && norm(a) === norm(b)

/**
 * Statement stage, no server round trip: does the SELECT read exactly one
 * table reference? The schema falls back to the one the result reports.
 */
export function resultSource(columns: QueryColumn[], sql: string): SourceCheck {
  if (!columns.length) return fail('el resultado no tiene columnas')
  const parsed = singleTableSelect(sql)
  if (!parsed.ok) return fail(parsed.reason)
  const { ref } = parsed
  const schema = ref.schema ?? columns.find((c) => c.schema)?.schema
  // SELECT COUNT(*) FROM t: nothing in the result names a schema.
  if (!schema) return fail(REASON_COMPUTED)
  return { ok: true, source: { schema, table: ref.table, alias: ref.alias ?? ref.table } }
}

/**
 * Primary key columns of a table, in index order (empty when it has none).
 * IndexInfo.primary when the driver sets it; otherwise MySQL's index name.
 */
export function primaryKeyOf(structure: Pick<TableStructure, 'indexes'>): string[] {
  return structure.indexes.find((i) => i.primary ?? i.name === 'PRIMARY')?.columns ?? []
}

/** Index of the first row whose key repeats an earlier one, or -1. */
export function duplicateKeyRow(rows: CellValue[][], keyIndexes: number[]): number {
  const seen = new Set<string>()
  for (let r = 0; r < rows.length; r++) {
    const key = JSON.stringify(keyIndexes.map((k) => rows[r][k] ?? null))
    if (seen.has(key)) return r
    seen.add(key)
  }
  return -1
}

/**
 * Final decision. `structure` is the structure of the table named in the
 * statement (db:tableStructure), or null when it could not be read. `rows`
 * are the loaded rows, checked for repeated keys.
 */
export function decideEditability(
  columns: QueryColumn[],
  source: ResultSource,
  structure:
    | (Pick<TableStructure, 'indexes' | 'tableType'> &
        Partial<Pick<TableStructure, 'columns' | 'kind'>>)
    | null,
  rows: CellValue[][] = []
): Editability {
  const where = { schema: source.schema, table: source.table }
  if (!structure) return { editable: false, reason: 'no se pudo comprobar la tabla', ...where }
  if (isViewLike(structure)) return { editable: false, reason: 'el origen es una vista', ...where }

  if (columns.some((c) => !c.table || !c.schema || !c.sourceName))
    return { editable: false, reason: REASON_COMPUTED, ...where }
  // Defence in depth: every column must come from the table reference the statement names.
  const matches = (c: QueryColumn): boolean =>
    same(c.schema, source.schema) && same(c.table, source.table) && same(c.tableAlias, source.alias)
  if (!columns.every(matches)) return { editable: false, reason: REASON_MISMATCH, ...where }

  const seen = new Set<string>()
  for (const c of columns) {
    const key = norm(c.sourceName!)
    if (seen.has(key))
      return { editable: false, reason: 'la misma columna aparece varias veces', ...where }
    seen.add(key)
  }

  const pk = primaryKeyOf(structure)
  if (!pk.length) return { editable: false, reason: 'la tabla no tiene clave primaria', ...where }

  const keyIndexes = pk.map((k) => columns.findIndex((c) => same(c.sourceName, k)))
  if (keyIndexes.some((i) => i < 0))
    return { editable: false, reason: 'falta la clave primaria completa en el resultado', ...where }
  // Cannot happen for one base table with its whole key; refuse rather than write twice.
  if (duplicateKeyRow(rows, keyIndexes) >= 0)
    return { editable: false, reason: REASON_DUPLICATE_KEYS, ...where }

  const keyCols = keyIndexes.map((i) => columns[i])
  const autoIncrement =
    pk.length === 1 &&
    !!structure.columns?.some((c) => same(c.name, pk[0]) && isAutoIncrementColumn(c))
  return {
    editable: true,
    // Spelled as the result reports them so they match the payload columns below.
    schema: keyCols[0].schema!,
    table: keyCols[0].table!,
    primaryKey: keyCols.map((c) => c.sourceName!),
    keyColumns: keyCols.map((c) => c.name),
    generatedKeyColumn: autoIncrement ? keyCols[0].name : null
  }
}

/** Result columns renamed to their real table columns: what RowChange payloads must use. */
export function payloadColumns(columns: QueryColumn[]): QueryColumn[] {
  return columns.map((c) => ({ ...c, name: c.sourceName ?? c.name }))
}
