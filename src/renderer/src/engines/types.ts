import type { SQLDialect } from '@codemirror/lang-sql'
import type { EngineDescriptor } from '@shared/engines'
import type { SqlDialect } from '@shared/dialects/types'
import type { EngineId, TableStructure } from '@shared/types'
import type { DesignerAlter } from '@renderer/components/designer/alterTable'
import type { DdlObjectType, DdlScriptOptions } from '@renderer/components/designer/ddl'
import type { UserAction, UserActionForm } from '@renderer/components/data/userSql'
import type { TableDraft } from '@renderer/utils/tableDesigner'

/*
 * Renderer side of an engine (docs/multi-engine-design.md, section 8.1).
 * Each member wraps a module the views already use; P1a adds the indirection
 * only. Members are added together with their first consumer, so the design's
 * completionSource, format, newTableDraft, connectionSection and
 * objectColumns arrive with the engines that need them.
 */

/** Table designer: today's TableDraft model and its SQL builders. */
export interface TablePlanner {
  emptyTable(): TableDraft
  draftFromStructure(structure: TableStructure): TableDraft
  /** CREATE TABLE for a new table. */
  buildCreate(schema: string, draft: TableDraft): string
  /** ALTER plan (statements, risks, problems) for an existing table. */
  buildAlter(original: TableStructure, draft: TableDraft): DesignerAlter
}

/** Type and option lists of the table designer. */
export interface TypeCatalog {
  /** Table storage engines offered in the designer (MySQL ENGINE=). */
  tableEngines: string[]
}

/** DDL editor: templates and the script that applies an edited CREATE statement. */
export interface DdlSupport {
  template(type: DdlObjectType): string
  buildScript(source: string, options: DdlScriptOptions): string
  parseObjectName(sql: string, type: DdlObjectType): string | null
  isRename(source: string, type: DdlObjectType, originalName: string | null): boolean
}

/** Account management SQL (Users view). */
export interface UserSqlBuilder {
  actionSql(action: UserAction, form: UserActionForm, masked?: boolean): string
}

export interface EngineUi {
  id: EngineId
  descriptor: EngineDescriptor
  /** Shared SQL dialect; null for MongoDB. */
  dialect: SqlDialect | null
  /** CodeMirror SQL dialect used by the editor (highlighting and completion). */
  editorLanguage: SQLDialect
  designer: TablePlanner | null
  typeCatalog: TypeCatalog | null
  ddl: DdlSupport | null
  /** mysql/mariadb only in v1. */
  userSql: UserSqlBuilder | null
}
