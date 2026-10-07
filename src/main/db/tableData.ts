/**
 * Engine-neutral table browsing (docs/multi-engine-design.md, section 5.1):
 * primary key, one page of rows, and a best-effort total. The engine builds
 * its own SQL (MySQL: src/main/mysql/tableData.ts, unchanged); this file only
 * fixes the order of the steps and the "a count that fails is null" rule.
 */
import { performance } from 'node:perf_hooks'
import type { CellValue, QueryColumn, TableDataPage } from '@shared/types'

export interface TablePageSource {
  primaryKey(): Promise<string[]>
  page(): Promise<{ columns: QueryColumn[]; rows: CellValue[][] }>
  /** Total rows, or null when unknown. May throw (timeout): the total is then null. */
  count(): Promise<number | null>
}

/**
 * Loads one page of a table plus its primary key and (best effort) total row count.
 * `started` (performance.now()) lets the engine include its own preparation
 * (MySQL: reading the columns a structured filter needs) in durationMs.
 */
export async function fetchTablePage(
  source: TablePageSource,
  started: number = performance.now()
): Promise<TableDataPage> {
  const primaryKey = await source.primaryKey()
  const { columns, rows } = await source.page()

  let total: number | null = null
  try {
    total = await source.count()
  } catch {
    // timeout or an engine that cannot count cheaply: leave null
    total = null
  }

  return { columns, rows, primaryKey, total, durationMs: Math.round(performance.now() - started) }
}
