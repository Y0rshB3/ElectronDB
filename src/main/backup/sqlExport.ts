import type { SqlExportOptions, SqlExportResult } from '@shared/importers'
import type { CreateDeps } from './create'
import type { ProgressReporter } from './index'

/** Plain .sql dump of one schema (mysqldump-compatible). STUB: implemented in phase 3. */
export async function exportSchemaToSql(
  _deps: CreateDeps,
  _options: SqlExportOptions,
  _progress?: ProgressReporter,
  _signal?: AbortSignal
): Promise<SqlExportResult> {
  throw new Error('No implementado')
}
