/**
 * PostgreSQL DDL editor support (docs/multi-engine-design.md, section 8.1):
 * templates, the script that applies an edited CREATE statement, and name
 * parsing. Bodies are dollar-quoted (`$$ … $$`): there is no DELIMITER, the
 * PostgreSQL splitter keeps a `$$` body in one statement.
 */
import type { DdlObjectType, DdlScriptOptions } from '@renderer/components/designer/ddl'
import type { DdlSupport } from '@renderer/engines/types'
import { pgQualified, pgQuote } from './types'

/** Object types the PostgreSQL DDL editor handles (events do not exist in PostgreSQL). */
export type PgDdlObjectType = Exclude<DdlObjectType, 'event'> | 'materialized_view'

export interface PgDdlScriptOptions extends Omit<DdlScriptOptions, 'type'> {
  type: PgDdlObjectType | DdlObjectType
  /** Routines: identity arguments of the original (`integer, text`) for DROP FUNCTION. */
  signature?: string
  /** Triggers: table of the original trigger (DROP TRIGGER … ON <table>). */
  table?: string
}

const KEYWORD: Record<PgDdlObjectType, string> = {
  view: 'VIEW',
  materialized_view: 'MATERIALIZED\\s+VIEW',
  function: 'FUNCTION',
  procedure: 'PROCEDURE',
  trigger: 'TRIGGER'
}

const DROP_KEYWORD: Record<PgDdlObjectType, string> = {
  view: 'VIEW',
  materialized_view: 'MATERIALIZED VIEW',
  function: 'FUNCTION',
  procedure: 'PROCEDURE',
  trigger: 'TRIGGER'
}

function pgType(type: PgDdlObjectType | DdlObjectType): PgDdlObjectType {
  if (type === 'event') throw new Error('PostgreSQL no tiene eventos programados.')
  return type
}

const IDENT = '"(?:[^"]|"")+"|[A-Za-z_\\u0080-\\uffff][\\w$\\u0080-\\uffff]*'

/** Unquoted names fold to lower case; quoted ones keep their case ("" -> "). */
function identName(raw: string): string {
  return raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw.toLowerCase()
}

/** The text before the first dollar-quoted body, where the object header lives. */
function header(sql: string): string {
  const at = sql.search(/\$[A-Za-z_]*\$/)
  return at < 0 ? sql : sql.slice(0, at)
}

function nameMatch(sql: string, type: PgDdlObjectType): RegExpExecArray | null {
  const re = new RegExp(
    `\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:(?:TEMP|TEMPORARY|RECURSIVE|CONSTRAINT)\\s+)?${KEYWORD[type]}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:(${IDENT})\\s*\\.\\s*)?(${IDENT})`,
    'i'
  )
  return re.exec(header(sql))
}

/** Object name of a CREATE statement (unqualified; unquoted names folded to lower case). */
export function pgParseObjectName(
  sql: string,
  type: PgDdlObjectType | DdlObjectType
): string | null {
  if (type === 'event') return null
  const m = nameMatch(sql, type)
  return m ? identName(m[2]) : null
}

/** Schema written in a CREATE statement, or null when the name is unqualified. */
export function pgParseObjectSchema(
  sql: string,
  type: PgDdlObjectType | DdlObjectType
): string | null {
  if (type === 'event') return null
  const m = nameMatch(sql, type)
  return m?.[1] ? identName(m[1]) : null
}

/** Table of a CREATE TRIGGER statement (`… ON [schema.]table …`), or null. */
export function pgParseTriggerTable(sql: string): { schema: string | null; table: string } | null {
  const m = new RegExp(`\\bON\\s+(?:(${IDENT})\\s*\\.\\s*)?(${IDENT})`, 'i').exec(header(sql))
  return m ? { schema: m[1] ? identName(m[1]) : null, table: identName(m[2]) } : null
}

export function pgIsRename(
  source: string,
  type: PgDdlObjectType | DdlObjectType,
  originalName: string | null
): boolean {
  const name = pgParseObjectName(source, type)
  return !!originalName && !!name && name !== originalName
}

/** `CREATE …` -> `CREATE OR REPLACE …` (views, functions and procedures). */
function orReplace(body: string): string {
  return /^\s*CREATE\s+OR\s+REPLACE\b/i.test(body)
    ? body
    : body.replace(/^\s*CREATE\b/i, 'CREATE OR REPLACE')
}

/**
 * Script that applies an edited CREATE statement:
 * - views, functions, procedures: CREATE OR REPLACE; a renamed object drops the
 *   original (views after the new one exists; routines before, with the signature);
 * - materialized views: DROP MATERIALIZED VIEW IF EXISTS, then CREATE;
 * - triggers: DROP TRIGGER IF EXISTS … ON <table>, then CREATE.
 */
export function pgBuildDdlScript(source: string, options: PgDdlScriptOptions): string {
  const type = pgType(options.type)
  const body = source.trim().replace(/;+\s*$/, '')
  const newName = pgParseObjectName(body, type)
  const renamed = !!options.originalName && !!newName && newName !== options.originalName
  const original = options.originalName ? pgQualified(options.schema, options.originalName) : null

  switch (type) {
    case 'view': {
      const create = `${orReplace(body)};`
      return renamed ? `${create}\nDROP VIEW IF EXISTS ${original};` : create
    }
    case 'function':
    case 'procedure': {
      const create = `${orReplace(body)};`
      if (!renamed) return create
      const args = options.signature !== undefined ? `(${options.signature})` : ''
      return `DROP ${DROP_KEYWORD[type]} IF EXISTS ${original}${args};\n${create}`
    }
    case 'materialized_view': {
      const create = `${body.replace(/^\s*CREATE\s+OR\s+REPLACE\s+/i, 'CREATE ')};`
      const target =
        original ??
        (newName ? pgQualified(pgParseObjectSchema(body, type) ?? options.schema, newName) : null)
      return target ? `DROP MATERIALIZED VIEW IF EXISTS ${target};\n${create}` : create
    }
    case 'trigger': {
      const parsed = pgParseTriggerTable(body)
      const table = options.table
        ? pgQualified(options.schema, options.table)
        : parsed
          ? pgQualified(parsed.schema ?? options.schema, parsed.table)
          : null
      const dropName = options.originalName ?? newName
      const drop =
        dropName && table ? `DROP TRIGGER IF EXISTS ${pgQuote(dropName)} ON ${table};\n` : ''
      return `${drop}${body};`
    }
  }
}

export function pgDdlTemplate(type: PgDdlObjectType | DdlObjectType): string {
  switch (pgType(type)) {
    case 'view':
      return 'CREATE OR REPLACE VIEW nueva_vista AS\nSELECT 1 AS columna;'
    case 'materialized_view':
      return 'CREATE MATERIALIZED VIEW nueva_vista_materializada AS\nSELECT 1 AS columna\nWITH DATA;'
    case 'function':
      return [
        'CREATE OR REPLACE FUNCTION nueva_funcion(p_valor integer)',
        'RETURNS integer',
        'LANGUAGE plpgsql',
        'AS $$',
        'BEGIN',
        '  RETURN p_valor;',
        'END;',
        '$$;'
      ].join('\n')
    case 'procedure':
      return [
        'CREATE OR REPLACE PROCEDURE nuevo_procedimiento(p_id integer)',
        'LANGUAGE plpgsql',
        'AS $$',
        'BEGIN',
        "  RAISE NOTICE 'id: %', p_id;",
        'END;',
        '$$;'
      ].join('\n')
    case 'trigger':
      return [
        '-- La función del disparador debe existir (RETURNS trigger).',
        'CREATE TRIGGER nuevo_trigger',
        'BEFORE INSERT ON tabla',
        'FOR EACH ROW',
        'EXECUTE FUNCTION funcion_trigger();'
      ].join('\n')
  }
}

/** PostgreSQL DDL editor for the engine UI registry (`EngineUi.ddl`). */
export const pgDdlSupport = {
  template: pgDdlTemplate,
  buildScript: pgBuildDdlScript,
  parseObjectName: pgParseObjectName,
  isRename: pgIsRename
} satisfies DdlSupport
