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
import { engineOf } from '@shared/engines'
import type { AppContext } from '../context'
import type { SessionFactory } from '../mysql/types'
import { createBackup } from './create'
import { getIndexCache } from './indexCache'
import { readManifest, verifyBackupFile, type Nb3VerifyResult } from './nb3/reader'
import {
  replaceSchemaFromBackup,
  type ReplaceHooks,
  type ReplaceRequest,
  type ReplaceResult
} from './replace'
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
  /** Full read of the archive: every checksum and gzip stream (throws when damaged). */
  verify(path: string, signal?: AbortSignal): Promise<Nb3VerifyResult>
  /** REPLACE restore: the database ends up equal to the backup (see replace.ts). */
  replace(
    request: ReplaceRequest,
    hooks?: ReplaceHooks,
    signal?: AbortSignal
  ): Promise<ReplaceResult>
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
  const service: BackupService = {
    list: async (connectionId, schema) => {
      // Engines without .nb3 backups have none to list (section 11); MySQL is unchanged.
      const connection = ctx.connections.get(connectionId)
      if (connection && !engineOf(connection).capabilities.supportsBackupsNb3) return []
      return listBackups(ctx, connectionId, schema)
    },
    readMeta: (path) => readBackupMeta(ctx.userDataPath, path),
    create: (options, progress, signal) =>
      createBackup({ connections: ctx.connections, sessions }, options, progress, signal),
    restore: (options, progress, signal) =>
      restoreBackup({ connections: ctx.connections, sessions }, options, progress, signal),
    verify: (path, signal) => verifyBackupFile(path, signal),
    replace: (request, hooks, signal) =>
      replaceSchemaFromBackup(
        { connections: ctx.connections, sessions, backups: service },
        request,
        hooks,
        signal
      )
  }
  return service
}
