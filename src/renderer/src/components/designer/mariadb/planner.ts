/**
 * MariaDB table designer (P5): the MySQL designer (utils/tableDesigner.ts,
 * designer/alterTable.ts, reused untouched) plus what only MariaDB has:
 *
 * - the MariaDB column types `uuid`, `inet4` and `inet6` in the type list
 *   (JSON stays `json`: main reports a LONGTEXT column with MariaDB's own
 *   `json_valid` check as `json`, so the round trip keeps the alias);
 * - system-versioned tables: `options.systemVersioning` creates the table
 *   `WITH SYSTEM VERSIONING` and toggles `ADD`/`DROP SYSTEM VERSIONING`;
 *   altering a versioned table first sets `system_versioning_alter_history =
 *   KEEP` for the session, which MariaDB requires for any ALTER of one;
 * - no utf8mb4_0900_ai_ci (absent before MariaDB 11.4): a new table starts
 *   without a collation and the view fills in the database's own.
 */
import type { TableStructure } from '@shared/types'
import { buildDesignerAlter, type DesignerAlter } from '@renderer/components/designer/alterTable'
import { COLUMN_TYPES } from '@renderer/components/designer/columnType'
import {
  buildCreateTable,
  draftFromStructure,
  emptyTable,
  type TableDraft
} from '@renderer/utils/tableDesigner'
import { quoteIdent } from '@renderer/utils/sql'

/** MariaDB-only types offered after `json` in the designer. */
export const MARIADB_ONLY_TYPES = ['uuid', 'inet4', 'inet6']

export const MARIADB_COLUMN_TYPES = (() => {
  const types = [...COLUMN_TYPES]
  types.splice(types.indexOf('json') + 1, 0, ...MARIADB_ONLY_TYPES)
  return types
})()

/** Storage engines a MariaDB server ships by default (free text is still allowed). */
export const MARIADB_TABLE_ENGINES = ['InnoDB', 'Aria', 'MyISAM', 'MEMORY', 'ARCHIVE', 'CSV']

export const KEEP_HISTORY_SQL = 'SET @@SESSION.system_versioning_alter_history = KEEP;'

export const DROP_VERSIONING_RISK =
  'Se quita el versionado de sistema: se borra todo el historial de versiones de la tabla'

const isVersioned = (s: TableStructure): boolean =>
  s.kind === 'system-versioned' || /^SYSTEM VERSIONED$/i.test(s.tableType ?? '')

const wantsVersioning = (d: TableDraft): boolean => d.options?.systemVersioning === true

export function mariadbEmptyTable(): TableDraft {
  return { ...emptyTable(), collation: '', options: { systemVersioning: false } }
}

export function mariadbDraftFromStructure(structure: TableStructure): TableDraft {
  return {
    ...draftFromStructure(structure),
    options: { systemVersioning: isVersioned(structure) }
  }
}

export function mariadbBuildCreate(schema: string, draft: TableDraft): string {
  const sql = buildCreateTable(schema, draft)
  return wantsVersioning(draft) ? sql.replace(/;$/, ' WITH SYSTEM VERSIONING;') : sql
}

export function mariadbBuildAlter(original: TableStructure, draft: TableDraft): DesignerAlter {
  const plan = buildDesignerAlter(original, draft)
  const was = isVersioned(original)
  const wants = wantsVersioning(draft)
  const statements = [...plan.statements]
  const risks = [...plan.risks]
  const target = `${quoteIdent(original.schema)}.${quoteIdent(original.name)}`
  // Versioning changes go before a RENAME TABLE, while the table still has its old name.
  const renameAt = statements.findIndex((s) => /^\s*RENAME TABLE/.test(s))
  const insertAt = renameAt >= 0 ? renameAt : statements.length
  if (!was && wants) statements.splice(insertAt, 0, `ALTER TABLE ${target} ADD SYSTEM VERSIONING;`)
  if (was && !wants) {
    statements.splice(insertAt, 0, `ALTER TABLE ${target} DROP SYSTEM VERSIONING;`)
    risks.push(DROP_VERSIONING_RISK)
  }
  if (was && statements.length) statements.unshift(KEEP_HISTORY_SQL)
  return { ...plan, statements, risks }
}
