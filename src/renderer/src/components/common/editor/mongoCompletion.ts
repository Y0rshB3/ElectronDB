/**
 * Completion for MongoDB query tabs (docs/multi-engine-design.md, 9.3):
 * collection names after `db.`, methods after `db.<coll>.`, cursor modifiers
 * after `).`, `$` operators, sampled field paths (names only) of the
 * collection the statement names, and database names after `use `.
 */
import type {
  CompletionContext,
  CompletionResult,
  CompletionSource
} from '@codemirror/autocomplete'
import {
  COLLECTION_READ_METHODS,
  COLLECTION_WRITE_METHODS,
  DB_READ_METHODS,
  DB_WRITE_METHODS
} from '@shared/mongo/shell'

export interface MongoSchemaProvider {
  databases(): Promise<string[]>
  collections(): Promise<string[]>
  /** Sampled dotted paths of a collection (no values). */
  fields(collection: string): Promise<string[]>
}

/** Caches each answer of a provider until `clear()`. */
export function cachedMongoProvider(base: MongoSchemaProvider): MongoSchemaProvider & {
  clear(): void
} {
  const memo = new Map<string, Promise<string[]>>()
  const once = (key: string, load: () => Promise<string[]>): Promise<string[]> => {
    let p = memo.get(key)
    if (!p) {
      p = load().catch(() => {
        memo.delete(key)
        return []
      })
      memo.set(key, p)
    }
    return p
  }
  return {
    databases: () => once('dbs', () => base.databases()),
    collections: () => once('colls', () => base.collections()),
    fields: (c) => once(`f:${c}`, () => base.fields(c)),
    clear: () => memo.clear()
  }
}

const CURSOR_METHODS = [
  'sort',
  'limit',
  'skip',
  'project',
  'hint',
  'collation',
  'maxTimeMS',
  'count',
  'explain',
  'pretty',
  'toArray'
]

export const QUERY_OPERATORS = [
  '$eq',
  '$ne',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$in',
  '$nin',
  '$and',
  '$or',
  '$nor',
  '$not',
  '$exists',
  '$type',
  '$regex',
  '$options',
  '$elemMatch',
  '$size',
  '$all',
  '$expr',
  '$text',
  '$search',
  '$near',
  '$geoWithin',
  '$set',
  '$unset',
  '$inc',
  '$push',
  '$pull',
  '$addToSet',
  '$rename',
  '$currentDate'
]

export const STAGES = [
  '$match',
  '$project',
  '$group',
  '$sort',
  '$limit',
  '$skip',
  '$lookup',
  '$unwind',
  '$addFields',
  '$set',
  '$count',
  '$facet',
  '$bucket',
  '$sortByCount',
  '$replaceRoot',
  '$sample',
  '$out',
  '$merge',
  '$sum',
  '$avg',
  '$min',
  '$max',
  '$first',
  '$last',
  '$push'
]

const IDENT = /[\w$.]*$/

/** Collection named by the statement around the cursor (`db.x.` or `getCollection('x')`). */
export function collectionAt(before: string): string | null {
  const start = Math.max(
    before.lastIndexOf('\ndb.'),
    before.lastIndexOf(';'),
    before.startsWith('db.') ? 0 : -1
  )
  const statement = before.slice(Math.max(0, start))
  const bracket = /db\.getCollection\(\s*['"]([^'"]+)['"]\s*\)\./.exec(statement)
  if (bracket) return bracket[1]
  const plain = /db\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*?)\.(\w+)\s*\(/.exec(statement)
  return plain ? plain[1] : null
}

export function mongoCompletionSource(provider: MongoSchemaProvider): CompletionSource {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const line = ctx.state.doc.lineAt(ctx.pos)
    const lineBefore = line.text.slice(0, ctx.pos - line.from)
    const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 4000), ctx.pos)

    const use = /^\s*use\s+(\S*)$/.exec(lineBefore)
    if (use) {
      const dbs = await provider.databases()
      return {
        from: ctx.pos - use[1].length,
        options: dbs.map((d) => ({ label: d, type: 'namespace' }))
      }
    }

    // db.<coll>.<method>
    const method = /db\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([\w$]*)$/.exec(lineBefore)
    if (method) {
      const collections = await provider.collections()
      const path = method[1]
      if (collections.includes(path) || !collections.some((c) => c.startsWith(`${path}.`))) {
        return {
          from: ctx.pos - method[2].length,
          options: [
            ...COLLECTION_READ_METHODS.map((m) => ({
              label: m,
              type: 'method',
              detail: 'lectura'
            })),
            ...COLLECTION_WRITE_METHODS.map((m) => ({
              label: m,
              type: 'method',
              detail: 'escritura'
            }))
          ]
        }
      }
    }

    // db.<collection> / db.<method>
    const dbDot = /(?:^|[^\w$.])db\.([\w$.]*)$/.exec(lineBefore)
    if (dbDot) {
      const collections = await provider.collections()
      const typed = dbDot[1]
      return {
        from: ctx.pos - typed.length,
        options: [
          ...collections.map((c) => ({ label: c, type: 'class', detail: 'colección' })),
          ...[...DB_READ_METHODS, ...DB_WRITE_METHODS, 'getCollection', 'getSiblingDB'].map(
            (m) => ({
              label: m,
              type: 'function',
              apply: `${m}()`
            })
          )
        ]
      }
    }

    // ).modifier
    const chain = /\)\s*\.([\w$]*)$/.exec(lineBefore)
    if (chain) {
      return {
        from: ctx.pos - chain[1].length,
        options: CURSOR_METHODS.map((m) => ({ label: m, type: 'method' }))
      }
    }

    // $operators and stages
    const dollar = /(?:^|[{\s,'"[])(\$[\w]*)$/.exec(lineBefore)
    if (dollar) {
      return {
        from: ctx.pos - dollar[1].length,
        options: [...new Set([...STAGES, ...QUERY_OPERATORS])].map((o) => ({
          label: o,
          type: STAGES.includes(o) ? 'keyword' : 'operator'
        }))
      }
    }

    // Field names inside an argument object.
    const word = IDENT.exec(lineBefore)?.[0] ?? ''
    const insideArgs = before.lastIndexOf('(') > before.lastIndexOf(')')
    if (insideArgs && (ctx.explicit || word.length > 0)) {
      const coll = collectionAt(before)
      if (!coll) return null
      const fields = await provider.fields(coll)
      if (!fields.length) return null
      return {
        from: ctx.pos - word.length,
        options: fields.map((f) => ({
          label: f,
          type: 'property',
          apply: /^[A-Za-z_$][\w$]*$/.test(f) ? f : `'${f}'`
        }))
      }
    }
    return null
  }
}
