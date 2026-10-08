/**
 * DDL editor for SQLite views and triggers (docs/multi-engine-design.md,
 * section 8.1: "SQLite uses DROP plus CREATE"). SQLite DDL is transactional,
 * so the script drops and recreates the object inside BEGIN … COMMIT: when
 * the new definition fails, the transaction is rolled back and nothing
 * changes. Names are read with the SQLite lexer ("…", […] and `…` quoting).
 */
import { qualified, quoteIdent } from '@shared/dialects/sqlite'
import { sqliteCodeTokens, tokenizeSqlite, type SqliteToken } from '@shared/dialects/sqliteLexer'
import type { DdlSupport } from '@renderer/engines/types'
import type { DdlObjectType, DdlScriptOptions } from './ddl'

const KEYWORD: Partial<Record<DdlObjectType, string>> = { view: 'VIEW', trigger: 'TRIGGER' }

const upper = (t: SqliteToken | undefined): string =>
  t && t.kind === 'word' ? t.value.toUpperCase() : ''
const isName = (t: SqliteToken | undefined): boolean =>
  !!t && (t.kind === 'word' || t.kind === 'ident' || t.kind === 'string')
const nameOf = (t: SqliteToken): string =>
  t.kind === 'string' ? t.value.slice(1, -1).replace(/''/g, "'") : t.value

/** Name (unqualified, unquoted) of the first `CREATE [TEMP] VIEW|TRIGGER [IF NOT EXISTS] [db.]name`. */
export function sqliteParseObjectName(sql: string, type: DdlObjectType): string | null {
  const keyword = KEYWORD[type]
  if (!keyword) return null
  const tokens = sqliteCodeTokens(tokenizeSqlite(sql))
  for (let i = 0; i < tokens.length; i++) {
    if (upper(tokens[i]) !== 'CREATE') continue
    let j = i + 1
    if (upper(tokens[j]) === 'TEMP' || upper(tokens[j]) === 'TEMPORARY') j++
    if (upper(tokens[j]) !== keyword) continue
    j++
    if (
      upper(tokens[j]) === 'IF' &&
      upper(tokens[j + 1]) === 'NOT' &&
      upper(tokens[j + 2]) === 'EXISTS'
    )
      j += 3
    if (!isName(tokens[j])) return null
    if (tokens[j + 1]?.kind === 'punct' && tokens[j + 1].value === '.' && isName(tokens[j + 2]))
      return nameOf(tokens[j + 2])
    return nameOf(tokens[j])
  }
  return null
}

export function sqliteIsRename(
  source: string,
  type: DdlObjectType,
  originalName: string | null
): boolean {
  if (!originalName) return false
  const name = sqliteParseObjectName(source, type)
  // SQLite names are case-insensitive.
  return !!name && name.toLowerCase() !== originalName.toLowerCase()
}

/**
 * BEGIN; DROP <type> IF EXISTS "db"."original"; <source>; COMMIT. A new
 * object (no original name) is only the CREATE, inside the same transaction.
 */
export function sqliteBuildDdlScript(source: string, options: DdlScriptOptions): string {
  const keyword = KEYWORD[options.type] ?? options.type.toUpperCase()
  const body = source.trim().replace(/;\s*$/, '')
  const lines = ['BEGIN;']
  if (options.originalName)
    lines.push(
      `DROP ${keyword} IF EXISTS ${qualified(options.schema || 'main', options.originalName)};`
    )
  lines.push(`${body};`, 'COMMIT;')
  return lines.join('\n')
}

export function sqliteDdlTemplate(type: DdlObjectType): string {
  if (type === 'trigger')
    return [
      `CREATE TRIGGER ${quoteIdent('nuevo_trigger')}`,
      'AFTER INSERT ON tabla',
      'FOR EACH ROW',
      'BEGIN',
      '  -- UPDATE otra_tabla SET … WHERE id = NEW.id;',
      '  SELECT 1;',
      'END'
    ].join('\n')
  return [`CREATE VIEW ${quoteIdent('nueva_vista')} AS`, 'SELECT', '  1 AS columna'].join('\n')
}

export const sqliteDdlSupport: DdlSupport = {
  template: sqliteDdlTemplate,
  buildScript: sqliteBuildDdlScript,
  parseObjectName: sqliteParseObjectName,
  isRename: sqliteIsRename
}
