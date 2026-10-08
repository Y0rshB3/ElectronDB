/**
 * BSON ⇄ text for the MongoDB driver (docs/multi-engine-design.md, 2.2 and 9.2).
 *
 * Out: canonical EJSON (`relaxed: false`), so an Int64 above 2^53, a
 * Decimal128 or an Int32/Double distinction survives the trip to the renderer.
 * In: shell syntax parsed by @mongodb-js/shell-bson-parser in strict mode
 * (comments allowed, no calls except BSON constructors) or canonical EJSON.
 * Parse errors are shown to the user but never logged: their text can quote
 * what the user typed (a filter value).
 */
import { parse as parseShell } from '@mongodb-js/shell-bson-parser'
import { EJSON, type Document } from 'bson'
import {
  LARGE_VALUE_KEY,
  bsonTypeOf,
  type BsonType,
  type EjsonValue
} from '@shared/mongo/shellFormat'
import { MongoServerSideError } from './errors'

/** Documents above this many characters of canonical EJSON are sent with large fields left out. */
export const MAX_DOC_CHARS = 256 * 1024
/** A top-level field above this many characters is replaced by a placeholder in a large document. */
const LARGE_FIELD_CHARS = 4 * 1024

export function canonical(value: unknown): string {
  return EJSON.stringify(value as Document, { relaxed: false })
}

/** Canonical EJSON of a document for the grid: whole, or with its large fields left out. */
export function docToWire(doc: Document): { text: string; whole: boolean } {
  const text = canonical(doc)
  if (text.length <= MAX_DOC_CHARS) return { text, whole: true }
  const parsed = JSON.parse(text) as Record<string, EjsonValue>
  const out: Record<string, EjsonValue> = {}
  let size = 2
  for (const [key, value] of Object.entries(parsed)) {
    const part = JSON.stringify(value)
    const keep = key === '_id' || part.length <= LARGE_FIELD_CHARS
    const v: EjsonValue = keep
      ? value
      : { [LARGE_VALUE_KEY]: { type: bsonTypeOf(value), chars: part.length } }
    size += key.length + (keep ? part.length : 64)
    if (size > MAX_DOC_CHARS && key !== '_id') {
      out[key] = { [LARGE_VALUE_KEY]: { type: bsonTypeOf(value), chars: part.length } }
      continue
    }
    out[key] = v
  }
  return { text: JSON.stringify(out), whole: false }
}

/** Not logged: parse errors can echo the typed text. */
export class MongoInputError extends MongoServerSideError {
  constructor(message: string) {
    super(message, 'E_MONGO_INPUT', 'MongoInputError')
    this.name = 'MongoInputError'
  }
}

/** shell-bson-parser messages end with " in (<the input>)": drop the echo. */
function cleanParserMessage(message: string): string {
  return message.replace(/\s+in \([\s\S]*\)\s*$/, '').trim()
}

function looksLikeJson(text: string): boolean {
  if (!/^\s*[[{]/.test(text)) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * A value typed by the user: canonical/relaxed EJSON when the text is plain
 * JSON (so `{"$numberLong": "5"}` means an Int64), shell syntax otherwise.
 * `what` names the field in the Spanish error («Filtro», «Documento»…).
 */
export function parseUserValue(text: string, what: string): unknown {
  if (!text.trim()) throw new MongoInputError(`${what}: está vacío.`)
  if (looksLikeJson(text)) {
    try {
      return EJSON.parse(text, { relaxed: false })
    } catch (err) {
      throw new MongoInputError(
        `${what}: el Extended JSON no es válido (${cleanParserMessage(err instanceof Error ? err.message : String(err))}).`
      )
    }
  }
  let value: unknown
  try {
    value = parseShell(text, { mode: 'strict', allowComments: true })
  } catch (err) {
    throw new MongoInputError(
      `${what}: no se pudo interpretar (${cleanParserMessage(err instanceof Error ? err.message : String(err))}).`
    )
  }
  // shell-bson-parser answers '' for anything it refuses (calls, unknown identifiers…).
  if (value === '' && !/^\s*(['"])\1\s*$/.test(text))
    throw new MongoInputError(
      `${what}: no se pudo interpretar. Usa sintaxis del shell ({ campo: valor }) con literales y constructores como ObjectId('…'), ISODate('…') o NumberLong('…'); no se admiten llamadas a funciones.`
    )
  return value
}

/** A document (object) typed by the user. */
export function parseUserDocument(text: string, what: string): Document {
  const value = parseUserValue(text, what)
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new MongoInputError(`${what}: debe ser un documento ({ … }).`)
  return value as Document
}

/** An optional document: empty text (or `{}`) gives null. */
export function parseOptionalDocument(text: string | undefined, what: string): Document | null {
  if (!text || !text.trim()) return null
  const doc = parseUserDocument(text, what)
  return Object.keys(doc).length ? doc : null
}

/** An array of documents (aggregate pipeline). */
export function parseUserPipeline(text: string, what: string): Document[] {
  const value = parseUserValue(text, what)
  if (!Array.isArray(value))
    throw new MongoInputError(`${what}: debe ser un array de etapas ([ … ]).`)
  for (const stage of value)
    if (stage === null || typeof stage !== 'object' || Array.isArray(stage))
      throw new MongoInputError(`${what}: cada etapa debe ser un documento ({ $etapa: … }).`)
  return value as Document[]
}

/** Canonical EJSON produced by the renderer (typed cell values, `_id`s). */
export function parseCanonical(text: string, what: string): unknown {
  try {
    return EJSON.parse(text, { relaxed: false })
  } catch (err) {
    throw new MongoInputError(
      `${what}: valor no válido (${cleanParserMessage(err instanceof Error ? err.message : String(err))}).`
    )
  }
}

/** Parses `{"v": <canonical>}` so scalars of any type come back typed. */
export function parseCanonicalValue(text: string, what: string): unknown {
  const wrapped = parseCanonical(`{"v":${text}}`, what) as { v: unknown }
  return wrapped.v
}

/** BSON type name of a value as the driver returns it (RAW_BSON: nothing promoted). */
export function bsonTypeOfValue(v: unknown): BsonType {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'string') return 'string'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double'
  if (typeof v === 'bigint') return 'long'
  if (Array.isArray(v)) return 'array'
  if (v instanceof Date) return 'date'
  if (v instanceof RegExp) return 'regex'
  const tag = (v as { _bsontype?: string })._bsontype
  switch (tag) {
    case 'ObjectId':
      return 'objectId'
    case 'Int32':
      return 'int'
    case 'Double':
      return 'double'
    case 'Long':
      return 'long'
    case 'Decimal128':
      return 'decimal'
    case 'Binary':
      return 'binData'
    case 'Timestamp':
      return 'timestamp'
    case 'BSONRegExp':
      return 'regex'
    case 'MinKey':
      return 'minKey'
    case 'MaxKey':
      return 'maxKey'
    case 'Code':
      return 'javascript'
    case 'BSONSymbol':
      return 'symbol'
    default:
      return 'object'
  }
}

/** Plain JS number of a numeric BSON value (Int32, Double, Long…) or a number; NaN otherwise. */
export function numberOf(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (!v || typeof v !== 'object') return Number.NaN
  const tag = (v as { _bsontype?: string })._bsontype
  if (tag === 'Long') return (v as { toNumber(): number }).toNumber()
  if (tag === 'Decimal128') return Number(String(v))
  if (tag === 'Int32' || tag === 'Double') return Number((v as { valueOf(): unknown }).valueOf())
  return Number.NaN
}
