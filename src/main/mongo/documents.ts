/**
 * Collection browser reads (docs/multi-engine-design.md, 9.1): pages of
 * documents as canonical EJSON, «Cargar más» through open cursors, field
 * statistics, and field-shape sampling (names and BSON types only, never
 * values: the AI assistant reads it too).
 */
import type { AbstractCursor, Document } from 'mongodb'
import type { MongoDocumentPage, MongoDocumentQuery, MongoFieldStat } from '@shared/types'
import type { MongoDriverConnection } from './connection'
import { MongoUserError } from './errors'
import {
  bsonTypeOfValue,
  canonical,
  docToWire,
  parseCanonicalValue,
  parseOptionalDocument
} from './values'

/** Biggest page the browser asks for. */
export const MAX_PAGE = 1000
/** countDocuments budget for the browser's total (section 9.1). */
export const COUNT_TIMEOUT_MS = 3000

/** Statistics of top-level fields: `_id` first, then by frequency, then by first appearance. */
export function fieldStats(docs: Document[]): MongoFieldStat[] {
  const stats = new Map<string, MongoFieldStat>()
  for (const doc of docs) {
    for (const [key, value] of Object.entries(doc)) {
      let s = stats.get(key)
      if (!s) {
        s = { path: key, count: 0, types: {} }
        stats.set(key, s)
      }
      s.count++
      const t = bsonTypeOfValue(value)
      s.types[t] = (s.types[t] ?? 0) + 1
    }
  }
  const order = [...stats.keys()]
  return [...stats.values()].sort((a, b) => {
    if (a.path === '_id') return -1
    if (b.path === '_id') return 1
    return b.count - a.count || order.indexOf(a.path) - order.indexOf(b.path)
  })
}

/** Reads up to `count` documents; `more` when the cursor still has some. */
export async function readBatch(
  cursor: AbstractCursor<Document>,
  count: number
): Promise<{ docs: Document[]; more: boolean }> {
  const docs: Document[] = []
  while (docs.length < count) {
    const doc = await cursor.next()
    if (doc === null) return { docs, more: false }
    docs.push(doc)
  }
  return { docs, more: await cursor.hasNext() }
}

/** A page of documents in wire form. */
export function toPage(
  docs: Document[],
  whole: boolean,
  extra: Partial<MongoDocumentPage> & { durationMs: number }
): MongoDocumentPage {
  const wire = docs.map(docToWire)
  return {
    docs: wire.map((w) => w.text),
    whole: wire.map((w) => whole && w.whole),
    fields: fieldStats(docs),
    total: null,
    totalExact: false,
    truncated: false,
    resultId: null,
    ...extra
  }
}

function pageSize(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 100
  return Math.min(Math.floor(n), MAX_PAGE)
}

/** mongo:find: one page of the collection browser. */
export async function findPage(
  conn: MongoDriverConnection,
  query: MongoDocumentQuery,
  owner = 'browser'
): Promise<MongoDocumentPage> {
  const started = performance.now()
  const filter = parseOptionalDocument(query.filter, 'Filtro') ?? {}
  const sort = parseOptionalDocument(query.sort, 'Orden')
  const projection = parseOptionalDocument(query.projection, 'Proyección')
  const limit = pageSize(query.limit)
  const skip = Math.max(0, Math.floor(query.skip || 0))
  const comment = conn.startExecution(query.executionId)
  try {
    const coll = conn.coll(query.database, query.collection)
    const cursor = conn.rawColl(query.database, query.collection).find(filter, {
      ...(sort ? { sort } : {}),
      ...(projection ? { projection } : {}),
      skip,
      batchSize: Math.min(limit + 1, 1000),
      ...(comment ? { comment } : {})
    })
    let batch
    try {
      batch = await readBatch(cursor, limit)
    } catch (err) {
      await cursor.close().catch(() => undefined)
      throw err
    }
    const whole = !projection
    let resultId: string | null = null
    if (batch.more) resultId = conn.registerCursor(owner, cursor, whole, comment)
    else await cursor.close().catch(() => undefined)
    const empty = Object.keys(filter).length === 0
    let total: number | null = null
    let totalExact = false
    try {
      if (empty) {
        total = await coll.estimatedDocumentCount(comment ? { comment } : {})
      } else {
        total = await coll.countDocuments(filter, {
          maxTimeMS: COUNT_TIMEOUT_MS,
          ...(comment ? { comment } : {})
        })
        totalExact = true
      }
    } catch {
      total = null // too slow (maxTimeMS) or not allowed: the page still shows
    }
    return toPage(batch.docs, whole, {
      total,
      totalExact,
      truncated: batch.more,
      resultId,
      durationMs: Math.round(performance.now() - started)
    })
  } catch (err) {
    throw conn.errorOf(err, query.executionId)
  } finally {
    conn.endExecution(query.executionId)
  }
}

/** mongo:getMore: the next documents of an open cursor. */
export async function getMore(
  conn: MongoDriverConnection,
  resultId: string,
  count: number
): Promise<MongoDocumentPage> {
  const started = performance.now()
  const open = conn.cursor(resultId)
  let batch
  try {
    batch = await readBatch(open.cursor, pageSize(count))
  } catch (err) {
    await conn.closeCursor(resultId)
    throw conn.errorOf(err)
  }
  if (!batch.more) await conn.closeCursor(resultId)
  return toPage(batch.docs, open.whole, {
    truncated: batch.more,
    resultId: batch.more ? resultId : null,
    durationMs: Math.round(performance.now() - started)
  })
}

/** mongo:document: the whole document by `_id` (canonical EJSON of the id). */
export async function documentById(
  conn: MongoDriverConnection,
  database: string,
  collection: string,
  idText: string
): Promise<string | null> {
  const id = parseCanonicalValue(idText, '_id')
  try {
    const doc = await conn.rawColl(database, collection).findOne({ _id: id as never })
    return doc ? canonical(doc) : null
  } catch (err) {
    throw conn.errorOf(err)
  }
}

/* ---------- field shape sampling (no values) ---------- */

const MAX_DEPTH = 4
const MAX_PATHS = 500

/**
 * Walks documents and records, for every dotted path up to 4 levels deep,
 * how many documents have it and with which BSON types. Array elements that
 * are documents contribute their fields under the array's path. Values are
 * never kept.
 */
export function shapeOf(docs: Document[]): MongoFieldStat[] {
  const stats = new Map<string, MongoFieldStat>()
  for (const doc of docs) {
    const seen = new Set<string>()
    const walk = (value: Document, prefix: string, depth: number): void => {
      for (const [key, v] of Object.entries(value)) {
        const path = prefix ? `${prefix}.${key}` : key
        let s = stats.get(path)
        if (!s) {
          if (stats.size >= MAX_PATHS) continue
          s = { path, count: 0, types: {} }
          stats.set(path, s)
        }
        const type = bsonTypeOfValue(v)
        if (!seen.has(path)) {
          s.count++
          seen.add(path)
        }
        s.types[type] = (s.types[type] ?? 0) + 1
        if (depth >= MAX_DEPTH) continue
        if (type === 'object') walk(v as Document, path, depth + 1)
        else if (type === 'array')
          for (const el of (v as unknown[]).slice(0, 50))
            if (bsonTypeOfValue(el) === 'object') walk(el as Document, path, depth + 1)
      }
    }
    walk(doc, '', 1)
  }
  return [...stats.values()].sort((a, b) =>
    a.path === '_id' ? -1 : b.path === '_id' ? 1 : a.path.localeCompare(b.path)
  )
}

/** mongo:sampleFields: shape of a $sample of the collection. */
export async function sampleFields(
  conn: MongoDriverConnection,
  database: string,
  collection: string,
  size = 1000
): Promise<MongoFieldStat[]> {
  const n = Math.max(1, Math.min(Math.floor(size) || 1000, 5000))
  try {
    const docs = await conn
      .rawColl(database, collection)
      .aggregate([{ $sample: { size: n } }], { maxTimeMS: 15_000 })
      .toArray()
    return shapeOf(docs)
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code === 26) return [] // missing collection: nothing to sample
    if (code === 166)
      throw new MongoUserError('Las vistas que no admiten $sample no se pueden muestrear.')
    throw conn.errorOf(err)
  }
}
