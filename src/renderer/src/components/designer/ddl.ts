import type { ObjectType } from '@shared/types'
import { qualified } from '@renderer/utils/sql'

export type DdlObjectType = Exclude<ObjectType, 'table'>

const USER_PART = '(?:`(?:[^`]|``)*`|\'(?:[^\'\\\\]|\\\\.)*\'|"(?:[^"\\\\]|\\\\.)*"|[\\w.%$-]+)'
const DEFINER_RE = new RegExp(
  `\\s*DEFINER\\s*=\\s*(?:CURRENT_USER(?:\\s*\\(\\s*\\))?|${USER_PART}\\s*@\\s*${USER_PART}|${USER_PART})`,
  'gi'
)

/** Removes every `DEFINER=user@host` clause so the object is created for the current user. */
export function stripDefiner(sql: string): string {
  return sql.replace(DEFINER_RE, '')
}

const KEYWORD: Record<DdlObjectType, string> = {
  view: 'VIEW',
  function: 'FUNCTION',
  procedure: 'PROCEDURE',
  event: 'EVENT',
  trigger: 'TRIGGER'
}

export function objectKeyword(type: DdlObjectType): string {
  return KEYWORD[type]
}

/** Extracts the object name from a CREATE statement (unqualified, unquoted). */
export function parseObjectName(sql: string, type: DdlObjectType): string | null {
  const ident = '(?:`((?:[^`]|``)+)`|([\\w$]+))'
  const re = new RegExp(
    `\\b${KEYWORD[type]}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${ident}\\s*\\.\\s*)?${ident}`,
    'i'
  )
  const m = re.exec(sql)
  if (!m) return null
  return (m[3] ?? m[4] ?? '').replace(/``/g, '`') || null
}

function pickDelimiter(body: string): string {
  for (const d of ['$$', '//', ';;', '$$$']) if (!body.includes(d)) return d
  return '$$$$'
}

function dropsObject(script: string, keyword: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/`/g, '``')
  return new RegExp(
    `\\bDROP\\s+${keyword}\\s+(?:IF\\s+EXISTS\\s+)?(?:[^\\s;]+\\.)?\`?${escaped}\`?(?![\\w$])`,
    'i'
  ).test(script)
}

export interface DdlScriptOptions {
  type: DdlObjectType
  schema: string
  /** Name of the existing object to replace; null when creating a new object. */
  originalName: string | null
  removeDefiner: boolean
}

/**
 * Builds the script that applies an edited CREATE statement:
 * - views: CREATE OR REPLACE
 * - routines, triggers and events: DROP IF EXISTS + CREATE wrapped in DELIMITER
 *   (the main-process splitter honours DELIMITER like the mysql CLI).
 */
export function buildDdlScript(source: string, options: DdlScriptOptions): string {
  let body = source.trim().replace(/;+\s*$/, '')
  if (options.removeDefiner) body = stripDefiner(body)
  const keyword = KEYWORD[options.type]
  const newName = parseObjectName(body, options.type)
  const renamed = !!options.originalName && !!newName && newName !== options.originalName
  const dropOriginal = options.originalName
    ? `DROP ${keyword} IF EXISTS ${qualified(options.schema, options.originalName)};`
    : null

  if (options.type === 'view') {
    const create = /^\s*CREATE\s+OR\s+REPLACE\b/i.test(body)
      ? `${body};`
      : `${body.replace(/^\s*CREATE\b/i, 'CREATE OR REPLACE')};`
    // CREATE OR REPLACE under a new name leaves the old view behind: drop it once the new one exists.
    return renamed ? `${create}\n${dropOriginal}` : create
  }

  const parts: string[] = []
  const managesDelimiters = /^\s*DELIMITER\s+/im.test(body)
  if (dropOriginal && !(managesDelimiters && dropsObject(body, keyword, options.originalName!)))
    parts.push(dropOriginal)

  if (managesDelimiters) {
    // The user manages delimiters: keep the script as written, only without DEFINER when asked.
    parts.push(options.removeDefiner ? stripDefiner(source.trim()) : source.trim())
    return parts.join('\n')
  }

  const delimiter = pickDelimiter(body)
  parts.push(`DELIMITER ${delimiter}`, `${body}${delimiter}`, 'DELIMITER ;')
  return parts.join('\n')
}

/** True when applying the edited source would replace the original under a different name. */
export function isRename(
  source: string,
  type: DdlObjectType,
  originalName: string | null
): boolean {
  const name = parseObjectName(source, type)
  return !!originalName && !!name && name !== originalName
}

export function ddlTemplate(type: DdlObjectType): string {
  switch (type) {
    case 'view':
      return 'CREATE VIEW `nueva_vista` AS\nSELECT 1 AS `columna`;'
    case 'function':
      return [
        'CREATE FUNCTION `nueva_funcion`(p_valor INT)',
        'RETURNS INT',
        'DETERMINISTIC',
        'BEGIN',
        '  RETURN p_valor;',
        'END'
      ].join('\n')
    case 'procedure':
      return [
        'CREATE PROCEDURE `nuevo_procedimiento`(IN p_id INT)',
        'BEGIN',
        '  SELECT p_id;',
        'END'
      ].join('\n')
    case 'event':
      return [
        'CREATE EVENT `nuevo_evento`',
        'ON SCHEDULE EVERY 1 DAY',
        'STARTS CURRENT_TIMESTAMP',
        'DO',
        'BEGIN',
        '  -- sentencias',
        '  DO 1;',
        'END'
      ].join('\n')
    case 'trigger':
      return [
        'CREATE TRIGGER `nuevo_trigger`',
        'BEFORE INSERT ON `tabla`',
        'FOR EACH ROW',
        'BEGIN',
        '  -- SET NEW.columna = valor;',
        'END'
      ].join('\n')
  }
}
