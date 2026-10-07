import { ENGINES } from '@shared/engines'
import { postgresqlDialect } from '@shared/dialects/postgresql'
import { vortaqPostgreSQL } from '@renderer/components/common/editor/pgCompletion'
import { pgDdlSupport } from '@renderer/components/designer/pg/ddl'
import { pgTablePlanner } from '@renderer/components/designer/pg/planner'
import type { EngineUi, TablePlanner } from './types'

/**
 * PostgreSQL renderer engine (P2a/P2b, preview): the shared PG dialect, the
 * CodeMirror PostgreSQL language, the PG table designer and DDL templates.
 * No users view in v1 (`userSql: null`) and no table storage engines.
 */
export const postgresqlUi: EngineUi = {
  id: 'postgresql',
  descriptor: ENGINES.postgresql,
  dialect: postgresqlDialect,
  editorLanguage: vortaqPostgreSQL,
  designer: pgTablePlanner satisfies TablePlanner,
  typeCatalog: { tableEngines: [] },
  ddl: pgDdlSupport,
  userSql: null
}
