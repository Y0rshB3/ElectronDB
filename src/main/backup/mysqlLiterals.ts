/**
 * Renders JavaScript values as MySQL literals for .nb3 data chunks.
 * Escaping follows mysql_real_escape_string: \0 \n \r \\ ' " \x1a.
 */

// \x1a (Ctrl-Z) must be escaped like mysql_real_escape_string does; matching it is the point.
// eslint-disable-next-line no-control-regex
const ESCAPE_RE = /[\0\n\r\\'"\x1a]/g
const ESCAPE_MAP: Record<string, string> = {
  '\0': '\\0',
  '\n': '\\n',
  '\r': '\\r',
  '\\': '\\\\',
  "'": "\\'",
  '"': '\\"',
  '\x1a': '\\Z'
}

const NUMERIC_TYPE_RE =
  /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|dec|numeric|fixed|float|double|real|year)\b/i
const BINARY_TYPE_RE =
  /^(binary|varbinary|tinyblob|blob|mediumblob|longblob|bit|geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection|geomcollection)\b/i
const NUMERIC_LITERAL_RE = /^-?(\d+)(\.\d+)?([eE][+-]?\d+)?$/
const HEX_LITERAL_RE = /^0x[0-9a-f]*$/i

/**
 * How values of a column are rendered:
 * - numeric: driver strings like BIGINT/DECIMAL text are written unquoted
 * - binary: Buffers and `0x…` strings are written as hex literals
 * - text: everything else; strings are always quoted
 */
export type LiteralKind = 'numeric' | 'binary' | 'text'

export function escapeString(value: string): string {
  return value.replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch])
}

export function quoteString(value: string): string {
  return `'${escapeString(value)}'`
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** Formats a Date in local time as MySQL DATETIME text (mysql2 parses with the local timezone by default). */
export function formatDate(date: Date): string {
  if (Number.isNaN(date.getTime())) return '0000-00-00 00:00:00'
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  const ms = date.getMilliseconds()
  return ms === 0 ? base : `${base}.${pad(ms, 3)}`
}

/** True for column types (as reported by information_schema COLUMN_TYPE) whose values can be written unquoted. */
export function isNumericColumnType(columnType: string): boolean {
  return NUMERIC_TYPE_RE.test(columnType.trim())
}

/** Classifies a column type (e.g. `bigint unsigned`, `varbinary(16)`, `json`). */
export function literalKindOf(columnType: string): LiteralKind {
  const t = columnType.trim()
  if (NUMERIC_TYPE_RE.test(t)) return 'numeric'
  if (BINARY_TYPE_RE.test(t)) return 'binary'
  return 'text'
}

const hex = (bytes: Uint8Array): string =>
  bytes.length === 0
    ? "''"
    : `0x${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex').toUpperCase()}`

/**
 * Formats a single value. Strings from text columns are always quoted to
 * preserve leading zeros, ENUM semantics, etc. Objects (JSON columns parsed by
 * the driver) are serialised and quoted.
 */
export function formatLiteral(value: unknown, kind: LiteralKind = 'text'): string {
  if (value === null || value === undefined) return 'NULL'
  switch (typeof value) {
    case 'number':
      return Number.isFinite(value) ? String(value) : 'NULL'
    case 'bigint':
      return value.toString()
    case 'boolean':
      return value ? '1' : '0'
    case 'string':
      if (kind === 'numeric' && NUMERIC_LITERAL_RE.test(value)) return value
      if (kind === 'binary' && HEX_LITERAL_RE.test(value)) return value.length === 2 ? "''" : value
      return quoteString(value)
    case 'object':
      if (value instanceof Uint8Array) return hex(value)
      if (value instanceof Date) return quoteString(formatDate(value))
      return quoteString(JSON.stringify(value))
    default:
      return quoteString(String(value))
  }
}

/** Renders one row as `(v1, v2, ...)`. */
export function renderTuple(values: readonly unknown[], kinds?: readonly LiteralKind[]): string {
  const parts = new Array<string>(values.length)
  for (let i = 0; i < values.length; i++) parts[i] = formatLiteral(values[i], kinds?.[i] ?? 'text')
  return `(${parts.join(', ')})`
}
