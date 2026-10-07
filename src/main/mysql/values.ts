import type { CellValue, QueryColumn } from '@shared/types'

/** Subset of mysql2 FieldPacket we rely on (kept structural so tests can fake it). */
export interface FieldMeta {
  name: string
  orgName?: string
  table?: string
  orgTable?: string
  db?: string
  schema?: string
  columnType?: number
  type?: number
  flags?: number | string[]
  charsetNr?: number
  characterSet?: number
  decimals?: number
  /** MariaDB extended metadata ('uuid', 'inet4', 'inet6', 'vector'...); MySQL never sends it. */
  extendedTypeName?: string
  /** MariaDB extended metadata: 'json' for JSON (stored as LONGTEXT). */
  extendedFormat?: string
}

/* mysql2 field flags (lib/constants/field_flags.js) */
export const FLAG_NOT_NULL = 1
export const FLAG_PRI_KEY = 2
export const FLAG_UNSIGNED = 32
export const FLAG_BINARY = 128
const BINARY_CHARSET = 63

/* mysql2 column type ids (lib/constants/types.js) → readable MySQL names */
const TYPE_NAMES: Record<number, string> = {
  0x00: 'DECIMAL',
  0x01: 'TINYINT',
  0x02: 'SMALLINT',
  0x03: 'INT',
  0x04: 'FLOAT',
  0x05: 'DOUBLE',
  0x06: 'NULL',
  0x07: 'TIMESTAMP',
  0x08: 'BIGINT',
  0x09: 'MEDIUMINT',
  0x0a: 'DATE',
  0x0b: 'TIME',
  0x0c: 'DATETIME',
  0x0d: 'YEAR',
  0x0e: 'DATE',
  0x0f: 'VARCHAR',
  0x10: 'BIT',
  0xf2: 'VECTOR',
  0xf5: 'JSON',
  0xf6: 'DECIMAL',
  0xf7: 'ENUM',
  0xf8: 'SET',
  0xf9: 'TINYTEXT',
  0xfa: 'MEDIUMTEXT',
  0xfb: 'LONGTEXT',
  0xfc: 'TEXT',
  0xfd: 'VARCHAR',
  0xfe: 'CHAR',
  0xff: 'GEOMETRY'
}

/* Text types whose binary counterpart has a different name. */
const BINARY_NAMES: Record<string, string> = {
  TINYTEXT: 'TINYBLOB',
  MEDIUMTEXT: 'MEDIUMBLOB',
  LONGTEXT: 'LONGBLOB',
  TEXT: 'BLOB',
  VARCHAR: 'VARBINARY',
  CHAR: 'BINARY'
}

const NUMERIC_TYPES = new Set([
  'TINYINT',
  'SMALLINT',
  'INT',
  'MEDIUMINT',
  'BIGINT',
  'FLOAT',
  'DOUBLE',
  'DECIMAL'
])

export function fieldFlags(field: FieldMeta): number {
  return typeof field.flags === 'number' ? field.flags : 0
}

function isBinaryField(field: FieldMeta): boolean {
  const charset = field.charsetNr ?? field.characterSet
  return charset === BINARY_CHARSET || (fieldFlags(field) & FLAG_BINARY) !== 0
}

/** Readable type name for a mysql2 field, e.g. "BIGINT UNSIGNED", "VARBINARY". */
export function columnTypeName(field: FieldMeta): string {
  const id = field.columnType ?? field.type
  let name = id === undefined ? 'UNKNOWN' : (TYPE_NAMES[id] ?? `TYPE_${id}`)
  if (isBinaryField(field) && name in BINARY_NAMES) name = BINARY_NAMES[name]
  if (NUMERIC_TYPES.has(name) && fieldFlags(field) & FLAG_UNSIGNED) name += ' UNSIGNED'
  return name
}

/**
 * Type label of a result column: MariaDB's extended metadata names the real
 * type (JSON arrives as LONGTEXT, UUID as CHAR); without it (every MySQL
 * server) the label is columnTypeName's, unchanged.
 */
export function extendedTypeLabel(field: FieldMeta): string {
  if (field.extendedFormat === 'json') return 'JSON'
  if (field.extendedTypeName) return field.extendedTypeName.toUpperCase()
  return columnTypeName(field)
}

/** Builds the shared QueryColumn descriptor for a result field. */
export function toQueryColumn(field: FieldMeta): QueryColumn {
  const column: QueryColumn = { name: field.name, type: extendedTypeLabel(field) }
  const table = field.orgTable || field.table
  const schema = field.db || field.schema
  if (table) column.table = table
  if (schema) column.schema = schema
  if (fieldFlags(field) & FLAG_PRI_KEY) column.primaryKey = true
  // Empty for expressions (CONCAT(...), COUNT(*)...): the renderer treats those as read-only.
  if (field.orgName) column.sourceName = field.orgName
  if (field.table) column.tableAlias = field.table
  return column
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Formats a Date as MySQL DATETIME text using local time. */
export function formatDateTime(d: Date): string {
  if (Number.isNaN(d.getTime())) return ''
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

/** Converts a raw mysql2 cell into the transport-safe CellValue. */
export function normalizeCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value
    case 'bigint':
      return value.toString()
    case 'object':
      if (Buffer.isBuffer(value)) return '0x' + value.toString('hex').toUpperCase()
      if (value instanceof Date) return formatDateTime(value)
      if (value instanceof Uint8Array)
        return '0x' + Buffer.from(value).toString('hex').toUpperCase()
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    default:
      return String(value)
  }
}

export function normalizeRow(row: unknown[]): CellValue[] {
  return row.map(normalizeCell)
}
