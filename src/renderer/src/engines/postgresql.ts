import { ENGINES } from '@shared/engines'
import { postgresqlDialect } from '@shared/dialects/postgresql'
import { vortaqPostgreSQL } from '@renderer/components/common/editor/pgCompletion'
import { pgDdlSupport } from '@renderer/components/designer/pg/ddl'
import type { EngineUi } from './types'

/**
 * PostgreSQL renderer engine (P2a, preview): the shared PG dialect, the
 * CodeMirror PostgreSQL language and the DDL viewer/editor. The table
 * designer arrives with P2b. No users view in v1 (`userSql: null`).
 */
export const postgresqlUi: EngineUi = {
  id: 'postgresql',
  descriptor: ENGINES.postgresql,
  dialect: postgresqlDialect,
  editorLanguage: vortaqPostgreSQL,
  designer: null,
  typeCatalog: { tableEngines: [] },
  ddl: pgDdlSupport,
  userSql: null
}
