import { ENGINES } from '@shared/engines'
import { mysqlDialect } from '@shared/dialects/mysql'
import { electronDBMySQL } from '@renderer/components/common/editor/sqlCompletion'
import { buildDesignerAlter } from '@renderer/components/designer/alterTable'
import { ENGINES as TABLE_ENGINES } from '@renderer/components/designer/columnType'
import {
  buildDdlScript,
  ddlTemplate,
  isRename,
  parseObjectName
} from '@renderer/components/designer/ddl'
import { userActionSql } from '@renderer/components/data/userSql'
import { buildCreateTable, draftFromStructure, emptyTable } from '@renderer/utils/tableDesigner'
import type { EngineUi } from './types'

/**
 * MySQL renderer engine: today's modules, unchanged and referenced as they
 * are (identity is pinned by engines/index.test.ts).
 */
export const mysqlUi: EngineUi = {
  id: 'mysql',
  descriptor: ENGINES.mysql,
  dialect: mysqlDialect,
  editorLanguage: electronDBMySQL,
  designer: {
    emptyTable,
    draftFromStructure,
    buildCreate: buildCreateTable,
    buildAlter: buildDesignerAlter
  },
  typeCatalog: { tableEngines: TABLE_ENGINES },
  ddl: {
    template: ddlTemplate,
    buildScript: buildDdlScript,
    parseObjectName,
    isRename
  },
  userSql: { actionSql: userActionSql }
}
