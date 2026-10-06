import { stat } from 'node:fs/promises'
import type {
  BackupCreateOptions,
  BackupCreateResult,
  BackupFile,
  BackupMeta,
  ProgressEvent,
  RestoreOptions,
  RestoreResult
} from '@shared/types'
import type { AppContext } from '../context'
import type { SessionFactory } from '../mysql/types'
import { createBackup } from './create'
import { getIndexCache } from './indexCache'
import { readManifest } from './nb3/reader'
import { restoreBackup } from './restore'
import { listBackups } from './scan'

export type ProgressReporter = (event: Omit<ProgressEvent, 'operationId' | 'kind'>) => void

export interface BackupService {
  list(connectionId: string, schema?: string | null): Promise<BackupFile[]>
  readMeta(path: string): Promise<BackupMeta>
  create(
    options: BackupCreateOptions,
    progress?: ProgressReporter,
    signal?: AbortSignal
  ): Promise<BackupCreateResult>
  restore(
    options: RestoreOptions,
    progress?: ProgressReporter,
    signal?: AbortSignal
  ): Promise<RestoreResult>
}

/** Reads a backup manifest, served from the persistent index cache while size and mtime are unchanged. */
export async function readBackupMeta(userDataPath: string, path: string): Promise<BackupMeta> {
  let identity: { size: number; mtimeMs: number }
  try {
    const s = await stat(path)
    if (!s.isFile()) throw new Error(`La ruta no es un archivo de backup: ${path}`)
    identity = { size: s.size, mtimeMs: s.mtimeMs }
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT')
      throw new Error(`No se encontró el archivo de backup: ${path}`)
    throw err
  }
  const cache = getIndexCache(userDataPath)
  const cached = cache.get(path, identity)
  if (cached) return cached
  const meta = await readManifest(path)
  try {
    cache.set(path, identity, meta)
  } catch {
    /* the cache is an optimisation; a write failure must not break reading */
  }
  return meta
}

export function createBackupService(ctx: AppContext, sessions: SessionFactory): BackupService {
  return {
    list: (connectionId, schema) => listBackups(ctx, connectionId, schema),
    readMeta: (path) => readBackupMeta(ctx.userDataPath, path),
    create: (options, progress, signal) =>
      createBackup({ connections: ctx.connections, sessions }, options, progress, signal),
    restore: (options, progress, signal) =>
      restoreBackup({ connections: ctx.connections, sessions }, options, progress, signal)
  }
}
