import type {
  SqlDumpImportOptions,
  SqlDumpImportResult,
  SqlDumpInspection,
  SqlFolderImportRequest,
  SqlFolderImportResult,
  SqlFolderPreview
} from '@shared/importers'
import type { ConnectionConfig } from '@shared/types'
import type { BackupService, ProgressReporter } from '../../backup/index'
import type { SessionFactory } from '../../mysql/types'

export interface SqlImportDeps {
  connections: { get(id: string): ConnectionConfig | null }
  sessions: SessionFactory
  /** Safety copies (.nb3) before a database is replaced. */
  backups: Pick<BackupService, 'create'>
}

/** STUB: implemented in phase 3. */
export async function inspectSqlDump(_path: string): Promise<SqlDumpInspection> {
  throw new Error('No implementado')
}

/** STUB: implemented in phase 3. */
export async function importSqlDump(
  _deps: SqlImportDeps,
  _options: SqlDumpImportOptions,
  _progress?: ProgressReporter,
  _signal?: AbortSignal
): Promise<SqlDumpImportResult> {
  throw new Error('No implementado')
}

/** STUB: implemented in phase 3. */
export async function previewSqlFolder(_dir: string): Promise<SqlFolderPreview> {
  throw new Error('No implementado')
}

/** STUB: implemented in phase 3. */
export async function importSqlFolder(
  _deps: SqlImportDeps,
  _request: SqlFolderImportRequest,
  _progress?: ProgressReporter,
  _signal?: AbortSignal
): Promise<SqlFolderImportResult> {
  throw new Error('No implementado')
}
