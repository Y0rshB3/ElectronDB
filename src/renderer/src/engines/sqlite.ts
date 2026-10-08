import { ENGINES } from '@shared/engines'
import { sqliteDialect } from '@shared/dialects/sqlite'
import { vortaqSQLite } from '@renderer/components/common/editor/sqliteCompletion'
import { sqliteDdlSupport } from '@renderer/components/designer/sqliteDdl'
import { sqliteTablePlanner } from '@renderer/components/designer/sqlite/planner'
import type { EngineUi, TablePlanner } from './types'

/**
 * SQLite renderer engine (P3, preview): the shared SQLite dialect and the
 * CodeMirror SQLite language. The table designer (rebuild planner) and the
 * DDL templates for views and triggers are registered here too. No users view
 * and no table storage engines.
 */
export const sqliteUi: EngineUi = {
  id: 'sqlite',
  descriptor: ENGINES.sqlite,
  dialect: sqliteDialect,
  editorLanguage: vortaqSQLite,
  designer: sqliteTablePlanner satisfies TablePlanner,
  typeCatalog: { tableEngines: [] },
  ddl: sqliteDdlSupport,
  userSql: null
}
