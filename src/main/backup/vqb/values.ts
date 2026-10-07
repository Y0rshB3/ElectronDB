/**
 * Typed values of .vqb data files (docs/vqb-format.md, "Values").
 *
 * One row is one JSON array. A value is JSON null, true/false, a number (only
 * when it is exact: integers within ±(2^53−1) and finite floats), a string,
 * or a tagged object that keeps what JSON cannot:
 *
 *   {"$bigint":"-9007199254740993"}   integer outside the safe range
 *   {"$dec":"123.4500"}               exact decimal text (also NaN/Infinity of numeric)
 *   {"$float":"NaN"}                  non-finite float (NaN, Infinity, -Infinity)
 *   {"$bin":"AAEC/w=="}               bytes, base64
 *   {"$dt":"2026-10-07 10:00:00.123"} date/time as the server wrote it (no time-zone shift)
 *   {"$json":"{\"a\": 1}"}            JSON document as text (big numbers and key order kept)
 *   {"$arr":["1",null,["a"]]}         PostgreSQL array: element text or null, nested per dimension
 *   {"$arr":[…],"$lb":"[0:2]"}        …with the array's non-default bounds
 */

export type VqbArray = (string | null | VqbArray)[]

export type VqbValue =
  | null
  | boolean
  | number
  | string
  | { $bigint: string }
  | { $dec: string }
  | { $float: string }
  | { $bin: string }
  | { $dt: string }
  | { $json: string }
  | { $arr: VqbArray; $lb?: string }

/** How the writer reads a column's driver values. */
export type ValueCodec =
  'int' | 'decimal' | 'float' | 'datetime' | 'binary' | 'json' | 'array' | 'bool' | 'text'

const INT_RE = /^[+-]?\d+$/
const NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
const NON_FINITE_RE = /^[+-]?(nan|inf|infinity)$/i
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/** Integer text → number when exact, $bigint otherwise. */
const intValue = (text: string): VqbValue => {
  const big = BigInt(text)
  return big <= MAX_SAFE && big >= -MAX_SAFE ? Number(big) : { $bigint: big.toString() }
}

/** Driver text '0x0102FF' (PostgreSQL bytea in Vortaq) or '\x0102ff' → bytes. */
function hexToBytes(text: string): Buffer | null {
  const m = /^(?:0x|\\x)([0-9a-fA-F]*)$/.exec(text)
  return m && m[1].length % 2 === 0 ? Buffer.from(m[1], 'hex') : null
}

/** Encodes one driver value of a column whose codec is `codec`. */
export function encodeValue(raw: unknown, codec: ValueCodec): VqbValue {
  if (raw === null || raw === undefined) return null
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array)
    return { $bin: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('base64') }
  switch (typeof raw) {
    case 'boolean':
      return raw
    case 'bigint':
      return intValue(raw.toString())
    case 'number':
      if (!Number.isFinite(raw)) return { $float: String(raw) }
      if (codec === 'decimal') return { $dec: String(raw) }
      if (codec === 'int' && !Number.isSafeInteger(raw)) return { $bigint: BigInt(raw).toString() }
      return raw
    case 'string':
      return encodeText(raw, codec)
    case 'object':
      if (raw instanceof Date) return { $dt: raw.toISOString() }
      return { $json: JSON.stringify(raw) }
    default:
      return String(raw)
  }
}

function encodeText(text: string, codec: ValueCodec): VqbValue {
  switch (codec) {
    case 'int':
      return INT_RE.test(text) ? intValue(text) : text
    case 'decimal':
      return { $dec: text }
    case 'float': {
      if (NON_FINITE_RE.test(text)) return { $float: text }
      const n = Number(text)
      return NUMERIC_RE.test(text) && Number.isFinite(n) ? n : text
    }
    case 'datetime':
      return { $dt: text }
    case 'json':
      return { $json: text }
    case 'binary': {
      const bytes = hexToBytes(text)
      return bytes ? { $bin: bytes.toString('base64') } : text
    }
    case 'array': {
      const parsed = parsePgArray(text)
      return parsed.bounds ? { $arr: parsed.value, $lb: parsed.bounds } : { $arr: parsed.value }
    }
    case 'bool':
      return text === 't' || text === 'true'
        ? true
        : text === 'f' || text === 'false'
          ? false
          : text
    default:
      return text
  }
}

/** Tag of a value (`null` for plain JSON values). */
export function tagOf(value: VqbValue): string | null {
  if (value === null || typeof value !== 'object') return null
  const keys = Object.keys(value).filter((k) => k !== '$lb')
  return keys.length === 1 && keys[0].startsWith('$') ? keys[0] : null
}

export class VqbValueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VqbValueError'
  }
}

/** Throws unless `value` is a well-formed .vqb value (used by the reader on every row). */
export function checkValue(value: unknown): VqbValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new VqbValueError('número no finito')
    return value
  }
  if (typeof value !== 'object' || Array.isArray(value))
    throw new VqbValueError('valor con un tipo desconocido')
  const v = value as Record<string, unknown>
  const tag = tagOf(v as VqbValue)
  if (!tag) throw new VqbValueError('objeto sin etiqueta de tipo')
  const payload = v[tag]
  switch (tag) {
    case '$bigint':
      if (typeof payload !== 'string' || !INT_RE.test(payload))
        throw new VqbValueError('$bigint no válido')
      break
    case '$dec':
      if (typeof payload !== 'string' || !(NUMERIC_RE.test(payload) || NON_FINITE_RE.test(payload)))
        throw new VqbValueError('$dec no válido')
      break
    case '$float':
      if (typeof payload !== 'string' || !(NON_FINITE_RE.test(payload) || NUMERIC_RE.test(payload)))
        throw new VqbValueError('$float no válido')
      break
    case '$bin':
      if (typeof payload !== 'string' || !BASE64_RE.test(payload) || payload.length % 4 !== 0)
        throw new VqbValueError('$bin no válido')
      break
    case '$dt':
    case '$json':
      if (typeof payload !== 'string') throw new VqbValueError(`${tag} no válido`)
      break
    case '$arr':
      checkArray(payload)
      if (v.$lb !== undefined && (typeof v.$lb !== 'string' || !/^(\[-?\d+:-?\d+\])+$/.test(v.$lb)))
        throw new VqbValueError('$lb no válido')
      break
    default:
      throw new VqbValueError(`etiqueta desconocida ${tag}`)
  }
  return value as VqbValue
}

function checkArray(value: unknown): void {
  if (!Array.isArray(value)) throw new VqbValueError('$arr no válido')
  for (const e of value)
    if (Array.isArray(e)) checkArray(e)
    else if (e !== null && typeof e !== 'string') throw new VqbValueError('$arr no válido')
}

/* ---------- PostgreSQL array literals ---------- */

/**
 * Parses PostgreSQL array output ('{1,NULL,"a b",{x}}', optionally preceded by
 * bounds like '[0:2]='). Elements stay as their text; unquoted NULL is null.
 */
export function parsePgArray(
  text: string,
  delimiter = ','
): { value: VqbArray; bounds: string | null } {
  let pos = 0
  let bounds: string | null = null
  if (text.startsWith('[')) {
    const eq = text.indexOf('=')
    if (eq < 0) throw new VqbValueError('array de PostgreSQL no válido')
    bounds = text.slice(0, eq)
    pos = eq + 1
  }
  const fail = (): never => {
    throw new VqbValueError('array de PostgreSQL no válido')
  }
  const parseLevel = (): VqbArray => {
    if (text[pos] !== '{') fail()
    pos++
    const out: VqbArray = []
    if (text[pos] === '}') {
      pos++
      return out
    }
    for (;;) {
      while (text[pos] === ' ') pos++
      if (text[pos] === '{') out.push(parseLevel())
      else if (text[pos] === '"') {
        pos++
        let s = ''
        while (pos < text.length && text[pos] !== '"') {
          if (text[pos] === '\\') pos++
          s += text[pos++] ?? ''
        }
        if (text[pos] !== '"') fail()
        pos++
        out.push(s)
      } else {
        let s = ''
        while (pos < text.length && text[pos] !== delimiter && text[pos] !== '}') {
          if (text[pos] === '\\') pos++
          s += text[pos++] ?? ''
        }
        const trimmed = s.trim()
        out.push(trimmed.toUpperCase() === 'NULL' ? null : trimmed)
      }
      while (text[pos] === ' ') pos++
      if (text[pos] === delimiter) {
        pos++
        continue
      }
      if (text[pos] === '}') {
        pos++
        return out
      }
      fail()
    }
  }
  const value = parseLevel()
  if (pos !== text.length) fail()
  return { value, bounds }
}

/** Array input text PostgreSQL accepts for `value` (every element double-quoted). */
export function formatPgArray(value: VqbArray, bounds?: string | null, delimiter = ','): string {
  const level = (items: VqbArray): string =>
    '{' +
    items
      .map((e) =>
        e === null
          ? 'NULL'
          : Array.isArray(e)
            ? level(e)
            : `"${e.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      )
      .join(delimiter) +
    '}'
  return (bounds ? `${bounds}=` : '') + level(value)
}

/* ---------- decoding for restores ---------- */

/** Bytes of a $bin value. */
export const binOf = (value: { $bin: string }): Buffer => Buffer.from(value.$bin, 'base64')

/**
 * Text PostgreSQL accepts for a value of the column (sent as a text parameter
 * and cast to the column type); null for SQL NULL.
 */
export function pgParam(value: VqbValue, delimiter = ','): string | null {
  if (value === null) return null
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  const tag = tagOf(value)
  const v = value as Record<string, unknown>
  switch (tag) {
    case '$bin':
      return '\\x' + binOf(value as { $bin: string }).toString('hex')
    case '$arr':
      return formatPgArray(v.$arr as VqbArray, (v.$lb as string | undefined) ?? null, delimiter)
    case '$bigint':
    case '$dec':
    case '$float':
    case '$dt':
    case '$json':
      return String(v[tag])
    default:
      throw new VqbValueError(`etiqueta desconocida ${String(tag)}`)
  }
}
