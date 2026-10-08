/**
 * Document edits by `_id` (docs/multi-engine-design.md, 9.2).
 *
 * - Updates are `$set`/`$unset` of dotted paths with an optimistic check: the
 *   filter repeats the original value of every edited path, so a document
 *   changed since it was loaded matches nothing and is reported.
 * - A whole-document replace is refused unless the document was fetched whole
 *   (replacing a projected document would delete every field not shown), and
 *   it is refused when the stored document no longer equals the one loaded.
 * - The `_id` filter keeps the id's BSON type (ObjectId, string, Long, UUID…).
 * - Replica sets and sharded clusters apply a batch in one transaction;
 *   standalone servers apply the changes one by one and stop at the first
 *   failure, reporting which one.
 */
import type { ClientSession, Collection, Document } from 'mongodb'
import type { MongoApplyResult, MongoDocumentChange } from '@shared/types'
import { isUnaddressableKey } from '@shared/mongo/shellFormat'
import { collectionInfo } from './admin'
import type { MongoDriverConnection } from './connection'
import { MongoServerSideError, MongoUserError, describeError, toServerError } from './errors'
import { canonical, parseCanonicalValue, parseUserDocument } from './values'

export const CHANGED_SINCE_LOADED =
  'El documento ha cambiado (o se borró) desde que se cargó: recarga y repite el cambio'

const KIND_LABEL: Record<MongoDocumentChange['kind'], string> = {
  insert: 'documento nuevo',
  update: 'documento modificado',
  replace: 'documento reemplazado',
  delete: 'documento eliminado'
}

/** A dotted path the server can address: no empty segment, no `$` segment. */
export function checkPath(path: string): string {
  const parts = path.split('.')
  if (!path || parts.some((p) => isUnaddressableKey(p)))
    throw new MongoUserError(
      `El campo «${path}» no se puede editar por ruta: edita el documento completo.`
    )
  if (parts[0] === '_id')
    throw new MongoUserError('El _id no se puede cambiar: duplica el documento para crear otro.')
  return path
}

interface Prepared {
  run(
    coll: Collection<Document>,
    session: ClientSession | undefined,
    raw: Collection<Document>
  ): Promise<string | null>
}

function prepare(change: MongoDocumentChange): Prepared {
  switch (change.kind) {
    case 'insert': {
      const doc = parseUserDocument(change.doc, 'Documento')
      return {
        async run(coll, session) {
          const r = await coll.insertOne(doc, { session })
          return canonical(r.insertedId)
        }
      }
    }
    case 'delete': {
      const id = parseCanonicalValue(change.id, '_id')
      return {
        async run(coll, session) {
          const r = await coll.deleteOne({ _id: id } as Document, { session })
          if (r.deletedCount !== 1) throw new MongoUserError(CHANGED_SINCE_LOADED)
          return null
        }
      }
    }
    case 'update': {
      const id = parseCanonicalValue(change.id, '_id')
      const filter: Document = { _id: id }
      const $set: Document = {}
      const $unset: Document = {}
      for (const [path, value] of Object.entries(change.set ?? {}))
        $set[checkPath(path)] = parseCanonicalValue(value, `Valor de «${path}»`)
      for (const path of change.unset ?? []) $unset[checkPath(path)] = ''
      for (const [path, value] of Object.entries(change.expected ?? {}))
        filter[checkPath(path)] = parseCanonicalValue(value, `Valor original de «${path}»`)
      for (const path of Object.keys($set))
        if (path in $unset)
          throw new MongoUserError(`El campo «${path}» se asigna y se quita a la vez.`)
      const update: Document = {}
      if (Object.keys($set).length) update.$set = $set
      if (Object.keys($unset).length) update.$unset = $unset
      if (!Object.keys(update).length)
        throw new MongoUserError('El cambio no modifica ningún campo.')
      return {
        async run(coll, session) {
          const r = await coll.updateOne(filter, update, { session })
          if (r.matchedCount !== 1) throw new MongoUserError(CHANGED_SINCE_LOADED)
          return null
        }
      }
    }
    case 'replace': {
      if ((change as { fetchedWhole?: unknown }).fetchedWhole !== true)
        throw new MongoUserError(
          'Solo se puede reemplazar un documento cargado completo (sin proyección): recarga el documento entero antes de editarlo.'
        )
      const id = parseCanonicalValue(change.id, '_id')
      const doc = parseUserDocument(change.doc, 'Documento')
      if (doc._id !== undefined && canonical({ v: doc._id }) !== canonical({ v: id }))
        throw new MongoUserError(
          'El _id no se puede cambiar: duplica el documento para crear otro.'
        )
      const { _id: _ignored, ...replacement } = doc
      void _ignored
      return {
        async run(coll, session, raw) {
          if (change.original !== undefined) {
            // Read raw, like the grid did, so the canonical texts compare exactly.
            const current = await raw.findOne({ _id: id } as Document, { session })
            if (!current || canonical(current) !== change.original)
              throw new MongoUserError(CHANGED_SINCE_LOADED)
          }
          const r = await coll.replaceOne({ _id: id } as Document, replacement, { session })
          if (r.matchedCount !== 1) throw new MongoUserError(CHANGED_SINCE_LOADED)
          return null
        }
      }
    }
    default:
      throw new MongoUserError('Tipo de cambio desconocido.')
  }
}

function failureText(
  index: number,
  total: number,
  change: MongoDocumentChange,
  err: unknown
): string {
  const reason = describeError(err instanceof MongoUserError ? err : toServerError(err))
  return `Falló el cambio ${index + 1} de ${total} (${KIND_LABEL[change.kind]}): ${reason.replace(/\.$/, '')}`
}

/** mongo:applyChanges (the IPC layer checks the production guard first). */
export async function applyDocumentChanges(
  conn: MongoDriverConnection,
  database: string,
  collection: string,
  changes: MongoDocumentChange[]
): Promise<MongoApplyResult> {
  if (!changes.length) return { applied: 0, atomic: false, insertedIds: [], failure: null }
  const info = await collectionInfo(conn, database, collection)
  if (info?.readOnlyReason) throw new MongoUserError(info.readOnlyReason)
  // Parse everything before writing anything: a typo in change 3 must not leave 1 and 2 applied.
  const prepared = changes.map((change, i) => {
    try {
      return prepare(change)
    } catch (err) {
      throw new MongoServerSideError(
        failureText(i, changes.length, change, err),
        'E_MONGO_CHANGE',
        'MongoChange'
      )
    }
  })
  const coll = conn.coll(database, collection)
  const raw = conn.rawColl(database, collection)
  const insertedIds: (string | null)[] = changes.map(() => null)

  if (conn.transactions) {
    const session = conn.client.startSession()
    try {
      await session.withTransaction(async () => {
        for (let i = 0; i < prepared.length; i++) {
          try {
            insertedIds[i] = await prepared[i].run(coll, session, raw)
          } catch (err) {
            throw new MongoServerSideError(
              `${failureText(i, changes.length, changes[i], err)}. No se aplicó ningún cambio: se deshicieron todos.`,
              'E_MONGO_CHANGE',
              'MongoChange'
            )
          }
        }
      })
    } finally {
      await session.endSession().catch(() => undefined)
    }
    return { applied: changes.length, atomic: true, insertedIds, failure: null }
  }

  for (let i = 0; i < prepared.length; i++) {
    try {
      insertedIds[i] = await prepared[i].run(coll, undefined, raw)
    } catch (err) {
      const later = changes.length - i - 1
      return {
        applied: i,
        atomic: false,
        insertedIds,
        failure: {
          index: i,
          message: `${failureText(i, changes.length, changes[i], err)}. Se aplicaron ${i} cambio(s) anteriores${later ? ` y no se enviaron los ${later} siguientes` : ''} (servidor independiente: sin transacción).`
        }
      }
    }
  }
  return { applied: changes.length, atomic: false, insertedIds, failure: null }
}
