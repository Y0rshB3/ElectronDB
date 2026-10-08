import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  STRUCTURE_ONLY_LABEL,
  describeObjectCounts,
  formatSize,
  labelLine,
  plural
} from '@shared/jobLog'
import type { BackupCreateResult, BackupMeta, ConnectionConfig, RestoreResult } from '@shared/types'
import { describeError } from '../../sqlite/errors'
import { sqliteOf } from '../../sqlite/connection'
import { uniqueTarget } from '../create'
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
import type { VqbEngine } from './format'
import { restoreSqliteBackup, type SqliteRestoreDeps } from './sqliteRestore'

/**
 * REPLACE restore of a SQLite database from a .vqb:
 *
 *   1. verify the backup (password, engine, database alias, full integrity
 *      read) — nothing is touched when it fails;
 *   2. with the safety copy on, copy the current file with VACUUM INTO into
 *      the connection's backup folder (next to the database file when the
 *      connection has none) — a failure stops here;
 *   3. in ONE transaction (foreign_keys off): drop every user object of the
 *      database and restore every object; any failure rolls it back.
 */

export interface SqliteReplaceDeps extends SqliteRestoreDeps {
  backups: Pick<BackupService, 'readMeta' | 'verify'>
  now?: () => Date
}

const sentence = (text: string): string =>
  /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`

/** Folder of the VACUUM INTO safety copy of `config`'s database `db`. */
export function safetyCopyDir(config: ConnectionConfig, db: string): string {
  return config.backupDir ? join(config.backupDir, db) : dirname(sqliteOf(config).filePath)
}

export async function replaceSqliteDatabase(
  deps: SqliteReplaceDeps,
  request: ReplaceRequest,
  hooks: ReplaceHooks = {},
  signal?: AbortSignal
): Promise<ReplaceResult> {
  if (!request?.backupPath) throw new Error('Falta el archivo de la copia a restaurar.')
  if (!request.connectionId) throw new Error('Falta la conexión de destino.')
  const target = request.targetSchema?.trim() || 'main'
  const say = (body: string): void => hooks.line?.(body)
  const cancelled = (): boolean => signal?.aborted === true
  const config = deps.connections.get(request.connectionId)
  if (!config) throw new Error('La conexión de destino ya no existe.')
  if (config.environment === 'production' && request.confirmProduction !== true)
    throw new Error(REPLACE_PRODUCTION_MESSAGE)
  const keep = `«${target}» no se ha modificado en «${config.name}».`
  const includeData = request.includeData !== false

  let meta: BackupMeta
  try {
    meta = await verifyBackupSource(
      deps.backups,
      request.backupPath,
      request.expectedSchema,
      request.password
    )
    if (meta.format !== 'vqb' || meta.engine !== 'sqlite')
      throw new Error(
        engineMismatchMessage(
          meta.format === 'vqb' ? ((meta.engine as VqbEngine) ?? 'mysql') : 'mysql',
          'sqlite'
        )
      )
  } catch (err) {
    throw new Error(`${sentence(describeError(err))} ${keep}`)
  }
  say(`  Origen: ${request.backupPath}`)
  say(`  Contiene ${describeObjectCounts(meta.objects.map((o) => String(o.type)))}`)
  say(
    includeData
      ? '  Contenido: estructura y datos'
      : `  Contenido: ${STRUCTURE_ONLY_LABEL.toLowerCase()} (tablas vacías)`
  )
  try {
    const checked = await deps.backups.verify(request.backupPath, signal, request.password)
    say(
      labelLine({
        label: 'Comprobar integridad de la copia',
        value: plural(checked.rows, 'fila', 'filas'),
        status: 'ok'
      })
    )
  } catch (err) {
    if (cancelled()) throw new Error(REPLACE_CANCELLED)
    throw new Error(
      `${sentence(`No se puede usar la copia ${request.backupPath}: ${describeError(err)}`)} ${keep}`
    )
  }
  if (cancelled()) throw new Error(REPLACE_CANCELLED)

  let safety: BackupCreateResult | null = null
  if (!request.safetyBackup) say(`  Copia previa desactivada: «${target}» se reemplaza sin copia`)
  else {
    const label = `Copia previa de ${target}`
    try {
      const connection = await deps.sqlite.connection(request.connectionId)
      const dir = safetyCopyDir(config, target)
      await mkdir(dir, { recursive: true })
      const path = await uniqueTarget(dir, (deps.now ?? (() => new Date()))(), SAFETY_LABEL, '.db')
      const started = performance.now()
      const copy = await connection.vacuumInto(path, target)
      safety = {
        path,
        sizeBytes: copy.sizeBytes,
        objects: meta.objects.length,
        rows: 0,
        durationMs: Math.round(performance.now() - started)
      }
    } catch (err) {
      if (cancelled()) throw new Error(REPLACE_CANCELLED)
      const message = describeError(err)
      say(labelLine({ label, status: 'error', error: message }))
      throw new Error(
        `${sentence(`No se pudo hacer la copia previa de «${target}»: ${message}`)} ${keep}`
      )
    }
    hooks.safetyBackupDone?.(safety)
    say(labelLine({ label, value: formatSize(safety.sizeBytes), status: 'ok' }))
    say(`  Copia previa (archivo SQLite): ${safety.path}`)
  }
  if (cancelled()) throw new Error(REPLACE_CANCELLED)

  let restore: RestoreResult
  try {
    restore = await restoreSqliteBackup(
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
        replaceAll: true,
        ...(request.confirmProduction ? { confirmProduction: true } : {}),
        ...(request.password ? { password: request.password } : {})
      },
      (event) => hooks.progress?.('restore', event),
      signal
    )
  } catch (err) {
    throw new Error(`${sentence(cancelled() ? REPLACE_CANCELLED : describeError(err))} ${keep}`)
  }
  return {
    existed: true,
    connectionName: config.name,
    safetyBackup: safety,
    charset: null,
    includeData,
    restore: includeData ? restore : { ...restore, structureOnly: true }
  }
}
