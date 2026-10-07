import { quoteString } from '../mysqlLiterals'
import { binOf, tagOf, type ValueCodec, type VqbValue } from './values'

/**
 * MySQL/MariaDB side of the .vqb values (docs/vqb-format.md, "MySQL and
 * MariaDB"). The pool reads integers up to INT as numbers, BIGINT/DECIMAL and
 * every date/time type as text, JSON as text and binary types (BLOB, BIT,
 * GEOMETRY…) as Buffers.
 */

const INT_RE = /^(tinyint|smallint|mediumint|int|integer|bigint|year)\b/i
const DECIMAL_RE = /^(decimal|dec|numeric|fixed)\b/i
const FLOAT_RE = /^(float|double|real)\b/i
const DATETIME_RE = /^(date|datetime|timestamp|time)\b/i
const BINARY_RE =
  /^(binary|varbinary|tinyblob|blob|mediumblob|longblob|bit|geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection|geomcollection)\b/i
const JSON_RE = /^json\b/i

/** How the writer reads values of a column, from information_schema COLUMN_TYPE. */
export function mysqlCodecOf(columnType: string): ValueCodec {
  const t = columnType.trim()
  if (INT_RE.test(t)) return 'int'
  if (DECIMAL_RE.test(t)) return 'decimal'
  if (FLOAT_RE.test(t)) return 'float'
  if (DATETIME_RE.test(t)) return 'datetime'
  if (BINARY_RE.test(t)) return 'binary'
  if (JSON_RE.test(t)) return 'json'
  return 'text'
}

/**
 * MySQL literal of a checked .vqb value. Numbers and $bigint/$dec are written
 * unquoted (their text was validated by checkValue), bytes as hex, everything
 * else as an escaped string.
 */
export function mysqlLiteral(value: VqbValue): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return quoteString(value)
  const v = value as Record<string, unknown>
  switch (tagOf(value)) {
    case '$bigint':
    case '$dec': {
      const text = String(v[tagOf(value)!])
      // NaN/Infinity (a PostgreSQL numeric) has no MySQL literal: the server refuses the string.
      return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text) ? text : quoteString(text)
    }
    case '$bin': {
      const bytes = binOf(value as { $bin: string })
      return bytes.length === 0 ? "''" : `0x${bytes.toString('hex').toUpperCase()}`
    }
    case '$dt':
    case '$json':
    case '$float':
      return quoteString(String(v[tagOf(value)!]))
    case '$arr':
      return quoteString(JSON.stringify(v.$arr))
    default:
      return 'NULL'
  }
}

/** `(v1, v2, …)` of one row. */
export const mysqlTuple = (row: readonly VqbValue[]): string =>
  `(${row.map((v) => mysqlLiteral(v)).join(', ')})`
