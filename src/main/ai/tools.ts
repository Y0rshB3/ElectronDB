/**
 * The assistant's only tool: read-only, structure-only lookup of tables that
 * the context lists by name only. Shared by both adapters.
 */

export const TOOL_NAME = 'get_table_structure'
export const TOOL_DESCRIPTION =
  'Returns the structure (columns with types, keys, indexes, foreign keys, row-count estimate) of up to 30 tables or views of a database on the current connection. Never returns row data. Use it when the context lists a table by name only.'
export const MAX_TOOL_TABLES = 30
/** Model <-> tool rounds per answer. */
export const MAX_TOOL_ROUNDS = 4

export const TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    schema: { type: 'string', description: 'Database (schema) name.' },
    tables: {
      type: 'array',
      items: { type: 'string' },
      description: 'Table or view names (exact).'
    }
  },
  required: ['schema', 'tables'],
  additionalProperties: false
}

export interface TableStructureInput {
  schema: string
  tables: string[]
}

export type ToolExecutor = (input: TableStructureInput) => Promise<string>

/** Validates a tool input against TOOL_INPUT_SCHEMA. Returns the input or an error message. */
export function validateToolInput(
  raw: unknown
): { ok: true; value: TableStructureInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, error: 'input must be an object with "schema" and "tables"' }
  const obj = raw as Record<string, unknown>
  const extra = Object.keys(obj).filter((k) => k !== 'schema' && k !== 'tables')
  if (extra.length) return { ok: false, error: `unexpected properties: ${extra.join(', ')}` }
  if (typeof obj.schema !== 'string' || !obj.schema.trim() || obj.schema.length > 64)
    return { ok: false, error: '"schema" must be a non-empty string (max 64 characters)' }
  if (!Array.isArray(obj.tables) || obj.tables.length === 0)
    return { ok: false, error: '"tables" must be a non-empty array of table names' }
  if (obj.tables.length > MAX_TOOL_TABLES)
    return { ok: false, error: `ask for at most ${MAX_TOOL_TABLES} tables per call` }
  if (!obj.tables.every((t) => typeof t === 'string' && t.trim() && t.length <= 64))
    return { ok: false, error: '"tables" items must be non-empty strings (max 64 characters)' }
  return {
    ok: true,
    value: {
      schema: obj.schema.trim(),
      tables: [...new Set((obj.tables as string[]).map((t) => t.trim()))]
    }
  }
}

/** Parses the JSON arguments of an OpenAI-style tool call. */
export function parseToolArguments(text: string): unknown {
  try {
    return JSON.parse(text || '{}')
  } catch {
    return null
  }
}
