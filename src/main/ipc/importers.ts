import { dialog } from 'electron'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import type { ImportSourceId } from '@shared/importers'
import type { ProgressEvent } from '@shared/types'
import type { AppContext } from '../context'
import { envVar } from '../env'
import { getLogger } from '../log'
import type { ProgressReporter } from '../backup/index'
import {
  detectedPathOf,
  isImportSourceId,
  listImportSources,
  PickedPaths,
  sourceSpec,
  type SourceEnvironment
} from '../importers/registry'
import { importConnectionFile, previewConnectionFile } from '../importers/connections/index'
import {
  importSqlDump,
  importSqlFolder,
  inspectSqlDump,
  previewSqlFolder,
  type SqlImportDeps
} from '../importers/sql/index'
import { assertProductionWriteConfirmed } from './productionGuard'
import { handle } from './typed'

const log = getLogger('ipc.importers')

export const NOT_PICKED_MESSAGE =
  'Elige el archivo o la carpeta con «Elegir…» en el asistente de importación.'

/** Handlers for the importers:* channels; logic lives in src/main/importers/. */
export function registerImportersHandlers(ctx: AppContext): void {
  const picked = new PickedPaths()
  const operations = new Map<string, AbortController>()

  const environment = (): SourceEnvironment => {
    const testHome = ctx.isolatedProfile ? envVar('IMPORT_HOME')?.trim() : undefined
    return testHome
      ? { home: resolve(testHome), platform: process.platform, appData: resolve(testHome) }
      : { home: homedir(), platform: process.platform, appData: process.env.APPDATA ?? null }
  }

  /** A path the user picked in this session, or the usual file of the source on this OS. */
  const requirePath = (source: ImportSourceId | null, raw: unknown): string => {
    if (typeof raw !== 'string' || !raw.trim() || !isAbsolute(raw))
      throw new Error('Ruta no válida.')
    const path = raw
    if (picked.allows(path)) return path
    if (source && detectedPathOf(source, environment()) === path) return path
    throw new Error(NOT_PICKED_MESSAGE)
  }

  let deps: Promise<SqlImportDeps> | null = null
  const sqlDeps = (): Promise<SqlImportDeps> => {
    deps ??= Promise.all([import('../db/manager'), import('../backup/index')]).then(
      ([{ getSessionFactory }, { createBackupService }]) => {
        const sessions = getSessionFactory(ctx)
        return {
          connections: ctx.connections,
          sessions,
          backups: createBackupService(ctx, sessions)
        }
      }
    )
    deps.catch(() => {
      deps = null
    })
    return deps
  }

  /** Runs an operation with progress events (kind 'import') and cancellation. */
  async function track<T>(
    operationId: string,
    doneMessage: (result: T) => string,
    errorOf: (result: T) => string | null,
    run: (progress: ProgressReporter, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (typeof operationId !== 'string' || !operationId)
      throw new Error('Falta el identificador de la operación.')
    if (operations.has(operationId))
      throw new Error('Ya hay una operación en curso con ese identificador.')
    const controller = new AbortController()
    operations.set(operationId, controller)
    let current = 0
    let total: number | null = null
    const kind: ProgressEvent['kind'] = 'import'
    const progress: ProgressReporter = (event) => {
      current = event.current
      total = event.total
      ctx.emit('event:progress', { ...event, operationId, kind, done: false })
    }
    try {
      const result = await run(progress, controller.signal)
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

  handle('importers:sources', () => listImportSources(environment()))

  handle('importers:pick', async (source) => {
    const spec = sourceSpec(source)
    // Test switch (scratch profile only): screenshots cannot drive a native dialog.
    const fixture = ctx.isolatedProfile ? envVar('IMPORT_PICK')?.trim() : undefined
    let path: string | null = null
    if (fixture) {
      path = resolve(fixture)
    } else {
      const res = await dialog.showOpenDialog({
        title: spec.label,
        properties: spec.pick === 'folder' ? ['openDirectory'] : ['openFile'],
        filters: spec.pick === 'file' ? spec.filters : undefined
      })
      path = res.canceled ? null : (res.filePaths[0] ?? null)
    }
    if (path) picked.add(path)
    return path
  })

  handle('importers:previewConnections', async (source, path) => {
    if (!isImportSourceId(source) || sourceSpec(source).flow !== 'connections')
      throw new Error('Ese origen no contiene conexiones.')
    const preview = await previewConnectionFile(ctx, source, requirePath(source, path))
    // Counts only: names, hosts and warnings stay in the renderer.
    log.info(`preview ${source}: ${preview.items.length} conexiones`)
    return preview
  })

  handle('importers:importConnections', async (request) => {
    if (!request || typeof request !== 'object') throw new Error('Petición no válida.')
    if (!isImportSourceId(request.source) || sourceSpec(request.source).flow !== 'connections')
      throw new Error('Ese origen no contiene conexiones.')
    const path = requirePath(request.source, request.path)
    const result = await importConnectionFile(ctx, { ...request, path })
    log.info(
      `import ${request.source}: ${result.created.length} nuevas, ${result.updated.length} actualizadas, ${result.passwordsSaved} con contraseña`
    )
    return result
  })

  handle('importers:inspectSqlDump', (path) => inspectSqlDump(requirePath(null, path)))

  handle('importers:importSqlDump', (operationId, options) => {
    if (!options || typeof options !== 'object') throw new Error('Opciones no válidas.')
    const path = requirePath(null, options.path)
    if (options.connectionId)
      assertProductionWriteConfirmed(ctx, options.connectionId, options, 'Importar un archivo .sql')
    return track(
      operationId,
      (r) =>
        r.errors.length
          ? `Importación terminada con ${r.errors.length} error(es): ${r.executed} sentencias`
          : `Importación completada: ${r.executed} sentencias, ${r.rowsAffected} filas`,
      (r) =>
        r.errors.length
          ? r.errors
              .slice(0, 20)
              .map((e) => `Línea ${e.line}: ${e.message}`)
              .join('\n')
          : null,
      async (progress, signal) =>
        importSqlDump(await sqlDeps(), { ...options, path }, progress, signal)
    )
  })

  handle('importers:previewSqlFolder', (dir) => previewSqlFolder(requirePath(null, dir)))

  handle('importers:importSqlFolder', (operationId, request) => {
    if (!request || typeof request !== 'object') throw new Error('Petición no válida.')
    const dir = requirePath(null, request.dir)
    if (!Array.isArray(request.items)) throw new Error('Elige al menos un archivo.')
    const items = request.items.map((item) => ({
      path: requirePath(null, item?.path),
      schema: typeof item?.schema === 'string' ? item.schema : ''
    }))
    if (request.connectionId)
      assertProductionWriteConfirmed(
        ctx,
        request.connectionId,
        request,
        'Importar un paquete de archivos .sql'
      )
    return track(
      operationId,
      (r) => {
        const failed = r.items.filter((i) => i.error || (i.result?.errors.length ?? 0) > 0).length
        return failed
          ? `Paquete importado con errores en ${failed} de ${r.items.length} archivo(s)`
          : `Paquete importado: ${r.items.length} archivo(s)`
      },
      (r) => {
        const lines = r.items
          .filter((i) => i.error || (i.result?.errors.length ?? 0) > 0)
          .map((i) => `${i.schema}: ${i.error ?? `${i.result!.errors.length} error(es)`}`)
        return lines.length ? lines.join('\n') : null
      },
      async (progress, signal) =>
        importSqlFolder(await sqlDeps(), { ...request, dir, items }, progress, signal)
    )
  })

  handle('importers:cancel', async (operationId) => {
    operations.get(operationId)?.abort()
  })
}
