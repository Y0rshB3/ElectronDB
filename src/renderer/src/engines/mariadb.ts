import { ENGINES } from '@shared/engines'
import { mariadbDialect } from '@shared/dialects/mariadb'
import { vortaqMariaSQL } from '@renderer/components/common/editor/mariadbCompletion'
import {
  MARIADB_COLUMN_TYPES,
  MARIADB_TABLE_ENGINES,
  mariadbBuildAlter,
  mariadbBuildCreate,
  mariadbDraftFromStructure,
  mariadbEmptyTable
} from '@renderer/components/designer/mariadb/planner'
import {
  buildDdlScript,
  ddlTemplate,
  isRename,
  parseObjectName
} from '@renderer/components/designer/ddl'
import { userActionSql } from '@renderer/components/data/userSql'
import type { EngineUi } from './types'

/**
 * MariaDB renderer engine (P5): the MySQL modules (DDL editor, users SQL)
 * with the MariaDB dialect (`/*M!`, sequence functions in the guard), the
 * MariaSQL editor language and the MariaDB designer (uuid/inet types, system
 * versioning).
 */
export const mariadbUi: EngineUi = {
  id: 'mariadb',
  descriptor: ENGINES.mariadb,
  dialect: mariadbDialect,
  editorLanguage: vortaqMariaSQL,
  designer: {
    emptyTable: mariadbEmptyTable,
    draftFromStructure: mariadbDraftFromStructure,
    buildCreate: mariadbBuildCreate,
    buildAlter: mariadbBuildAlter
  },
  typeCatalog: { tableEngines: MARIADB_TABLE_ENGINES, columnTypes: MARIADB_COLUMN_TYPES },
  ddl: {
    template: ddlTemplate,
    buildScript: buildDdlScript,
    parseObjectName,
    isRename
  },
  userSql: { actionSql: userActionSql }
}
