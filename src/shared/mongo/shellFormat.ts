/**
 * Canonical Extended JSON → shell syntax (docs/multi-engine-design.md, 9.1).
 *
 * Documents reach the renderer as canonical EJSON text (`EJSON.stringify(doc,
 * { relaxed: false })`); `JSON.parse` of that text gives plain values in which
 * every BSON type is a wrapper object ({ $oid }, { $numberLong }, …). This
 * module turns them into the shell text the editors show and that main parses
 * back with @mongodb-js/shell-bson-parser, so the round trip keeps each type:
 * Int32 prints as `5`, a Double with an integral value as `Double(5)` (a bare
 * `5` would come back as Int32), an Int64 as `NumberLong('…')` (never a JS
 * number). Pure: no bson, Node or DOM imports.
 */

export type EjsonValue = null | boolean | number | string | EjsonValue[] | EjsonObject
export interface EjsonObject {
  [key: string]: EjsonValue
}

/** BSON type names, as `$type` and the shell call them. */
export type BsonType =
  | 'double'
  | 'string'
  | 'object'
  | 'array'
  | 'binData'
  | 'undefined'
  | 'objectId'
  | 'bool'
  | 'date'
  | 'null'
  | 'regex'
  | 'dbPointer'
  | 'javascript'
  | 'symbol'
  | 'int'
  | 'timestamp'
  | 'long'
  | 'decimal'
  | 'minKey'
  | 'maxKey'

export const BSON_TYPE_LABELS: Record<BsonType, string> = {
  double: 'Double',
  string: 'String',
  object: 'Objeto',
  array: 'Array',
  binData: 'Binario',
  undefined: 'Undefined',
  objectId: 'ObjectId',
  bool: 'Boolean',
  date: 'Fecha',
  null: 'Null',
  regex: 'RegExp',
  dbPointer: 'DBPointer',
  javascript: 'Código',
  symbol: 'Símbolo',
  int: 'Int32',
  timestamp: 'Timestamp',
  long: 'Int64',
  decimal: 'Decimal128',
  minKey: 'MinKey',
  maxKey: 'MaxKey'
}

/**
 * Placeholder main sends instead of a field too large to ship with its
 * document (`{ $vortaqLarge: { type, chars } }`); such documents are not whole.
 */
export const LARGE_VALUE_KEY = '$vortaqLarge'

/** The placeholder of a left-out large value, or null. */
export function largeValue(v: EjsonValue | undefined): { type: string; chars: number } | null {
  if (!isObject(v) || !onlyKeys(v, LARGE_VALUE_KEY)) return null
  const inner = v[LARGE_VALUE_KEY]
  if (!isObject(inner)) return null
  return { type: String(inner.type ?? 'object'), chars: Number(inner.chars ?? 0) }
}

function isObject(v: EjsonValue | undefined): v is EjsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function onlyKeys(v: EjsonObject, ...keys: string[]): boolean {
  const own = Object.keys(v)
  return own.length === keys.length && keys.every((k) => own.includes(k))
}

/** BSON type of a canonical EJSON value. */
export function bsonTypeOf(v: EjsonValue): BsonType {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'string') return 'string'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double'
  if (Array.isArray(v)) return 'array'
  if (onlyKeys(v, '$oid')) return 'objectId'
  if (onlyKeys(v, '$date')) return 'date'
  if (onlyKeys(v, '$numberInt')) return 'int'
  if (onlyKeys(v, '$numberLong')) return 'long'
  if (onlyKeys(v, '$numberDouble')) return 'double'
  if (onlyKeys(v, '$numberDecimal')) return 'decimal'
  if (onlyKeys(v, '$binary')) return 'binData'
  if (onlyKeys(v, '$timestamp')) return 'timestamp'
  if (onlyKeys(v, '$regularExpression')) return 'regex'
  if (onlyKeys(v, '$minKey')) return 'minKey'
  if (onlyKeys(v, '$maxKey')) return 'maxKey'
  if (onlyKeys(v, '$code') || onlyKeys(v, '$code', '$scope')) return 'javascript'
  if (onlyKeys(v, '$symbol')) return 'symbol'
  if (onlyKeys(v, '$undefined')) return 'undefined'
  if (onlyKeys(v, '$dbPointer')) return 'dbPointer'
  return 'object'
}

/** True for values shown as a nested document or array (not a scalar). */
export function isContainer(v: EjsonValue): boolean {
  const t = bsonTypeOf(v)
  return t === 'object' || t === 'array'
}

/* ---------- strings and keys ---------- */

/** Single-quoted JS string literal that parses back to exactly `s`. */
export function quote(s: string): string {
  let out = "'"
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    const code = s.charCodeAt(i)
    if (ch === '\\') out += '\\\\'
    else if (ch === "'") out += "\\'"
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029)
      out += `\\u${code.toString(16).padStart(4, '0')}`
    else if (code >= 0xd800 && code <= 0xdfff) {
      // Keep surrogate pairs; escape lone surrogates so the text stays valid.
      const next = s.charCodeAt(i + 1)
      if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        out += ch + s[i + 1]
        i++
      } else out += `\\u${code.toString(16).padStart(4, '0')}`
    } else out += ch
  }
  return out + "'"
}

const BARE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/

export function formatKey(key: string): string {
  return BARE_KEY.test(key) ? key : quote(key)
}

/* ---------- scalars ---------- */

const MAX_ISO_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999)
/** 0000-01-01T00:00:00.000Z (Date.UTC maps years 0–99 to 1900–1999). */
const MIN_ISO_MS = -62167219200000

/** Milliseconds of a canonical `$date`, or null when not a number. */
export function dateMillis(v: EjsonObject): number | null {
  const d = v.$date
  if (typeof d === 'number') return d
  if (typeof d === 'string') {
    const ms = Date.parse(d)
    return Number.isNaN(ms) ? null : ms
  }
  if (isObject(d) && typeof d.$numberLong === 'string') {
    const ms = Number(d.$numberLong)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

/** True when `ms` has a four-digit year (0–9999), the range ISODate('…') can write. */
export function isoRange(ms: number): boolean {
  return Number.isFinite(ms) && ms >= MIN_ISO_MS && ms <= MAX_ISO_MS
}

/** ISO text of a date (UTC, with Z), or null outside years 0–9999. */
export function isoDate(ms: number): string | null {
  if (!isoRange(ms)) return null
  return new Date(ms).toISOString()
}

/** Local-time text of a date for tooltips and the «Hora local» toggle. */
export function localDate(ms: number): string {
  if (!isoRange(ms)) return `new Date(${ms})`
  const d = new Date(ms)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return (
    `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)} ` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  )
}

function bytesOf(base64: string): Uint8Array {
  const bin = atob(base64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** `xxxxxxxx-xxxx-…` of a 16-byte binary, or null. */
export function uuidText(base64: string): string | null {
  let bytes: Uint8Array
  try {
    bytes = bytesOf(base64)
  } catch {
    return null
  }
  if (bytes.length !== 16) return null
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Creation time embedded in an ObjectId (its first 4 bytes), or null. */
export function objectIdTime(hex: string): number | null {
  if (!/^[0-9a-fA-F]{24}$/.test(hex)) return null
  return parseInt(hex.slice(0, 8), 16) * 1000
}

function doubleText(raw: string): string {
  if (raw === 'NaN' || raw === 'Infinity' || raw === '-Infinity') return raw
  const n = Number(raw)
  if (Number.isNaN(n)) return `Double(${quote(raw)})`
  if (Object.is(n, -0)) return 'Double(-0)'
  // An integral value would come back as Int32/Int64: keep it a Double explicitly.
  if (Number.isInteger(n)) return `Double(${String(n)})`
  return String(n)
}

export interface FormatOptions {
  /** Indentation per level; 0 = one line. */
  indent?: number
  /** Dates in local time (display only: the text does not parse back). */
  localTime?: boolean
}

/**
 * Shell text of a canonical EJSON value. With `localTime` the dates are shown
 * as local time for reading only; every other output parses back to the same
 * BSON value.
 */
export function shellText(v: EjsonValue, options: FormatOptions = {}): string {
  return format(v, options.indent ?? 0, 0, options.localTime ?? false)
}

function scalarText(v: EjsonValue, localTime: boolean): string | null {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'string') return quote(v)
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return null
  switch (bsonTypeOf(v)) {
    case 'objectId':
      return `ObjectId(${quote(String(v.$oid))})`
    case 'date': {
      const ms = dateMillis(v)
      if (ms === null) return `ISODate(${quote(JSON.stringify(v.$date))})`
      if (localTime) return `ISODate(${quote(localDate(ms))})`
      const iso = isoDate(ms)
      return iso ? `ISODate(${quote(iso)})` : `new Date(${ms})`
    }
    case 'int':
      return String(v.$numberInt)
    case 'long':
      return `NumberLong(${quote(String(v.$numberLong))})`
    case 'double':
      return doubleText(String(v.$numberDouble))
    case 'decimal':
      return `NumberDecimal(${quote(String(v.$numberDecimal))})`
    case 'binData': {
      const b = v.$binary as EjsonObject
      const base64 = String(b?.base64 ?? '')
      const sub = String(b?.subType ?? '00')
      if (sub === '04') {
        const uuid = uuidText(base64)
        if (uuid) return `UUID(${quote(uuid)})`
      }
      return `BinData(${parseInt(sub, 16) || 0}, ${quote(base64)})`
    }
    case 'timestamp': {
      const t = v.$timestamp as EjsonObject
      return `Timestamp({ t: ${Number(t?.t ?? 0)}, i: ${Number(t?.i ?? 0)} })`
    }
    case 'regex': {
      const r = v.$regularExpression as EjsonObject
      return `RegExp(${quote(String(r?.pattern ?? ''))}, ${quote(String(r?.options ?? ''))})`
    }
    case 'minKey':
      return 'MinKey()'
    case 'maxKey':
      return 'MaxKey()'
    case 'javascript':
      return v.$scope !== undefined
        ? `Code(${quote(String(v.$code))}, ${format(v.$scope, 0, 0, localTime)})`
        : `Code(${quote(String(v.$code))})`
    case 'symbol':
      return quote(String(v.$symbol))
    case 'undefined':
      return 'undefined'
    default:
      return null
  }
}

function format(v: EjsonValue, indent: number, depth: number, localTime: boolean): string {
  const scalar = scalarText(v, localTime)
  if (scalar !== null) return scalar
  const pad = (d: number): string => (indent ? ' '.repeat(indent * d) : '')
  const nl = indent ? '\n' : ' '
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    const items = v.map((x) => pad(depth + 1) + format(x, indent, depth + 1, localTime))
    return indent ? `[\n${items.join(',\n')}\n${pad(depth)}]` : `[${items.join(', ')}]`
  }
  const obj = v as EjsonObject
  const keys = Object.keys(obj)
  if (keys.length === 0) return '{}'
  const items = keys.map(
    (k) => `${pad(depth + 1)}${formatKey(k)}: ${format(obj[k], indent, depth + 1, localTime)}`
  )
  return indent ? `{\n${items.join(',\n')}\n${pad(depth)}}` : `{${nl}${items.join(', ')}${nl}}`
}

/* ---------- grid cells ---------- */

/**
 * Short text of a cell: plain strings without quotes, `{…} 3 campos`,
 * `[…] 5`, and the shell form of every other type.
 */
export function cellPreview(v: EjsonValue | undefined, options: FormatOptions = {}): string {
  if (v === undefined) return ''
  if (typeof v === 'string') return v.length > 200 ? `${v.slice(0, 200)}…` : v
  const large = largeValue(v)
  if (large) return `(valor grande: ${Math.max(1, Math.round(large.chars / 1024))} KB)`
  if (Array.isArray(v)) return `[…] ${v.length}`
  const type = bsonTypeOf(v)
  if (type === 'object') {
    const n = Object.keys(v as EjsonObject).length
    return `{…} ${n} ${n === 1 ? 'campo' : 'campos'}`
  }
  if (type === 'binData') {
    const b = (v as EjsonObject).$binary as EjsonObject
    const sub = String(b?.subType ?? '00')
    if (sub === '04') {
      const uuid = uuidText(String(b?.base64 ?? ''))
      if (uuid) return `UUID('${uuid}')`
    }
    const size = Math.floor((String(b?.base64 ?? '').length * 3) / 4)
    return `BinData(${parseInt(sub, 16) || 0}) ${size} B`
  }
  return shellText(v, { localTime: options.localTime })
}

/* ---------- typed values (inline editors) ---------- */

/** Types the inline cell editor offers (section 9.1). */
export const EDITABLE_TYPES = [
  'string',
  'int',
  'long',
  'double',
  'decimal',
  'bool',
  'date',
  'objectId',
  'null'
] as const satisfies readonly BsonType[]
export type EditableType = (typeof EDITABLE_TYPES)[number]

export function isEditableType(t: BsonType): t is EditableType {
  return (EDITABLE_TYPES as readonly string[]).includes(t)
}

/** Plain text of a scalar for the cell editor (no quotes, no constructor). */
export function plainValue(v: EjsonValue): string {
  switch (bsonTypeOf(v)) {
    case 'null':
      return ''
    case 'bool':
      return v ? 'true' : 'false'
    case 'string':
      return v as string
    case 'int':
      return typeof v === 'number' ? String(v) : String((v as EjsonObject).$numberInt)
    case 'long':
      return String((v as EjsonObject).$numberLong)
    case 'double':
      return typeof v === 'number' ? String(v) : String((v as EjsonObject).$numberDouble)
    case 'decimal':
      return String((v as EjsonObject).$numberDecimal)
    case 'objectId':
      return String((v as EjsonObject).$oid)
    case 'date': {
      const ms = dateMillis(v as EjsonObject)
      return ms === null ? '' : (isoDate(ms) ?? String(ms))
    }
    default:
      return shellText(v)
  }
}

const INT32 = /^[+-]?\d+$/
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

/**
 * Canonical EJSON of a value typed in the cell editor, or `{ error }` with a
 * Spanish message. Typing `5` into an Int32 cell stays Int32; main parses the
 * result with EJSON (relaxed:false) and checks it again.
 */
export function typedValue(
  type: EditableType,
  text: string
): { value: EjsonValue } | { error: string } {
  const t = text.trim()
  switch (type) {
    case 'null':
      return { value: null }
    case 'string':
      return { value: text }
    case 'bool':
      if (/^(true|1|sí|si)$/i.test(t)) return { value: true }
      if (/^(false|0|no)$/i.test(t)) return { value: false }
      return { error: 'Escribe true o false.' }
    case 'int': {
      if (!INT32.test(t)) return { error: 'Int32: escribe un número entero.' }
      const n = Number(t)
      if (n < -2147483648 || n > 2147483647)
        return { error: 'Int32: el valor está fuera de rango (usa Int64).' }
      return { value: { $numberInt: String(n) } }
    }
    case 'long': {
      if (!INT32.test(t)) return { error: 'Int64: escribe un número entero.' }
      const big = BigInt(t)
      if (big < -(2n ** 63n) || big > 2n ** 63n - 1n)
        return { error: 'Int64: el valor está fuera de rango.' }
      return { value: { $numberLong: big.toString() } }
    }
    case 'double': {
      if (/^[+-]?(NaN|Infinity)$/.test(t))
        return { value: { $numberDouble: t.replace(/^\+/, '').replace('-NaN', 'NaN') } }
      if (!DECIMAL.test(t)) return { error: 'Double: escribe un número.' }
      const n = Number(t)
      if (!Number.isFinite(n)) return { error: 'Double: el valor está fuera de rango.' }
      return {
        value: {
          $numberDouble: Object.is(n, -0) ? '-0.0' : Number.isInteger(n) ? `${n}.0` : String(n)
        }
      }
    }
    case 'decimal':
      if (!DECIMAL.test(t) && !/^[+-]?(NaN|Infinity|Inf)$/i.test(t))
        return { error: 'Decimal128: escribe un número decimal.' }
      return { value: { $numberDecimal: t } }
    case 'objectId':
      if (!/^[0-9a-fA-F]{24}$/.test(t))
        return { error: 'ObjectId: escribe 24 caracteres hexadecimales.' }
      return { value: { $oid: t.toLowerCase() } }
    case 'date': {
      const ms = /^[+-]?\d+$/.test(t) ? Number(t) : Date.parse(t)
      if (!Number.isFinite(ms))
        return { error: 'Fecha: usa el formato ISO, p. ej. 2026-10-07T12:30:00Z.' }
      return { value: { $date: { $numberLong: String(Math.trunc(ms)) } } }
    }
  }
}

/* ---------- paths ---------- */

/** A field name that cannot be addressed with a dotted path ($set/$unset). */
export function isUnaddressableKey(key: string): boolean {
  return key.includes('.') || key.startsWith('$') || key === ''
}

/** Value at a path of segments (array indexes as numbers), or undefined. */
export function valueAt(doc: EjsonValue, path: (string | number)[]): EjsonValue | undefined {
  let cur: EjsonValue | undefined = doc
  for (const seg of path) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = Array.isArray(cur)
      ? typeof seg === 'number'
        ? cur[seg]
        : undefined
      : (cur as EjsonObject)[String(seg)]
  }
  return cur
}

/** Canonical EJSON text of a parsed value (key order kept). */
export function ejsonText(v: EjsonValue): string {
  return JSON.stringify(v)
}

/** Parses canonical EJSON text (as produced by main); throws on invalid JSON. */
export function parseEjson(text: string): EjsonValue {
  return JSON.parse(text) as EjsonValue
}
