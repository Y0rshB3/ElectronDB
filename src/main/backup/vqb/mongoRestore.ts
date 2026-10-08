/**
 * Restores a MongoDB .vqb into a database of a MongoDB connection (same
 * engine only), and the REPLACE flow that empties the database first.
 *
 * Order: collections (created with their options: capped, validator,
 * time-series…), their documents (insertMany in batches, validation bypassed
 * so the documents come back exactly as they were), their indexes, then views.
 * Documents are parsed from canonical Extended JSON, so every BSON type is
 * kept. MongoDB has no transactional DDL: a failed restore stops (unless
 * «Continuar en caso de error») and leaves what was already restored; REPLACE
 * takes a safety copy first.
 */
import { performance } from 'node:perf_hooks'
import { EJSON, type Document } from 'bson'
import {
  STRUCTURE_ONLY_LABEL,
  describeObjectCounts,
  formatSize,
  labelLine,
  plural
} from '@shared/jobLog'
import type {
  BackupCreateResult,
  BackupMeta,
  ConnectionConfig,
  RestoreOptions,
  RestoreResult
} from '@shared/types'
import { describeError, toServerError } from '../../mongo/errors'
import type { BackupService } from '../index'
import { PRODUCTION_GUARD_MESSAGE, RESTORE_CANCELLED } from '../restore'
import {
  REPLACE_CANCELLED,
  REPLACE_PRODUCTION_MESSAGE,
  SAFETY_LABEL,
  verifyBackupSource,
  type ReplaceHooks,
  type ReplaceRequest,
  type ReplaceResult
} from '../replace'
import { engineMismatchMessage } from './engine'
import type { VqbManifestObject, VqbObjectMeta } from './format'
import type { MongoConnectionProvider } from './mongoBackup'
import { VqbReader } from './reader'
import type { VqbValue } from './values'

export interface MongoRestoreDeps {
  connections: { get(id: string): ConnectionConfig | null }
  mongo: MongoConnectionProvider
}

const BATCH_DOCS = 1000
const BATCH_BYTES = 8 * 1024 * 1024
const SYSTEM_DATABASES = new Set(['admin', 'local', 'config'])

interface Item {
  object: VqbManifestObject
  meta: VqbObjectMeta
  command: Document
}

const errorText = (err: unknown): string => describeError(toServerError(err))

function validate(options: RestoreOptions): void {
  if (!options || typeof options !== 'object')
    throw new Error('Opciones de restauración no válidas.')
  if (!options.backupPath) throw new Error('Selecciona el archivo de backup a restaurar.')
  if (!options.connectionId) throw new Error('Selecciona la conexión de destino.')
  const db = options.targetSchema?.trim()
  if (!db) throw new Error('Indica la base de datos de destino.')
  if (SYSTEM_DATABASES.has(db))
    throw new Error(`«${db}» es una base de datos del sistema y nunca se restaura sobre ella.`)
  if (/[/\\. "$*<>:|?]/.test(db))
    throw new Error(
      'Nombre de base de datos de destino no válido (sin espacios ni / \\ . " $ * < > : | ?).'
    )
  if (!options.includeStructure && !options.includeData)
    throw new Error('Elige restaurar la estructura, los datos o ambos.')
}

/** A document of a data file: one `$json` value with canonical Extended JSON. */
export function documentOf(row: VqbValue[]): Document {
  const cell = row[0]
  if (!cell || typeof cell !== 'object' || !('$json' in cell))
    throw new Error('La copia no contiene documentos de MongoDB válidos.')
  return EJSON.parse((cell as { $json: string }).$json, { relaxed: false }) as Document
}

export async function restoreMongoBackup(
  deps: MongoRestoreDeps,
  options: RestoreOptions,
  progress: (event: Parameters<NonNullable<ReplaceHooks['progress']>>[1]) => void = () => {},
  signal?: AbortSignal
): Promise<RestoreResult> {
  validate(options)
  const connection = deps.connections.get(options.connectionId)
  if (!connection) throw new Error('La conexión de destino ya no existe.')
  if (connection.environment === 'production' && options.confirmProduction !== true)
    throw new Error(PRODUCTION_GUARD_MESSAGE)
  const started = performance.now()
  const cancelled = (): boolean => signal?.aborted === true
  if (cancelled()) throw new Error(RESTORE_CANCELLED)
  const database = options.targetSchema.trim()

  const reader = await VqbReader.open(options.backupPath, options.password)
  try {
    await reader.unlock(options.password)
    const manifest = await reader.manifest()
    if (manifest.engine.id !== 'mongodb')
      throw new Error(engineMismatchMessage(manifest.engine.id, 'mongodb'))
    const wanted = (options.objects ?? []).filter(Boolean)
    const items: Item[] = []
    for (const object of manifest.objects) {
      if (wanted.length && !wanted.includes(object.name)) continue
      const meta = await reader.objectMeta(object.id)
      const command = EJSON.parse(await reader.ddl(meta), { relaxed: false }) as Document
      items.push({ object, meta, command })
    }
    const conn = await deps.mongo.connection(options.connectionId)
    const db = conn.db(database)
    const existing = new Set(
      (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => String(c.name))
    )
    const errors: RestoreResult['errors'] = []
    let restored = 0
    let inserted = 0
    const ordered = [
      ...items.filter((i) => i.object.type === 'collection'),
      ...items.filter((i) => i.object.type === 'view')
    ]
    const total = ordered.length
    progress({
      phase: 'list',
      current: 0,
      total,
      message: describeObjectCounts(
        ordered.map((i) => (i.object.type === 'view' ? 'View' : 'Collection'))
      ),
      done: false
    })
    for (let n = 0; n < ordered.length; n++) {
      if (cancelled()) throw new Error(RESTORE_CANCELLED)
      const { object, meta, command } = ordered[n]
      const isView = object.type === 'view'
      const label = `${isView ? 'vista' : 'colección'} ${object.name}`
      progress({ phase: 'object', current: n, total, message: `Restaurando ${label}`, done: false })
      try {
        const { create: _create, ...createOptions } = command
        void _create
        if (options.dropObjectsFirst && existing.has(object.name)) {
          await db.dropCollection(object.name).catch(() => undefined)
          existing.delete(object.name)
        }
        if (isView) {
          if (options.includeStructure) {
            await db.createCollection(object.name, createOptions)
            existing.add(object.name)
          }
        } else {
          if (options.includeStructure) {
            if (existing.has(object.name))
              throw new Error(
                `La colección ${object.name} ya existe: marca «Eliminar objetos antes de crearlos» o restaura solo los datos.`
              )
            await db.createCollection(object.name, createOptions)
            existing.add(object.name)
          }
          if (options.includeData) {
            const coll = db.collection(object.name)
            let batch: Document[] = []
            let bytes = 0
            const flush = async (): Promise<void> => {
              if (!batch.length) return
              await coll.insertMany(batch, { ordered: true, bypassDocumentValidation: true })
              inserted += batch.length
              batch = []
              bytes = 0
            }
            await reader.rows(
              meta,
              async (row) => {
                const cell = row[0] as { $json?: string } | null
                bytes += cell?.$json?.length ?? 16
                batch.push(documentOf(row))
                if (batch.length >= BATCH_DOCS || bytes >= BATCH_BYTES) await flush()
              },
              signal
            )
            await flush()
          }
          if (options.includeStructure && meta.indexes?.length) {
            const specs = meta.indexes.map(
              (text) => EJSON.parse(text, { relaxed: false }) as Document
            )
            await db
              .collection(object.name)
              .createIndexes(specs.map(({ key, ...rest }) => ({ key, ...rest })) as never)
          }
        }
        restored++
        progress({
          phase: 'objectDone',
          current: n + 1,
          total,
          message: `${label} restaurada`,
          done: false
        })
      } catch (err) {
        if (cancelled()) throw new Error(RESTORE_CANCELLED)
        const message =
          err instanceof Error && !(err as { code?: unknown }).code ? err.message : errorText(err)
        errors.push({ object: object.name, message })
        progress({
          phase: 'objectError',
          current: n,
          total,
          message: `Error al restaurar ${label}`,
          done: false
        })
        if (!options.continueOnError) break
      }
    }
    return {
      objectsRestored: restored,
      rowsInserted: inserted,
      errors,
      durationMs: Math.round(performance.now() - started)
    }
  } finally {
    await reader.close().catch(() => undefined)
  }
}

export interface MongoReplaceDeps extends MongoRestoreDeps {
  backups: Pick<BackupService, 'create' | 'readMeta' | 'verify'>
}

const sentence = (text: string): string =>
  /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`

/**
 * REPLACE restore of a MongoDB database from a .vqb:
 *
 *   1. verify the backup (password, engine, database name, full integrity
 *      read) — nothing is touched when it fails;
 *   2. if the database exists and the safety backup is on, back it up to
 *      .vqb (with the backup's password) — a failure stops here;
 *   3. drop the database and restore every object into it. MongoDB has no
 *      transactional DDL, so a failure here leaves the database incomplete:
 *      the message points to the safety copy that undoes it.
 */
export async function replaceMongoDatabase(
  deps: MongoReplaceDeps,
  request: ReplaceRequest,
  hooks: ReplaceHooks = {},
  signal?: AbortSignal
): Promise<ReplaceResult> {
  if (!request?.backupPath) throw new Error('Falta el archivo de backup a restaurar.')
  if (!request.expectedSchema?.trim()) throw new Error('Falta la base de datos del backup.')
  if (!request.connectionId) throw new Error('Falta la conexión de destino.')
  const target = request.targetSchema?.trim()
  if (!target) throw new Error('Falta la base de datos de destino.')
  if (SYSTEM_DATABASES.has(target))
    throw new Error(`«${target}» es una base de datos del sistema y nunca se reemplaza.`)
  const say = (body: string): void => hooks.line?.(body)
  const cancelled = (): boolean => signal?.aborted === true
  const connection = deps.connections.get(request.connectionId)
  if (!connection) throw new Error('La conexión de destino ya no existe.')
  if (connection.environment === 'production' && request.confirmProduction !== true)
    throw new Error(REPLACE_PRODUCTION_MESSAGE)
  const keep = `«${target}» no se ha modificado en «${connection.name}».`
  const includeData = request.includeData !== false

  let meta: BackupMeta
  try {
    meta = await verifyBackupSource(
      deps.backups,
      request.backupPath,
      request.expectedSchema,
      request.password
    )
    if (meta.format !== 'vqb' || meta.engine !== 'mongodb')
      throw new Error(
        engineMismatchMessage(
          meta.engine === 'postgresql' || meta.engine === 'sqlite' ? meta.engine : 'mysql',
          'mongodb'
        )
      )
  } catch (err) {
    throw new Error(`${sentence(err instanceof Error ? err.message : String(err))} ${keep}`)
  }
  say(`  Origen: ${request.backupPath}`)
  say(`  Contiene ${describeObjectCounts(meta.objects.map((o) => String(o.type)))}`)
  say(
    includeData
      ? '  Contenido: estructura y datos'
      : `  Contenido: ${STRUCTURE_ONLY_LABEL.toLowerCase()}`
  )
  const integrityLabel = 'Comprobar integridad del backup'
  try {
    const checked = await deps.backups.verify(request.backupPath, signal, request.password)
    say(
      labelLine({
        label: integrityLabel,
        value: plural(checked.rows, 'documento', 'documentos'),
        status: 'ok'
      })
    )
  } catch (err) {
    if (cancelled()) throw new Error(REPLACE_CANCELLED)
    const message = err instanceof Error ? err.message : String(err)
    say(labelLine({ label: integrityLabel, status: 'error', error: message }))
    throw new Error(
      `${sentence(`No se puede usar el backup ${request.backupPath}: ${message}`)} ${keep}`
    )
  }
  if (cancelled()) throw new Error(REPLACE_CANCELLED)

  let existed: boolean
  let conn
  try {
    conn = await deps.mongo.connection(request.connectionId)
    const list = await conn.client
      .db('admin')
      .admin()
      .listDatabases({ nameOnly: true, authorizedDatabases: true })
    existed = list.databases.some((d) => d.name === target)
  } catch (err) {
    throw new Error(
      `${sentence(`No se pudo conectar con «${connection.name}»: ${errorText(err)}`)} ${keep}`
    )
  }

  let safety: BackupCreateResult | null = null
  if (!existed) say(`  «${target}» no existe en ${connection.name}: se creará`)
  else if (!request.safetyBackup)
    say(`  Copia previa desactivada: «${target}» se reemplaza sin copia`)
  else {
    const label = `Copia previa de ${target}`
    try {
      safety = await deps.backups.create(
        {
          connectionId: request.connectionId,
          schema: target,
          includeData: true,
          label: SAFETY_LABEL,
          comment: `Copia automática antes de restaurar ${request.backupPath}`,
          format: 'vqb',
          ...(request.password && meta.encrypted ? { password: request.password } : {})
        },
        (event) => hooks.progress?.('safety', event),
        signal
      )
    } catch (err) {
      if (cancelled()) throw new Error(REPLACE_CANCELLED)
      const message = err instanceof Error ? err.message : String(err)
      say(labelLine({ label, status: 'error', error: message }))
      throw new Error(
        `${sentence(`No se pudo hacer la copia de seguridad previa de «${target}»: ${message}`)} ${keep}`
      )
    }
    hooks.safetyBackupDone?.(safety)
    say(
      labelLine({
        label,
        value: `${plural(safety.objects, 'objeto', 'objetos')} · ${formatSize(safety.sizeBytes)}`,
        status: 'ok'
      })
    )
    say(`  Copia previa: ${safety.path}`)
  }
  if (cancelled()) throw new Error(REPLACE_CANCELLED)

  const incomplete = safety
    ? `«${target}» ha quedado incompleta en «${connection.name}»: la copia previa (${safety.path}) la deja como estaba.`
    : `«${target}» ha quedado incompleta en «${connection.name}».`
  if (existed) {
    try {
      await conn.db(target).dropDatabase()
      say(labelLine({ label: `Vaciar base de datos ${target}`, status: 'ok' }))
    } catch (err) {
      const message = errorText(err)
      say(labelLine({ label: `Vaciar base de datos ${target}`, status: 'error', error: message }))
      throw new Error(`${sentence(`No se pudo vaciar «${target}»: ${message}`)} ${keep}`)
    }
  }
  let restore: RestoreResult
  try {
    restore = await restoreMongoBackup(
      deps,
      {
        backupPath: request.backupPath,
        connectionId: request.connectionId,
        targetSchema: target,
        createSchema: true,
        dropObjectsFirst: false,
        includeStructure: true,
        includeData,
        continueOnError: request.continueOnError,
        ...(request.confirmProduction ? { confirmProduction: true } : {}),
        ...(request.password ? { password: request.password } : {})
      },
      (event) => hooks.progress?.('restore', event),
      signal
    )
  } catch (err) {
    const reason = cancelled()
      ? REPLACE_CANCELLED
      : err instanceof Error
        ? err.message
        : String(err)
    throw new Error(`${sentence(reason)} ${existed ? incomplete : ''}`.trim())
  }
  if (restore.errors.length && !request.continueOnError)
    throw new Error(
      `${sentence(`${restore.errors[0].object}: ${restore.errors[0].message}`)} ${incomplete}`
    )
  return {
    existed,
    connectionName: connection.name,
    safetyBackup: safety,
    charset: null,
    includeData,
    restore: includeData ? restore : { ...restore, structureOnly: true }
  }
}
