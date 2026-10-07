import {
  STRUCTURE_ONLY_LABEL,
  describeObjectCounts,
  formatSize,
  labelLine,
  plural
} from '@shared/jobLog'
import type { BackupCreateResult, BackupMeta, ConnectionConfig, RestoreResult } from '@shared/types'
import { describeError } from '../../postgres/errors'
import type { BackupService } from '../index'
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
import type { PgSessionProvider } from './pgBackup'
import { createDatabase, databaseExists, restorePgBackup } from './pgRestore'

/**
 * REPLACE restore of a PostgreSQL database from a .vqb («Restaurar» with
 * «Reemplazar la base de datos», and the safety copy that undoes it):
 *
 *   1. verify the backup (password, engine, database name, full integrity
 *      read) — nothing is touched when it fails;
 *   2. if the database exists and the safety backup is on, back it up to
 *      .vqb (with the backup's password) — a failure stops here;
 *   3. in ONE transaction: drop every user schema of the database and
 *      restore every object. Any failure rolls the transaction back, so the
 *      database stays exactly as it was (unlike MySQL, there is no
 *      «incompleta» state unless «Continuar en caso de error» is on).
 *
 * A database that does not exist is created first (it stays, empty, when
 * the restore then fails).
 */

export interface PgReplaceDeps {
  connections: { get(id: string): ConnectionConfig | null }
  pg: PgSessionProvider
  guarded?: (connectionId: string) => boolean
  backups: Pick<BackupService, 'create' | 'readMeta' | 'verify'>
}

const sentence = (text: string): string =>
  /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`

export async function replacePgDatabase(
  deps: PgReplaceDeps,
  request: ReplaceRequest,
  hooks: ReplaceHooks = {},
  signal?: AbortSignal
): Promise<ReplaceResult> {
  if (!request?.backupPath) throw new Error('Falta el archivo de backup a restaurar.')
  if (!request.expectedSchema?.trim()) throw new Error('Falta la base de datos del backup.')
  if (!request.connectionId) throw new Error('Falta la conexión de destino.')
  const target = request.targetSchema?.trim()
  if (!target) throw new Error('Falta la base de datos de destino.')
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
    if (meta.format !== 'vqb' || meta.engine !== 'postgresql')
      throw new Error(engineMismatchMessage('mysql', 'postgresql'))
  } catch (err) {
    throw new Error(`${sentence(describeError(err))} ${keep}`)
  }
  say(`  Origen: ${request.backupPath}`)
  say(`  Contiene ${describeObjectCounts(meta.objects.map((o) => String(o.type)))}`)
  say(
    includeData
      ? '  Contenido: estructura y datos'
      : `  Contenido: ${STRUCTURE_ONLY_LABEL.toLowerCase()} (tablas vacías; las secuencias empiezan desde el principio)`
  )
  const integrityLabel = 'Comprobar integridad del backup'
  try {
    const checked = await deps.backups.verify(request.backupPath, signal, request.password)
    say(
      labelLine({
        label: integrityLabel,
        value: plural(checked.rows, 'fila', 'filas'),
        status: 'ok'
      })
    )
  } catch (err) {
    if (cancelled()) throw new Error(REPLACE_CANCELLED)
    const message = describeError(err)
    say(labelLine({ label: integrityLabel, status: 'error', error: message }))
    throw new Error(
      `${sentence(`No se puede usar el backup ${request.backupPath}: ${message}`)} ${keep}`
    )
  }
  if (cancelled()) throw new Error(REPLACE_CANCELLED)

  let existed: boolean
  try {
    const session = await deps.pg.acquire(request.connectionId, null)
    try {
      existed = await databaseExists(session, target)
    } finally {
      await session.release().catch(() => undefined)
    }
  } catch (err) {
    throw new Error(
      `${sentence(`No se pudo conectar con «${connection.name}»: ${describeError(err)}`)} ${keep}`
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
      const message = describeError(err)
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

  if (!existed) {
    try {
      await createDatabase(deps, request.connectionId, target)
      say(labelLine({ label: `Crear base de datos ${target}`, status: 'ok' }))
    } catch (err) {
      const message = describeError(err)
      say(labelLine({ label: `Crear base de datos ${target}`, status: 'error', error: message }))
      throw new Error(`${sentence(`No se pudo crear «${target}»: ${message}`)} ${keep}`)
    }
  }

  let restore: RestoreResult
  try {
    restore = await restorePgBackup(
      deps,
      {
        backupPath: request.backupPath,
        connectionId: request.connectionId,
        targetSchema: target,
        createSchema: false,
        dropObjectsFirst: false,
        includeStructure: true,
        includeData,
        ...(includeData ? {} : { skipAutoIncrement: true }),
        continueOnError: request.continueOnError,
        replaceAll: existed,
        ...(request.confirmProduction ? { confirmProduction: true } : {}),
        ...(request.password ? { password: request.password } : {})
      },
      (event) => hooks.progress?.('restore', event),
      signal
    )
  } catch (err) {
    const reason = cancelled() ? REPLACE_CANCELLED : describeError(err)
    const state = existed
      ? keep
      : `«${target}» se ha creado vacía en «${connection.name}»: vuelve a restaurar la copia para llenarla.`
    throw new Error(`${sentence(reason)} ${state}`)
  }
  return {
    existed,
    connectionName: connection.name,
    safetyBackup: safety,
    charset: null,
    includeData,
    restore: includeData ? restore : { ...restore, structureOnly: true }
  }
}
