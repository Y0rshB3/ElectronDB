/**
 * PostgreSQL value fidelity (docs/multi-engine-design.md, section 2.2): only
 * bool, int2, int4, oid, float4 and float8 are parsed; every other type keeps
 * the server's text (dates never become JS Dates, no time-zone shift, json
 * keeps its formatting, int8/numeric keep every digit). bytea becomes 0xHEX.
 * Every session pins DateStyle/IntervalStyle/extra_float_digits/bytea_output
 * (client.ts), so the text form is stable.
 */
import type { CellValue, TypeKind } from '@shared/types'

export const OID = {
  bool: 16,
  bytea: 17,
  char: 18,
  name: 19,
  int8: 20,
  int2: 21,
  int4: 23,
  text: 25,
  oid: 26,
  json: 114,
  xml: 142,
  float4: 700,
  float8: 701,
  money: 790,
  bpchar: 1042,
  varchar: 1043,
  date: 1082,
  time: 1083,
  timestamp: 1114,
  timestamptz: 1184,
  interval: 1186,
  timetz: 1266,
  numeric: 1700,
  uuid: 2950,
  jsonb: 3802
} as const

const parseIntText = (v: string): number => Number.parseInt(v, 10)
const parseFloatText = (v: string): number | string => {
  const n = Number.parseFloat(v)
  // NaN / Infinity are not plain numbers in the grid or JSON: keep the server's text.
  return Number.isFinite(n) ? n : v
}

/** Raw bytea text (`\x0102ff`, bytea_output = hex) to the app's `0x0102FF`. */
export function byteaToHex(text: string): string {
  return text.startsWith('\\x') ? '0x' + text.slice(2).toUpperCase() : text
}

/**
 * pg `types` override for every client: parse only booleans and the small
 * numeric types, keep the text of everything else (OID 20 int8 stays text).
 */
export const pgTypes = {
  getTypeParser(oid: number, format?: string): (value: string) => unknown {
    if (format === 'binary') return (v: string) => v
    switch (oid) {
      case OID.bool:
        return (v: string) => v === 't' || v === 'true'
      case OID.int2:
      case OID.int4:
      case OID.oid:
        return parseIntText
      case OID.float4:
      case OID.float8:
        return parseFloatText
      case OID.bytea:
        return byteaToHex
      default:
        return (v: string) => v
    }
  }
}

/** Anything a driver row may hold, as a transport-safe CellValue. */
export function normalizeCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value
    case 'bigint':
      return value.toString()
    default:
      if (Buffer.isBuffer(value)) return '0x' + value.toString('hex').toUpperCase()
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
  }
}

/** pg_type facts used to classify a type. */
export interface PgTypeFacts {
  oid: number
  /** typname (e.g. 'int4', '_text', 'mood'). */
  name: string
  /** typcategory: B boolean, N numeric, S string, D datetime, U user, A array, E enum… */
  category: string
  /** typtype: b base, e enum, d domain, c composite, r range, p pseudo, m multirange. */
  type: string
}

const INTEGER_NAMES = new Set(['int2', 'int4', 'int8', 'oid', 'smallint', 'integer', 'bigint'])
const FLOAT_NAMES = new Set(['float4', 'float8', 'real', 'double precision'])
const DECIMAL_NAMES = new Set(['numeric', 'decimal', 'money'])

/** Engine-neutral family of a PostgreSQL type (domains are resolved to their base first). */
export function typeKindOf(t: Pick<PgTypeFacts, 'name' | 'category' | 'type'>): TypeKind {
  const name = t.name.toLowerCase()
  if (t.category === 'A' || name.startsWith('_') || name.endsWith('[]')) return 'array'
  if (t.type === 'e' || t.category === 'E') return 'enum'
  if (name === 'bool' || name === 'boolean') return 'boolean'
  if (INTEGER_NAMES.has(name)) return 'integer'
  if (FLOAT_NAMES.has(name)) return 'float'
  if (DECIMAL_NAMES.has(name)) return 'decimal'
  if (name === 'json' || name === 'jsonb') return 'json'
  if (name === 'uuid') return 'uuid'
  if (name === 'bytea') return 'binary'
  if (name === 'date') return 'date'
  if (name === 'time' || name === 'timetz' || name.startsWith('time ') || name === 'interval')
    return name === 'interval' ? 'text' : 'time'
  if (name.startsWith('timestamp')) return 'datetime'
  if (t.category === 'G' || name === 'geometry' || name === 'geography') return 'spatial'
  if (t.category === 'S') return 'text'
  if (t.category === 'N') return 'decimal'
  if (t.category === 'D') return 'datetime'
  return 'other'
}

/** Builtin OIDs, so a result needs no catalog lookup for the common types. */
export const BUILTIN_TYPES: Record<number, PgTypeFacts> = Object.fromEntries(
  (
    [
      [OID.bool, 'bool', 'B'],
      [OID.bytea, 'bytea', 'U'],
      [OID.char, 'char', 'Z'],
      [OID.name, 'name', 'S'],
      [OID.int8, 'int8', 'N'],
      [OID.int2, 'int2', 'N'],
      [OID.int4, 'int4', 'N'],
      [OID.text, 'text', 'S'],
      [OID.oid, 'oid', 'N'],
      [OID.json, 'json', 'U'],
      [OID.xml, 'xml', 'U'],
      [OID.float4, 'float4', 'N'],
      [OID.float8, 'float8', 'N'],
      [OID.money, 'money', 'N'],
      [OID.bpchar, 'bpchar', 'S'],
      [OID.varchar, 'varchar', 'S'],
      [OID.date, 'date', 'D'],
      [OID.time, 'time', 'D'],
      [OID.timestamp, 'timestamp', 'D'],
      [OID.timestamptz, 'timestamptz', 'D'],
      [OID.interval, 'interval', 'T'],
      [OID.timetz, 'timetz', 'D'],
      [OID.numeric, 'numeric', 'N'],
      [OID.uuid, 'uuid', 'U'],
      [OID.jsonb, 'jsonb', 'U']
    ] as const
  ).map(([oid, name, category]) => [oid, { oid, name, category, type: 'b' }])
)
