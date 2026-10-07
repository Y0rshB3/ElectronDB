import type {
  ImportConnectionsPreview,
  ImportConnectionsRequest,
  ImportConnectionsResult,
  ImportSourceId
} from '@shared/importers'
import type { AppContext } from '../../context'

/** The slice of the app context connection imports need (keeps tests free of Electron). */
export type ConnectionImportContext = Pick<AppContext, 'connections' | 'credentials' | 'settings'>

/** Preview of the connections in `path` (a file of `source`). STUB: implemented in phase 3. */
export async function previewConnectionFile(
  _ctx: Pick<AppContext, 'connections'>,
  _source: ImportSourceId,
  _path: string
): Promise<ImportConnectionsPreview> {
  throw new Error('No implementado')
}

/** Imports the selected connections of a file. STUB: implemented in phase 3. */
export async function importConnectionFile(
  _ctx: ConnectionImportContext,
  _request: ImportConnectionsRequest
): Promise<ImportConnectionsResult> {
  throw new Error('No implementado')
}
