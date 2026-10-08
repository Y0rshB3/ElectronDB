/**
 * mongo:* channels and the db:* channels MongoDB shares (databases, drop,
 * create database, tab sessions, cancel). ipc/db.ts routes MongoDB
 * connections here.
 *
 * Every write checks the production guard in main (CLAUDE.md): document
 * changes, collection and index DDL, validators, COMMIT, and query-tab
 * scripts whose parsed statements write (an aggregate with $out/$merge
 * included, decided from the parsed pipeline, not only from its text).
 */
import type { IpcArgs, IpcChannel, IpcResult } from '@shared/ipc'
import type { NameRef, TabSessionState, WriteOptions } from '@shared/types'
import type { AppContext } from '../context'
import type { ConnectionManager } from '../db/manager'
import * as admin from '../mongo/admin'
import { applyDocumentChanges } from '../mongo/changes'
import { isMongoConnection, type MongoDriverConnection } from '../mongo/connection'
import { documentById, findPage, getMore, sampleFields } from '../mongo/documents'
import { MongoUserError } from '../mongo/errors'
import { prepareMongoScript, runPreparedScript } from '../mongo/run'
import { assertProductionWriteConfirmed } from './productionGuard'

type H<C extends IpcChannel> = (...args: IpcArgs<C>) => Promise<IpcResult<C>>

export interface MongoDbHandlers {
  databases: H<'db:databases'>
  objects: H<'db:objects'>
  dropObject: H<'db:dropObject'>
  createDatabase: (
    id: string,
    name: string,
    options?: WriteOptions,
    engineOptions?: Record<string, string>
  ) => Promise<void>
  dropDatabase: H<'db:dropDatabase'>
  cancel: H<'db:cancel'>
  sessionState: H<'db:sessionState'>
  commit: H<'db:commit'>
  rollback: H<'db:rollback'>
  closeSession: H<'db:closeSession'>
}

/** The mongo:* channels. */
export type MongoChannel = Extract<IpcChannel, `mongo:${string}`>
export type MongoChannelHandlers = { [C in MongoChannel]: H<C> }

export const MONGO_REFUSED = {
  notAvailable:
    'Esta operación no existe en las conexiones MongoDB: usa la vista de documentos o una consulta.',
  onlyMongo: 'Esta operación solo existe en las conexiones MongoDB.'
} as const

/** Most documents a query-tab result keeps before «Cargar más». */
const MAX_DOCS_CAP = 5000

function nameOf(name: NameRef): string {
  return typeof name === 'string' ? name : name.name
}

function database(ref: unknown): string {
  if (typeof ref !== 'string' || !ref)
    throw new MongoUserError('Las conexiones MongoDB usan el nombre de la base de datos.')
  return ref
}

export function createMongoHandlers(
  ctx: AppContext,
  manager: ConnectionManager
): MongoDbHandlers & { channels: MongoChannelHandlers } {
  const connectionOf = async (id: string): Promise<MongoDriverConnection> => {
    const connection = await manager.connection(id)
    if (!isMongoConnection(connection))
      throw new MongoUserError(MONGO_REFUSED.onlyMongo, 'E_MONGO_ENGINE')
    return connection
  }
  const guard = (
    id: string,
    options: { confirmProduction?: boolean } | undefined,
    action: string
  ): void => assertProductionWriteConfirmed(ctx, id, options, action)

  /* ---------- mongo:* ---------- */

  const channels: MongoChannelHandlers = {
    'mongo:collections': async (id, db) =>
      admin.listCollectionInfos(await connectionOf(id), database(db)),
    'mongo:collectionDetails': async (id, db, coll) =>
      admin.collectionDetails(await connectionOf(id), database(db), coll),
    'mongo:find': async (id, query) =>
      findPage(await connectionOf(id), query, `browser:${query.owner ?? ''}`),
    'mongo:getMore': async (id, resultId, count) =>
      getMore(await connectionOf(id), resultId, count),
    'mongo:closeCursor': async (id, resultId) => {
      if (!manager.isOpen(id)) return
      await (await connectionOf(id)).closeCursor(resultId)
    },
    'mongo:document': async (id, db, coll, docId) =>
      documentById(await connectionOf(id), database(db), coll, docId),
    'mongo:applyChanges': async (id, db, coll, changes, options) => {
      if (changes.length) guard(id, options, `Modificar documentos de «${coll}»`)
      return applyDocumentChanges(await connectionOf(id), database(db), coll, changes)
    },
    'mongo:sampleFields': async (id, db, coll, size) =>
      sampleFields(await connectionOf(id), database(db), coll, size),
    'mongo:execute': async (id, script, options) => {
      // Parse everything (and decide what writes) before anything runs.
      const prepared = prepareMongoScript(script)
      if (prepared.some((p) => p.writes)) guard(id, options, 'Ejecutar órdenes que modifican datos')
      const conn = await connectionOf(id)
      const limit = Number(options.maxDocs) || ctx.settings.get().defaultRowLimit || 1000
      return runPreparedScript(conn, prepared, options, {
        maxDocs: Math.max(1, Math.min(limit, MAX_DOCS_CAP)),
        owner: options.sessionKey ?? 'query'
      })
    },
    'mongo:beginTransaction': async (id, key) => (await connectionOf(id)).beginTransaction(key),
    'mongo:createCollection': async (id, db, name, options, writeOptions) => {
      guard(id, writeOptions, `Crear la colección «${name}»`)
      await admin.createCollection(await connectionOf(id), database(db), name, options ?? {})
    },
    'mongo:renameCollection': async (id, db, from, to, writeOptions) => {
      guard(id, writeOptions, `Renombrar la colección «${from}»`)
      await admin.renameCollection(await connectionOf(id), database(db), from, to)
    },
    'mongo:duplicateCollection': async (id, db, source, target, includeDocuments, writeOptions) => {
      guard(id, writeOptions, `Duplicar la colección «${source}»`)
      return admin.duplicateCollection(
        await connectionOf(id),
        database(db),
        source,
        target,
        includeDocuments === true
      )
    },
    'mongo:clearCollection': async (id, db, coll, writeOptions) => {
      guard(id, writeOptions, `Vaciar la colección «${coll}»`)
      return admin.clearCollection(await connectionOf(id), database(db), coll)
    },
    'mongo:countDocuments': async (id, db, coll) =>
      admin.countExact(await connectionOf(id), database(db), coll),
    'mongo:createIndex': async (id, db, coll, spec, writeOptions) => {
      guard(id, writeOptions, `Crear un índice en «${coll}»`)
      return admin.createIndex(await connectionOf(id), database(db), coll, spec)
    },
    'mongo:dropIndex': async (id, db, coll, name, writeOptions) => {
      guard(id, writeOptions, `Eliminar el índice «${name}»`)
      await admin.dropIndex(await connectionOf(id), database(db), coll, name)
    },
    'mongo:setValidator': async (id, db, coll, input, writeOptions) => {
      guard(id, writeOptions, `Cambiar el validador de «${coll}»`)
      await admin.setValidator(await connectionOf(id), database(db), coll, input)
    }
  }

  /* ---------- shared db:* channels ---------- */

  const closedState = (): TabSessionState => ({
    open: false,
    transactionStatus: 'idle',
    effectiveSchema: null,
    database: null
  })

  return {
    channels,
    databases: async (id) => admin.listDatabases(await connectionOf(id)),
    objects: async (id, ref, type) => {
      if (type !== 'index') throw new MongoUserError(MONGO_REFUSED.notAvailable, 'E_CAPABILITY')
      return admin.listDatabaseIndexes(await connectionOf(id), database(ref))
    },
    dropObject: async (id, ref, type, name, options) => {
      const db = database(ref)
      const objectName = nameOf(name)
      guard(id, options, `Eliminar ${objectName}`)
      const conn = await connectionOf(id)
      if (type === 'collection' || type === 'view' || type === 'table')
        return admin.dropCollection(conn, db, objectName)
      if (type === 'index') {
        const table = typeof name === 'string' ? undefined : name.table
        if (!table) throw new MongoUserError('Falta la colección del índice.')
        // Tree index nodes are named «<colección>.<índice>».
        const indexName = objectName.startsWith(`${table}.`)
          ? objectName.slice(table.length + 1)
          : objectName
        return admin.dropIndex(conn, db, table, indexName)
      }
      throw new MongoUserError(MONGO_REFUSED.notAvailable, 'E_CAPABILITY')
    },
    createDatabase: async (id, name, options, engineOptions) => {
      guard(id, options, `Crear la base de datos ${name}`)
      await admin.createDatabase(await connectionOf(id), name, engineOptions?.collection ?? '')
    },
    dropDatabase: async (id, name, options) => {
      guard(id, options, `Eliminar la base de datos ${name}`)
      await admin.dropDatabase(await connectionOf(id), name)
    },
    cancel: async (id, executionId) => {
      if (!manager.isOpen(id)) return false
      return (await connectionOf(id)).cancel(executionId)
    },
    sessionState: async (id, key) => {
      if (!manager.isOpen(id)) return closedState()
      return (await connectionOf(id)).sessionState(key)
    },
    commit: async (id, key, options) => {
      guard(id, options, 'Confirmar la transacción (commitTransaction)')
      return (await connectionOf(id)).endTransaction(key, 'commit')
    },
    rollback: async (id, key) => (await connectionOf(id)).endTransaction(key, 'abort'),
    closeSession: async (id, key) => {
      if (!manager.isOpen(id)) return
      await (await connectionOf(id)).closeTab(key)
    }
  }
}
