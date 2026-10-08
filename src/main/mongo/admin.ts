/**
 * Databases, collections, indexes and validators (docs/multi-engine-design.md,
 * 5.6 introspect and 9.5 designer). Reads use listDatabases, listCollections,
 * $collStats and listIndexes; writes are the designer's and the tree menu's
 * (create/rename/empty a collection, create/drop an index, collMod for the
 * validator). The IPC layer checks the production guard before every write.
 */
import type { Document } from 'mongodb'
import type {
  DatabaseInfo,
  MongoCollectionDetails,
  MongoCollectionInfo,
  MongoCreateCollectionOptions,
  MongoIndexInfo,
  MongoIndexSpec,
  MongoValidatorInput,
  ObjectSummary
} from '@shared/types'
import type { MongoDriverConnection } from './connection'
import { MongoUserError } from './errors'
import { canonical, numberOf, parseOptionalDocument, parseUserDocument } from './values'

/** Namespaces Vortaq never lists (section 3.1). */
export function isHiddenCollection(name: string): boolean {
  return name.startsWith('system.') || name.startsWith('enxcol_.')
}

export const READ_ONLY = {
  view: 'Vista: sus documentos no se pueden editar.',
  timeseries: 'Colección de series temporales: los documentos no se editan desde la rejilla.',
  capped: 'Colección limitada (capped): no admite borrar ni cambiar el tamaño de documentos.',
  chunks: 'Fragmentos de GridFS: se modifican solo junto con su archivo.'
} as const

interface ListedCollection {
  name: string
  type?: string
  options?: Document
  info?: { readOnly?: boolean }
}

function infoOf(c: ListedCollection, all: Set<string>): MongoCollectionInfo {
  const type: MongoCollectionInfo['type'] =
    c.type === 'view' ? 'view' : c.type === 'timeseries' ? 'timeseries' : 'collection'
  const capped = c.options?.capped === true
  const chunks =
    c.name.endsWith('.chunks') && all.has(`${c.name.slice(0, -'.chunks'.length)}.files`)
  const readOnlyReason =
    type === 'view'
      ? READ_ONLY.view
      : type === 'timeseries'
        ? READ_ONLY.timeseries
        : chunks
          ? READ_ONLY.chunks
          : capped
            ? READ_ONLY.capped
            : null
  return {
    name: c.name,
    type,
    readOnlyReason,
    count: null,
    sizeBytes: null,
    storageSizeBytes: null,
    indexCount: null,
    avgObjSizeBytes: null,
    capped,
    ...(type === 'view' && typeof c.options?.viewOn === 'string'
      ? { viewOn: c.options.viewOn }
      : {})
  }
}

/** db:databases: authorised databases, falling back to the default one without the privilege. */
export async function listDatabases(conn: MongoDriverConnection): Promise<DatabaseInfo[]> {
  try {
    const result = await conn.client
      .db('admin')
      .admin()
      .listDatabases({ nameOnly: true, authorizedDatabases: true })
    const names = result.databases.map((d) => d.name).sort((a, b) => a.localeCompare(b))
    if (names.length) return names.map((name) => ({ name, characterSet: '', collation: '' }))
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code !== 13) throw conn.errorOf(err)
  }
  return [{ name: conn.defaultDatabase, characterSet: '', collation: '' }]
}

async function listed(conn: MongoDriverConnection, database: string): Promise<ListedCollection[]> {
  try {
    const all = (await conn
      .db(database)
      .listCollections({}, { authorizedCollections: true })
      .toArray()) as ListedCollection[]
    return all.filter((c) => !isHiddenCollection(c.name))
  } catch (err) {
    throw conn.errorOf(err)
  }
}

/** Storage numbers of one collection from $collStats (null fields without privileges). */
async function statsOf(
  conn: MongoDriverConnection,
  database: string,
  name: string
): Promise<Partial<MongoCollectionInfo>> {
  try {
    const [s] = await conn.client
      .db(database)
      .collection(name)
      .aggregate([{ $collStats: { storageStats: {} } }, { $limit: 1 }], { maxTimeMS: 5000 })
      .toArray()
    const st = (s?.storageStats ?? {}) as Document
    const num = (v: unknown): number | null => {
      const n = numberOf(v)
      return Number.isFinite(n) ? n : null
    }
    return {
      count: num(st.count),
      sizeBytes: num(st.size),
      storageSizeBytes: num(st.storageSize),
      indexCount: num(st.nindexes),
      avgObjSizeBytes: num(st.avgObjSize)
    }
  } catch {
    return {}
  }
}

/** mongo:collections: collections and views with their stats columns. */
export async function listCollectionInfos(
  conn: MongoDriverConnection,
  database: string
): Promise<MongoCollectionInfo[]> {
  const all = await listed(conn, database)
  const names = new Set(all.map((c) => c.name))
  const infos = all.map((c) => infoOf(c, names)).sort((a, b) => a.name.localeCompare(b.name))
  // A few at a time: a database with hundreds of collections must not open hundreds of cursors.
  const queue = infos.filter((i) => i.type !== 'view')
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let item = queue.shift(); item; item = queue.shift())
      Object.assign(item, await statsOf(conn, database, item.name))
  })
  await Promise.all(workers)
  return infos
}

/** Listing info of one collection, or null when it does not exist. */
export async function collectionInfo(
  conn: MongoDriverConnection,
  database: string,
  name: string
): Promise<MongoCollectionInfo | null> {
  try {
    const found = (await conn
      .db(database)
      .listCollections({ name }, { authorizedCollections: true })
      .toArray()) as ListedCollection[]
    if (!found.length) return null
    const files = name.endsWith('.chunks')
      ? await conn
          .db(database)
          .listCollections(
            { name: `${name.slice(0, -'.chunks'.length)}.files` },
            { nameOnly: true }
          )
          .toArray()
      : []
    return infoOf(found[0], new Set([name, ...files.map((f) => f.name as string)]))
  } catch (err) {
    throw conn.errorOf(err)
  }
}

function indexInfo(ix: Document): MongoIndexInfo {
  const known = new Set([
    'v',
    'key',
    'name',
    'unique',
    'sparse',
    'hidden',
    'expireAfterSeconds',
    'partialFilterExpression',
    'collation',
    'ns'
  ])
  const extra = Object.fromEntries(Object.entries(ix).filter(([k]) => !known.has(k)))
  const ttl = ix.expireAfterSeconds === undefined ? null : numberOf(ix.expireAfterSeconds)
  return {
    name: String(ix.name),
    keys: canonical(ix.key ?? {}),
    unique: ix.unique === true,
    sparse: ix.sparse === true,
    hidden: ix.hidden === true,
    expireAfterSeconds: ttl !== null && Number.isFinite(ttl) ? ttl : null,
    partialFilter: ix.partialFilterExpression ? canonical(ix.partialFilterExpression) : null,
    collation: ix.collation ? canonical(ix.collation) : null,
    extra: Object.keys(extra).length ? canonical(extra) : null
  }
}

export async function listIndexes(
  conn: MongoDriverConnection,
  database: string,
  collection: string
): Promise<MongoIndexInfo[]> {
  try {
    return (await conn.rawColl(database, collection).listIndexes().toArray()).map(indexInfo)
  } catch (err) {
    if ((err as { code?: unknown }).code === 26) return []
    throw conn.errorOf(err)
  }
}

/** db:objects 'index': every index of the database, named `<collection>.<index>`. */
export async function listDatabaseIndexes(
  conn: MongoDriverConnection,
  database: string
): Promise<ObjectSummary[]> {
  const out: ObjectSummary[] = []
  for (const c of await listed(conn, database)) {
    if (c.type === 'view') continue
    for (const ix of await listIndexes(conn, database, c.name)) {
      out.push({
        name: `${c.name}.${ix.name}`,
        type: 'index',
        schema: database,
        table: c.name,
        kind: ix.unique ? 'único' : ix.name === '_id_' ? '_id' : 'índice',
        detail: keysSummary(ix.keys)
      })
    }
  }
  return out
}

/** `email: 1, createdAt: -1` from canonical EJSON keys. */
export function keysSummary(keysText: string): string {
  try {
    const keys = JSON.parse(keysText) as Record<string, unknown>
    return Object.entries(keys)
      .map(([k, v]) => {
        const raw =
          v && typeof v === 'object'
            ? (Object.values(v as Record<string, unknown>)[0] as string)
            : String(v)
        return `${k}: ${raw}`
      })
      .join(', ')
  } catch {
    return keysText
  }
}

/** mongo:collectionDetails. */
export async function collectionDetails(
  conn: MongoDriverConnection,
  database: string,
  collection: string
): Promise<MongoCollectionDetails> {
  const found = (await conn
    .rawDb(database)
    .listCollections({ name: collection }, { authorizedCollections: true })
    .toArray()
    .catch((err) => {
      throw conn.errorOf(err)
    })) as ListedCollection[]
  if (!found.length)
    throw new MongoUserError(`La colección «${collection}» no existe en ${database}.`)
  const listedInfo = found[0]
  const info = (await collectionInfo(conn, database, collection)) ?? infoOf(listedInfo, new Set())
  if (info.type !== 'view') Object.assign(info, await statsOf(conn, database, collection))
  const options = listedInfo.options ?? {}
  return {
    info,
    indexes: info.type === 'view' ? [] : await listIndexes(conn, database, collection),
    validator:
      options.validator && Object.keys(options.validator).length
        ? canonical(options.validator)
        : null,
    validationLevel: typeof options.validationLevel === 'string' ? options.validationLevel : null,
    validationAction:
      typeof options.validationAction === 'string' ? options.validationAction : null,
    options: canonical(options)
  }
}

/* ---------- writes (guarded by the caller) ---------- */

const NAME_RULE = /^[^$\0]+$/

function checkName(name: string, what: string): string {
  const n = name.trim()
  if (!n || !NAME_RULE.test(n) || n.startsWith('system.'))
    throw new MongoUserError(
      `${what}: el nombre no puede estar vacío, empezar por «system.» ni contener «$».`
    )
  return n
}

export async function createCollection(
  conn: MongoDriverConnection,
  database: string,
  name: string,
  options: MongoCreateCollectionOptions
): Promise<void> {
  const n = checkName(name, 'Nueva colección')
  const validator = parseOptionalDocument(options.validator, 'Validador')
  const createOptions: Document = {}
  if (options.capped) {
    const size = Math.floor(options.size ?? 0)
    if (!(size > 0))
      throw new MongoUserError('Una colección limitada necesita un tamaño máximo en bytes.')
    createOptions.capped = true
    createOptions.size = size
    if (options.max && options.max > 0) createOptions.max = Math.floor(options.max)
  }
  if (validator) createOptions.validator = validator
  try {
    await conn.db(database).createCollection(n, createOptions)
  } catch (err) {
    throw conn.errorOf(err)
  }
}

export async function renameCollection(
  conn: MongoDriverConnection,
  database: string,
  from: string,
  to: string
): Promise<void> {
  const target = checkName(to, 'Renombrar')
  if (target === from) return
  try {
    await conn.coll(database, from).rename(target, { dropTarget: false })
  } catch (err) {
    throw conn.errorOf(err)
  }
}

export async function dropCollection(
  conn: MongoDriverConnection,
  database: string,
  name: string
): Promise<void> {
  try {
    await conn.db(database).dropCollection(name)
  } catch (err) {
    if ((err as { code?: unknown }).code === 26) return
    throw conn.errorOf(err)
  }
}

export async function clearCollection(
  conn: MongoDriverConnection,
  database: string,
  name: string
): Promise<number> {
  const info = await collectionInfo(conn, database, name)
  if (info?.readOnlyReason)
    throw new MongoUserError(`No se puede vaciar «${name}». ${info.readOnlyReason}`)
  try {
    const result = await conn.coll(database, name).deleteMany({})
    return result.deletedCount
  } catch (err) {
    throw conn.errorOf(err)
  }
}

export async function countExact(
  conn: MongoDriverConnection,
  database: string,
  name: string
): Promise<number> {
  try {
    return await conn.coll(database, name).countDocuments({})
  } catch (err) {
    throw conn.errorOf(err)
  }
}

export async function createIndex(
  conn: MongoDriverConnection,
  database: string,
  collection: string,
  spec: MongoIndexSpec
): Promise<string> {
  const keys = parseUserDocument(spec.keys, 'Claves del índice')
  if (!Object.keys(keys).length) throw new MongoUserError('El índice necesita al menos un campo.')
  const options: Document = {}
  if (spec.name?.trim()) options.name = spec.name.trim()
  if (spec.unique) options.unique = true
  if (spec.sparse) options.sparse = true
  if (spec.hidden) options.hidden = true
  if (spec.expireAfterSeconds !== null && spec.expireAfterSeconds !== undefined) {
    const ttl = Math.floor(spec.expireAfterSeconds)
    if (!(ttl >= 0)) throw new MongoUserError('El TTL debe ser un número de segundos (0 o más).')
    options.expireAfterSeconds = ttl
  }
  const partial = parseOptionalDocument(spec.partialFilter, 'Filtro parcial')
  if (partial) options.partialFilterExpression = partial
  const collation = parseOptionalDocument(spec.collation, 'Intercalación')
  if (collation) options.collation = collation
  try {
    return await conn.coll(database, collection).createIndex(keys, options)
  } catch (err) {
    throw conn.errorOf(err)
  }
}

export async function dropIndex(
  conn: MongoDriverConnection,
  database: string,
  collection: string,
  name: string
): Promise<void> {
  if (name === '_id_') throw new MongoUserError('El índice _id_ no se puede eliminar.')
  try {
    await conn.coll(database, collection).dropIndex(name)
  } catch (err) {
    throw conn.errorOf(err)
  }
}

export async function setValidator(
  conn: MongoDriverConnection,
  database: string,
  collection: string,
  input: MongoValidatorInput
): Promise<void> {
  const validator = parseOptionalDocument(input.validator, 'Validador') ?? {}
  if (!['off', 'strict', 'moderate'].includes(input.level))
    throw new MongoUserError('Nivel de validación no válido.')
  if (!['error', 'warn'].includes(input.action))
    throw new MongoUserError('Acción de validación no válida.')
  try {
    await conn.db(database).command({
      collMod: collection,
      validator,
      validationLevel: input.level,
      validationAction: input.action
    })
  } catch (err) {
    throw conn.errorOf(err)
  }
}

export async function createDatabase(
  conn: MongoDriverConnection,
  name: string,
  firstCollection: string
): Promise<void> {
  const db = name.trim()
  if (!db || /[/\\. "$*<>:|?]/.test(db))
    throw new MongoUserError(
      'Nombre de base de datos no válido (sin espacios ni / \\ . " $ * < > : | ?).'
    )
  // MongoDB creates a database with its first collection.
  await createCollection(conn, db, firstCollection || 'coleccion', {})
}

export async function dropDatabase(conn: MongoDriverConnection, name: string): Promise<void> {
  if (['admin', 'local', 'config'].includes(name))
    throw new MongoUserError(`La base de datos de sistema «${name}» no se elimina desde Vortaq.`)
  try {
    await conn.db(name).dropDatabase()
  } catch (err) {
    throw conn.errorOf(err)
  }
}
