import { realpath, stat, unlink } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { IpcArgs, IpcResult } from '@shared/ipc'
import type { ConnectionConfig, ProgressEvent, RestoreOptions, RestoreResult } from '@shared/types'
import type { AppContext } from '../context'
import type { BackupService, ProgressReporter } from './index'
import { readBackupMeta } from './index'
import { getIndexCache } from './indexCache'
import { isBackupFileName } from './naming'
import { readObjectMeta } from './nb3/reader'

/**
 * Transport-agnostic implementation of the backups:* IPC channels. Kept free
 * of electron so it can be unit tested; src/main/ipc/backups.ts wires it.
 */

export const NAVICAT_DELETE_MESSAGE =
  'Este backup está en una carpeta de Navicat (solo lectura) y ElectronDB no lo borra. Elimínalo desde Navicat o desde Finder.'
export const OUTSIDE_DELETE_MESSAGE =
  'Solo se pueden borrar backups que estén dentro de la carpeta de backups de una conexión.'

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

const isInside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function requireBackupPath(path: unknown): string {
  if (typeof path !== 'string' || !path.trim()) throw new Error('Ruta de backup no válida.')
  if (!isAbsolute(path)) throw new Error('La ruta del backup debe ser absoluta.')
  if (!isBackupFileName(path)) throw new Error('El archivo indicado no es un backup .nb3.')
  return path
}

/**
 * Deletes a .nb3 file only when it lives inside some connection's backupDir
 * and never when it is inside an extraBackupDirs entry (Navicat's own files).
 */
export async function deleteBackupFile(
  connections: ConnectionConfig[],
  userDataPath: string,
  rawPath: string
): Promise<void> {
  const path = requireBackupPath(rawPath)
  const target = await canonical(path)
  for (const c of connections) {
    for (const dir of c.extraBackupDirs ?? []) {
      if (dir && isInside(target, await canonical(dir))) throw new Error(NAVICAT_DELETE_MESSAGE)
    }
  }
  let allowed = false
  for (const c of connections) {
    if (c.backupDir && isInside(target, await canonical(c.backupDir))) {
      allowed = true
      break
    }
  }
  if (!allowed) throw new Error(OUTSIDE_DELETE_MESSAGE)
  try {
    const s = await stat(target)
    if (!s.isFile()) throw new Error('La ruta indicada no es un archivo.')
    await unlink(target)
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT')
      throw new Error(`El backup ya no existe: ${path}`)
    if (
      (err as { code?: string }).code === 'EACCES' ||
      (err as { code?: string }).code === 'EPERM'
    ) {
      throw new Error(`Sin permisos para borrar el backup: ${path}`)
    }
    throw err
  }
  getIndexCache(userDataPath).forget(path)
  if (target !== path) getIndexCache(userDataPath).forget(target)
}

/** DDL shown in the backup browser: object DDL, then index and trigger DDL. */
export async function objectDdl(path: string, uuid: string): Promise<string> {
  requireBackupPath(path)
  if (typeof uuid !== 'string' || !uuid) throw new Error('Objeto de backup no válido.')
  const meta = await readObjectMeta(path, uuid)
  return [meta.DDL, ...meta.IndexDDL, ...meta.TriggerDDL].filter((s) => s.trim() !== '').join(';\n')
}

type Kind = ProgressEvent['kind']

/**
 * backups:restore with `replaceSchema`: the whole database is replaced by the
 * backup (the way to undo a rollback with its 'previo-rollback' copy).
 */
export async function replaceRestore(
  service: BackupService,
  options: RestoreOptions,
  progress: ProgressReporter,
  signal: AbortSignal
): Promise<RestoreResult> {
  if (!options || typeof options !== 'object')
    throw new Error('Opciones de restauración no válidas.')
  const path = requireBackupPath(options.backupPath)
  if (!options.connectionId) throw new Error('Selecciona la conexión de destino.')
  if (!options.targetSchema?.trim()) throw new Error('Indica la base de datos de destino.')
  const meta = await service.readMeta(path)
  if (!meta.schema) throw new Error(`El backup ${path} no indica qué base de datos contiene.`)
  const result = await service.replace(
    {
      backupPath: path,
      expectedSchema: meta.schema,
      connectionId: options.connectionId,
      targetSchema: options.targetSchema.trim(),
      safetyBackup: options.safetyBackup !== false,
      continueOnError: options.continueOnError === true,
      ...(options.confirmProduction ? { confirmProduction: true } : {})
    },
    {
      progress: (stage, event) =>
        progress(
          stage === 'safety' ? { ...event, message: `Copia previa · ${event.message}` } : event
        )
    },
    signal
  )
  return { ...result.restore, safetyBackupPath: result.safetyBackup?.path ?? null }
}

export interface BackupHandlers {
  list(...args: IpcArgs<'backups:list'>): Promise<IpcResult<'backups:list'>>
  meta(...args: IpcArgs<'backups:meta'>): Promise<IpcResult<'backups:meta'>>
  objectDdl(...args: IpcArgs<'backups:objectDdl'>): Promise<IpcResult<'backups:objectDdl'>>
  create(...args: IpcArgs<'backups:create'>): Promise<IpcResult<'backups:create'>>
  restore(...args: IpcArgs<'backups:restore'>): Promise<IpcResult<'backups:restore'>>
  delete(...args: IpcArgs<'backups:delete'>): Promise<IpcResult<'backups:delete'>>
  cancel(...args: IpcArgs<'backups:cancel'>): Promise<IpcResult<'backups:cancel'>>
  /** Operation ids currently running (for tests / diagnostics). */
  running(): string[]
}

export function createBackupHandlers(
  ctx: AppContext,
  getService: () => Promise<BackupService>
): BackupHandlers {
  const operations = new Map<string, AbortController>()

  async function track<T>(
    operationId: string,
    kind: Kind,
    doneMessage: (result: T) => string,
    errorOf: (result: T) => string | null,
    run: (service: BackupService, progress: ProgressReporter, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    // These two checks run before any progress is emitted on purpose: with no id there is no
    // listener to notify, and a done:true event for a duplicate id would end the progress UI
    // of the operation that is still running under it. The rejected invoke reports the error.
    if (typeof operationId !== 'string' || !operationId)
      throw new Error('Falta el identificador de la operación.')
    if (operations.has(operationId))
      throw new Error('Ya hay una operación en curso con ese identificador.')
    const controller = new AbortController()
    operations.set(operationId, controller)
    let current = 0
    let total: number | null = null
    const progress: ProgressReporter = (event) => {
      current = event.current
      total = event.total
      ctx.emit('event:progress', { ...event, operationId, kind, done: false })
    }
    try {
      const service = await getService()
      const result = await run(service, progress, controller.signal)
      const failure = errorOf(result)
      ctx.emit('event:progress', {
        operationId,
        kind,
        phase: failure ? 'error' : 'done',
        current: total ?? current,
        total,
        message: doneMessage(result),
        done: true,
        ...(failure ? { error: failure } : {})
      })
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.emit('event:progress', {
        operationId,
        kind,
        phase: controller.signal.aborted ? 'cancelled' : 'error',
        current,
        total,
        message,
        done: true,
        error: message
      })
      throw err
    } finally {
      operations.delete(operationId)
    }
  }

  return {
    list: async (connectionId, schema) => (await getService()).list(connectionId, schema ?? null),
    meta: async (path) => readBackupMeta(ctx.userDataPath, requireBackupPath(path)),
    objectDdl: (path, uuid) => objectDdl(path, uuid),
    create: (operationId, options) =>
      track(
        operationId,
        'backup',
        (r) => `Backup completado: ${r.objects} objetos, ${r.rows} filas`,
        () => null,
        (service, progress, signal) => service.create(options, progress, signal)
      ),
    restore: (operationId, options) =>
      track(
        operationId,
        'restore',
        (r) =>
          r.errors.length > 0
            ? `Restauración terminada con ${r.errors.length} error(es): ${r.objectsRestored} objetos, ${r.rowsInserted} filas`
            : `Restauración completada: ${r.objectsRestored} objetos, ${r.rowsInserted} filas`,
        // A restore resolves with per-object errors (and stops early unless continueOnError);
        // flag them on the final event so progress-only listeners can tell it did not succeed.
        (r) =>
          r.errors.length > 0 ? r.errors.map((e) => `${e.object}: ${e.message}`).join('\n') : null,
        (service, progress, signal) =>
          options?.replaceSchema
            ? replaceRestore(service, options, progress, signal)
            : service.restore(options, progress, signal)
      ),
    delete: (path) => deleteBackupFile(ctx.connections.list(), ctx.userDataPath, path),
    cancel: async (operationId) => {
      operations.get(operationId)?.abort()
    },
    running: () => [...operations.keys()]
  }
}
