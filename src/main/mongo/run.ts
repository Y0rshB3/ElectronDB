/**
 * Query-tab execution (docs/multi-engine-design.md, 9.3).
 *
 * `prepareMongoScript` parses the whole script with the shared whitelist
 * grammar and parses every argument with shell-bson-parser (strict) before
 * anything runs, and decides per statement whether it writes from the parsed
 * values (an aggregate whose pipeline has `$out`/`$merge` at any depth is a
 * write even when the text hides it). `runPreparedScript` then dispatches each
 * statement to a fixed driver call; nothing the user typed is evaluated.
 */
import type { ClientSession, Collection, Document } from 'mongodb'
import { statementIsObviousWrite, valueHasWriteStage } from '@shared/mongo/classify'
import {
  MongoShellError,
  parseShellScript,
  positionText,
  type MongoArg,
  type MongoCall,
  type MongoStatement
} from '@shared/mongo/shell'
import type { MongoCommandResult, MongoExecuteOptions } from '@shared/types'
import { collectionInfo } from './admin'
import type { MongoDriverConnection } from './connection'
import { MongoUserError } from './errors'
import { readBatch, toPage } from './documents'
import { MongoInputError, canonical, numberOf, parseUserValue } from './values'

export interface PreparedStatement {
  statement: MongoStatement
  /** Parsed arguments of the method (and of each chained call). */
  args: unknown[]
  chain: { name: string; args: unknown[] }[]
  explain: unknown | undefined
  /** Writes (guarded on production). */
  writes: boolean
}

const MAX_IDS = 100

function argValue(arg: MongoArg, label: string): unknown {
  switch (arg.kind) {
    case 'string':
    case 'number':
    case 'boolean':
      return arg.value
    case 'null':
      return null
    case 'expr':
      return parseUserValue(arg.source, label)
  }
}

function callValues(call: { args: MongoArg[] }, name: string): unknown[] {
  return call.args.map((a, i) => argValue(a, `Argumento ${i + 1} de ${name}()`))
}

/** Parses a script and all its arguments; throws (shown, not logged) on the first problem. */
export function prepareMongoScript(script: string): PreparedStatement[] {
  let statements: MongoStatement[]
  try {
    statements = parseShellScript(script)
  } catch (err) {
    if (err instanceof MongoShellError) throw new MongoInputError(err.message)
    throw err
  }
  return statements.map((statement) => {
    const where = positionText(script, statement.start)
    try {
      const args = 'args' in statement ? callValues(statement, methodName(statement)) : []
      const chain =
        statement.type === 'collection'
          ? statement.chain.map((c: MongoCall) => ({ name: c.name, args: callValues(c, c.name) }))
          : []
      const explain =
        statement.type === 'collection' && statement.explain?.verbosity
          ? argValue(statement.explain.verbosity, 'explain')
          : undefined
      const writes =
        statementIsObviousWrite(statement) ||
        (statement.type === 'collection' &&
          statement.method === 'aggregate' &&
          args.some((a) => valueHasWriteStage(a)))
      return { statement, args, chain, explain, writes }
    } catch (err) {
      if (err instanceof MongoInputError)
        throw new MongoInputError(`${err.message.replace(/\.$/, '')}${where}.`)
      throw err
    }
  })
}

function methodName(s: MongoStatement): string {
  return s.type === 'collection' || s.type === 'db' || s.type === 'rs' ? s.method : s.type
}

/** Stages an editable aggregate result may have (section 5.4). */
const EDITABLE_STAGES = new Set(['$match', '$sort', '$limit', '$skip', '$project'])

function isInclusionProjection(p: unknown): boolean {
  if (!p || typeof p !== 'object') return false
  return Object.entries(p as Document).every(([k, v]) => {
    const n = numberOf(v)
    if (k === '_id') return v === false || v === true || n === 0 || n === 1
    return v === true || n === 1
  })
}

export interface RunContext {
  maxDocs: number
  /** Cursor owner: the query tab (its cursors close with it). */
  owner: string
}

function docs(v: unknown): Document[] {
  if (!Array.isArray(v)) throw new MongoInputError('Se esperaba un array de documentos.')
  return v as Document[]
}

function doc(v: unknown, what: string): Document {
  if (v === undefined) return {}
  if (v === null || typeof v !== 'object' || Array.isArray(v))
    throw new MongoInputError(`${what}: debe ser un documento ({ … }).`)
  return v as Document
}

function optDoc(v: unknown, what: string): Document {
  return v === undefined || v === null ? {} : doc(v, what)
}

/**
 * User options first, then Vortaq's session and comment: a typed option can
 * never move a statement out of the tab's transaction or drop the killOp tag.
 */
function withOurs(
  user: Document,
  session: ClientSession | undefined,
  comment: string | null
): Document {
  const out: Document = { ...user }
  delete out.session
  if (session) out.session = session
  else delete out.session
  if (comment) out.comment = comment
  return out
}

function valueResult(
  base: Omit<MongoCommandResult, 'kind'>,
  value: unknown,
  text = false
): MongoCommandResult {
  return { ...base, kind: 'value', value: text ? String(value) : canonical({ v: value }) }
}

function idsOf(ids: unknown): string[] {
  const list = Array.isArray(ids) ? ids : ids && typeof ids === 'object' ? Object.values(ids) : []
  return list.slice(0, MAX_IDS).map((id) => canonical(id))
}

/**
 * Runs prepared statements in order on the tab's database and session. A
 * failing statement stops the script; its result carries the error.
 */
export async function runPreparedScript(
  conn: MongoDriverConnection,
  prepared: PreparedStatement[],
  options: MongoExecuteOptions,
  ctx: RunContext
): Promise<MongoCommandResult[]> {
  const tab = options.sessionKey ? conn.tab(options.sessionKey) : null
  // The tab's database combo is the source of truth; `use` moves it (currentDatabase).
  let current = options.database ?? tab?.database ?? null
  if (tab) tab.database = current
  const results: MongoCommandResult[] = []
  const comment = conn.startExecution(options.executionId)
  try {
    for (const p of prepared) {
      if (conn.wasCancelled(options.executionId)) {
        results.push({
          statement: p.statement.text,
          durationMs: 0,
          kind: 'error',
          database: current,
          error: 'No se ejecutó: la consulta se canceló.'
        })
        break
      }
      const database =
        ('database' in p.statement ? p.statement.database : null) ?? current ?? conn.defaultDatabase
      const started = performance.now()
      const base = {
        statement: p.statement.text,
        durationMs: 0,
        database,
        ...(p.statement.type === 'collection' ? { collection: p.statement.collection } : {})
      }
      try {
        if (p.statement.type === 'use') {
          current = p.statement.database
          if (tab) tab.database = current
          results.push({
            ...valueResult(base, `Base de datos actual: ${current}`, true),
            database: current,
            durationMs: 0,
            currentDatabase: current
          })
          continue
        }
        const session = conn.sessionFor(options.sessionKey)
        const result = await runOne(conn, p, database, session, comment, ctx, base)
        result.durationMs = Math.round(performance.now() - started)
        results.push(result)
      } catch (err) {
        conn.noteTransactionError(options.sessionKey, err)
        const e = conn.errorOf(err, options.executionId)
        results.push({
          ...base,
          durationMs: Math.round(performance.now() - started),
          kind: 'error',
          error: e.message
        })
        break
      }
    }
  } finally {
    conn.endExecution(options.executionId)
  }
  const state = options.sessionKey ? conn.sessionState(options.sessionKey) : null
  for (const r of results) {
    if (state) r.transactionStatus = state.transactionStatus
    r.currentDatabase = current
  }
  return results
}

async function runOne(
  conn: MongoDriverConnection,
  p: PreparedStatement,
  database: string,
  session: ClientSession | undefined,
  comment: string | null,
  ctx: RunContext,
  base: Omit<MongoCommandResult, 'kind'>
): Promise<MongoCommandResult> {
  const s = p.statement
  const admin = conn.client.db('admin')
  const db = conn.db(database)
  switch (s.type) {
    case 'use':
      throw new MongoUserError('use se resuelve antes')
    case 'show': {
      if (s.what === 'dbs') {
        const list = await admin.admin().listDatabases({ authorizedDatabases: true })
        const lines = list.databases.map(
          (d) =>
            `${d.name}\t${d.sizeOnDisk !== undefined ? `${Math.round(Number(d.sizeOnDisk) / 1024)} KB` : ''}`
        )
        return valueResult(base, lines.join('\n') || '(sin bases de datos visibles)', true)
      }
      const names = (
        await db.listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray()
      )
        .map((c) => String(c.name))
        .sort()
      return valueResult(base, names.join('\n') || '(sin colecciones)', true)
    }
    case 'rs':
      return valueResult(base, await admin.command({ replSetGetStatus: 1 }, { session }))
    case 'db':
      return runDbMethod(conn, p, database, session, comment, base)
    case 'collection':
      return runCollectionMethod(conn, p, database, session, comment, ctx, base)
  }
}

async function runDbMethod(
  conn: MongoDriverConnection,
  p: PreparedStatement,
  database: string,
  session: ClientSession | undefined,
  comment: string | null,
  base: Omit<MongoCommandResult, 'kind'>
): Promise<MongoCommandResult> {
  const s = p.statement as Extract<MongoStatement, { type: 'db' }>
  const db = conn.db(database)
  const admin = conn.client.db('admin')
  const [a0, a1] = p.args
  switch (s.method) {
    case 'stats':
      return valueResult(
        base,
        await db.command({ dbStats: 1, scale: numberOf(a0) || 1 }, { session })
      )
    case 'version': {
      const info = await admin.command({ buildInfo: 1 })
      return valueResult(base, String(info.version ?? ''), true)
    }
    case 'getName':
      return valueResult(base, database, true)
    case 'getCollectionNames': {
      const names = (
        await db.listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray()
      )
        .map((c) => String(c.name))
        .sort()
      return valueResult(base, names)
    }
    case 'getCollectionInfos':
      return valueResult(
        base,
        await db.listCollections(optDoc(a0, 'Filtro'), { authorizedCollections: true }).toArray()
      )
    case 'serverStatus':
      return valueResult(base, await admin.command({ serverStatus: 1, ...optDoc(a0, 'Opciones') }))
    case 'currentOp': {
      const filter = optDoc(a0, 'Filtro')
      const run = (allUsers: boolean): Promise<Document[]> =>
        admin
          .aggregate([{ $currentOp: { allUsers, idleConnections: false } }, { $match: filter }])
          .toArray()
      const ops = await run(true).catch(() => run(false))
      return valueResult(base, { inprog: ops })
    }
    case 'createCollection': {
      if (typeof a0 !== 'string' || !a0)
        throw new MongoInputError('createCollection necesita el nombre de la colección.')
      await db.createCollection(a0, withOurs(optDoc(a1, 'Opciones'), session, null))
      return writeResult(base, { acknowledged: true })
    }
    case 'dropDatabase':
      await db.dropDatabase(withOurs({}, session, comment))
      return writeResult(base, { acknowledged: true })
    default:
      throw new MongoUserError(`db.${s.method}() no está admitido.`)
  }
}

function writeResult(
  base: Omit<MongoCommandResult, 'kind'>,
  w: Partial<NonNullable<MongoCommandResult['write']>>
): MongoCommandResult {
  return {
    ...base,
    kind: 'write',
    write: {
      acknowledged: w.acknowledged ?? true,
      matched: w.matched ?? null,
      modified: w.modified ?? null,
      inserted: w.inserted ?? null,
      deleted: w.deleted ?? null,
      upserted: w.upserted ?? null,
      ids: w.ids ?? []
    }
  }
}

async function runCollectionMethod(
  conn: MongoDriverConnection,
  p: PreparedStatement,
  database: string,
  session: ClientSession | undefined,
  comment: string | null,
  ctx: RunContext,
  base: Omit<MongoCommandResult, 'kind'>
): Promise<MongoCommandResult> {
  const s = p.statement as Extract<MongoStatement, { type: 'collection' }>
  const coll = conn.coll(database, s.collection)
  // Reads that return documents keep every BSON type; writes and counts use plain results.
  const raw = conn.rawColl(database, s.collection)
  const [a0, a1, a2] = p.args
  const ours = (user: unknown, what = 'Opciones'): Document =>
    withOurs(optDoc(user, what), session, comment)
  const explainVerbosity = (): string =>
    typeof p.explain === 'string' && p.explain ? p.explain : 'queryPlanner'

  switch (s.method) {
    case 'find':
    case 'findOne':
      return runFind(conn, raw, p, session, comment, ctx, base)
    case 'aggregate':
      return runAggregate(conn, raw, p, session, comment, ctx, base)
    case 'countDocuments':
    case 'count': {
      if (p.explain !== undefined || s.explain)
        return valueResult(
          base,
          await conn
            .db(database)
            .command(
              {
                explain: { count: s.collection, query: optDoc(a0, 'Filtro') },
                verbosity: explainVerbosity()
              },
              { session }
            )
        )
      return valueResult(base, await coll.countDocuments(optDoc(a0, 'Filtro'), ours(a1)))
    }
    case 'estimatedDocumentCount':
      return valueResult(base, await coll.estimatedDocumentCount(ours(a0)))
    case 'distinct': {
      if (typeof a0 !== 'string')
        throw new MongoInputError('distinct necesita el nombre del campo como texto.')
      if (s.explain)
        return valueResult(
          base,
          await conn.db(database).command(
            {
              explain: { distinct: s.collection, key: a0, query: optDoc(a1, 'Filtro') },
              verbosity: explainVerbosity()
            },
            { session }
          )
        )
      return valueResult(base, await raw.distinct(a0, optDoc(a1, 'Filtro'), ours(a2)))
    }
    case 'getIndexes':
      return valueResult(base, await coll.listIndexes({ session }).toArray())
    case 'stats': {
      const [stats] = await coll
        .aggregate([{ $collStats: { storageStats: {}, count: {} } }], ours(undefined))
        .toArray()
      return valueResult(base, stats ?? {})
    }
    case 'insertOne': {
      const r = await coll.insertOne(doc(a0, 'Documento'), ours(a1))
      return writeResult(base, {
        acknowledged: r.acknowledged,
        inserted: 1,
        ids: idsOf([r.insertedId])
      })
    }
    case 'insertMany': {
      const r = await coll.insertMany(docs(a0), ours(a1))
      return writeResult(base, {
        acknowledged: r.acknowledged,
        inserted: r.insertedCount,
        ids: idsOf(r.insertedIds)
      })
    }
    case 'updateOne':
    case 'updateMany': {
      const update = Array.isArray(a1) ? (a1 as Document[]) : doc(a1, 'Actualización')
      const r =
        s.method === 'updateOne'
          ? await coll.updateOne(optDoc(a0, 'Filtro'), update, ours(a2))
          : await coll.updateMany(optDoc(a0, 'Filtro'), update, ours(a2))
      return writeResult(base, {
        acknowledged: r.acknowledged,
        matched: r.matchedCount,
        modified: r.modifiedCount,
        upserted: r.upsertedCount,
        ids: r.upsertedId !== null && r.upsertedId !== undefined ? idsOf([r.upsertedId]) : []
      })
    }
    case 'replaceOne': {
      const r = await coll.replaceOne(optDoc(a0, 'Filtro'), doc(a1, 'Documento'), ours(a2))
      return writeResult(base, {
        acknowledged: r.acknowledged,
        matched: r.matchedCount,
        modified: r.modifiedCount,
        upserted: r.upsertedCount,
        ids: r.upsertedId !== null && r.upsertedId !== undefined ? idsOf([r.upsertedId]) : []
      })
    }
    case 'deleteOne':
    case 'deleteMany': {
      const r =
        s.method === 'deleteOne'
          ? await coll.deleteOne(optDoc(a0, 'Filtro'), ours(a1))
          : await coll.deleteMany(optDoc(a0, 'Filtro'), ours(a1))
      return writeResult(base, { acknowledged: r.acknowledged, deleted: r.deletedCount })
    }
    case 'findOneAndUpdate': {
      const update = Array.isArray(a1) ? (a1 as Document[]) : doc(a1, 'Actualización')
      const r = await raw.findOneAndUpdate(optDoc(a0, 'Filtro'), update, {
        ...ours(a2),
        includeResultMetadata: false
      })
      return valueResult(base, r)
    }
    case 'findOneAndReplace': {
      const r = await raw.findOneAndReplace(optDoc(a0, 'Filtro'), doc(a1, 'Documento'), {
        ...ours(a2),
        includeResultMetadata: false
      })
      return valueResult(base, r)
    }
    case 'findOneAndDelete': {
      const r = await raw.findOneAndDelete(optDoc(a0, 'Filtro'), {
        ...ours(a1),
        includeResultMetadata: false
      })
      return valueResult(base, r)
    }
    case 'bulkWrite': {
      const r = await coll.bulkWrite(docs(a0) as never, ours(a1))
      return writeResult(base, {
        acknowledged: r.isOk(),
        matched: r.matchedCount,
        modified: r.modifiedCount,
        inserted: r.insertedCount,
        deleted: r.deletedCount,
        upserted: r.upsertedCount,
        ids: idsOf(r.insertedIds)
      })
    }
    case 'createIndex':
      return valueResult(base, await coll.createIndex(doc(a0, 'Claves'), ours(a1)), true)
    case 'createIndexes':
      return valueResult(base, await coll.createIndexes(docs(a0) as never, ours(a1)))
    case 'dropIndex': {
      if (a0 === '_id_') throw new MongoUserError('El índice _id_ no se puede eliminar.')
      await coll.dropIndex(typeof a0 === 'string' ? a0 : (doc(a0, 'Índice') as never), ours(a1))
      return writeResult(base, { acknowledged: true })
    }
    case 'dropIndexes':
      await coll.dropIndexes(ours(a0))
      return writeResult(base, { acknowledged: true })
    case 'drop':
      return valueResult(base, await coll.drop(ours(a0)))
    case 'renameCollection': {
      if (typeof a0 !== 'string' || !a0)
        throw new MongoInputError('renameCollection necesita el nombre nuevo.')
      await coll.rename(a0, { dropTarget: a1 === true, ...(session ? { session } : {}) })
      return writeResult(base, { acknowledged: true })
    }
    default:
      throw new MongoUserError(`${s.method}() no está admitido.`)
  }
}

/** Why the documents of a result cannot be edited in place, or null. */
async function editability(
  conn: MongoDriverConnection,
  database: string,
  collection: string,
  documents: Document[]
): Promise<string | null> {
  const info = await collectionInfo(conn, database, collection).catch(() => null)
  if (!info) return 'La colección no existe.'
  if (info.readOnlyReason) return info.readOnlyReason
  if (documents.some((d) => d._id === undefined)) return 'Hay documentos sin _id.'
  return null
}

async function runFind(
  conn: MongoDriverConnection,
  coll: Collection<Document>,
  p: PreparedStatement,
  session: ClientSession | undefined,
  comment: string | null,
  ctx: RunContext,
  base: Omit<MongoCommandResult, 'kind'>
): Promise<MongoCommandResult> {
  const s = p.statement as Extract<MongoStatement, { type: 'collection' }>
  const filter = optDoc(p.args[0], 'Filtro')
  let projection: Document | null =
    p.args[1] === undefined || p.args[1] === null ? null : doc(p.args[1], 'Proyección')
  const options: Document = withOurs(optDoc(p.args[2], 'Opciones'), session, comment)
  let limit: number | null = s.method === 'findOne' ? 1 : null
  let count = false
  for (const c of p.chain) {
    const v = c.args[0]
    switch (c.name) {
      case 'sort':
        options.sort = doc(v, 'Orden')
        break
      case 'limit':
        limit = Math.abs(numberOf(v)) || null
        break
      case 'skip':
        options.skip = Math.max(0, numberOf(v) || 0)
        break
      case 'project':
      case 'projection':
        projection = doc(v, 'Proyección')
        break
      case 'hint':
        options.hint = typeof v === 'string' ? v : doc(v, 'Índice')
        break
      case 'collation':
        options.collation = doc(v, 'Intercalación')
        break
      case 'maxTimeMS':
        options.maxTimeMS = numberOf(v)
        break
      case 'batchSize':
        options.batchSize = numberOf(v)
        break
      case 'allowDiskUse':
        options.allowDiskUse = v !== false
        break
      case 'comment':
        break // Vortaq's comment tags the operation for killOp
      case 'count':
      case 'itcount':
      case 'size':
        count = true
        break
    }
  }
  if (projection && Object.keys(projection).length === 0) projection = null
  if (projection) options.projection = projection
  if (count) {
    const countOptions: Document = {
      ...(session ? { session } : {}),
      ...(comment ? { comment } : {})
    }
    if (options.skip) countOptions.skip = options.skip
    if (limit) countOptions.limit = limit
    return valueResult(base, await coll.countDocuments(filter, countOptions))
  }
  if (s.explain) {
    const cursor = coll.find(filter, { ...options, ...(limit ? { limit } : {}) })
    const verbosity = typeof p.explain === 'string' && p.explain ? p.explain : 'queryPlanner'
    return valueResult(base, await cursor.explain(verbosity as never))
  }
  const cap = Math.max(1, Math.min(limit ?? ctx.maxDocs, ctx.maxDocs))
  const cursor = coll.find(filter, {
    ...options,
    ...(limit ? { limit } : {}),
    batchSize: options.batchSize ?? Math.min(cap + 1, 1000)
  })
  let batch
  try {
    batch = await readBatch(cursor, cap)
  } catch (err) {
    await cursor.close().catch(() => undefined)
    throw err
  }
  const whole = !projection
  const resultId =
    batch.more && !session ? conn.registerCursor(ctx.owner, cursor, whole, comment) : null
  if (!resultId) await cursor.close().catch(() => undefined)
  return {
    ...base,
    kind: 'documents',
    page: toPage(batch.docs, whole, { truncated: batch.more, resultId, durationMs: 0 }),
    readOnlyReason: await editability(conn, base.database ?? '', s.collection, batch.docs)
  }
}

async function runAggregate(
  conn: MongoDriverConnection,
  coll: Collection<Document>,
  p: PreparedStatement,
  session: ClientSession | undefined,
  comment: string | null,
  ctx: RunContext,
  base: Omit<MongoCommandResult, 'kind'>
): Promise<MongoCommandResult> {
  const s = p.statement as Extract<MongoStatement, { type: 'collection' }>
  const pipeline = p.args[0] === undefined ? [] : docs(p.args[0])
  const options = withOurs(optDoc(p.args[1], 'Opciones'), session, comment)
  if (s.explain) {
    const verbosity = typeof p.explain === 'string' && p.explain ? p.explain : 'queryPlanner'
    return valueResult(base, await coll.aggregate(pipeline, options).explain(verbosity as never))
  }
  if (p.chain.some((c) => c.name === 'itcount' || c.name === 'size')) {
    const counted = await coll.aggregate([...pipeline, { $count: 'n' }], options).toArray()
    return valueResult(base, numberOf(counted[0]?.n) || 0)
  }
  if (p.writes) {
    // $out / $merge: the pipeline writes; run it to the end.
    await coll.aggregate(pipeline, options).toArray()
    return writeResult(base, { acknowledged: true })
  }
  const cursor = coll.aggregate(pipeline, {
    ...options,
    batchSize: Math.min(ctx.maxDocs + 1, 1000)
  })
  let batch
  try {
    batch = await readBatch(cursor, ctx.maxDocs)
  } catch (err) {
    await cursor.close().catch(() => undefined)
    throw err
  }
  const stages = pipeline.map((st) => Object.keys(st)[0] ?? '')
  const blocking = stages.find((st) => !EDITABLE_STAGES.has(st))
  const projects = pipeline.filter((st) => '$project' in st).map((st) => st.$project)
  const whole = projects.length === 0
  const resultId =
    batch.more && !session ? conn.registerCursor(ctx.owner, cursor, whole, comment) : null
  if (!resultId) await cursor.close().catch(() => undefined)
  let readOnlyReason: string | null
  if (blocking)
    readOnlyReason = `Resultado de aggregate con ${blocking}: no se edita en la rejilla.`
  else if (projects.some((pr) => !isInclusionProjection(pr)))
    readOnlyReason = 'Resultado de aggregate con $project que calcula o excluye campos.'
  else readOnlyReason = await editability(conn, base.database ?? '', s.collection, batch.docs)
  return {
    ...base,
    kind: 'documents',
    page: toPage(batch.docs, whole, { truncated: batch.more, resultId, durationMs: 0 }),
    readOnlyReason
  }
}
