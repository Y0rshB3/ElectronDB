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
import { engineOf, hasBackups } from '@shared/engines'
import type { SqlExportOptions, SqlExportResult } from '@shared/importers'
import type { AppContext } from '../context'
import type { SessionFactory } from '../mysql/types'
import { createBackup } from './create'
import { getIndexCache } from './indexCache'
import { readArchiveMeta, verifyArchive, type ArchiveVerifyResult } from './archive'
import {
  replaceSchemaFromBackup,
  type ReplaceHooks,
  type ReplaceRequest,
  type ReplaceResult
} from './replace'
import { restoreBackup } from './restore'
import { listBackups } from './scan'
import { exportSchemaToSql } from './sqlExport'
import { needsTypedConfirm } from '../ipc/productionGuard'
import { createPgBackup, type PgSessionProvider } from './vqb/pgBackup'
import type { ScryptParams } from './vqb/crypto'
import { replacePgDatabase } from './vqb/pgReplace'
import { restorePgBackup } from './vqb/pgRestore'
import { createSqliteBackup, type SqliteConnectionProvider } from './vqb/sqliteBackup'
import { replaceSqliteDatabase } from './vqb/sqliteReplace'
import { restoreSqliteBackup, restoredConnectionName } from './vqb/sqliteRestore'
import type { ProcessSpawner } from '../sqlite/spawner'
import { defaultSqliteOptions } from '@shared/engines'

export type ProgressReporter = (event: Omit<ProgressEvent, 'operationId' | 'kind'>) => void

export interface BackupService {
  list(connectionId: string, schema?: string | null): Promise<BackupFile[]>
  /** Manifest of a .nb3/.vqb; an encrypted .vqb without `password` gives the locked header meta. */
  readMeta(path: string, password?: string | null): Promise<BackupMeta>
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
  /** Plain .sql dump of one schema (mysqldump-compatible, for other managers). */
  exportSql(
    options: SqlExportOptions,
    progress?: ProgressReporter,
    signal?: AbortSignal
  ): Promise<SqlExportResult>
  /** Full read of the archive: every checksum, GCM tag and gzip stream (throws when damaged). */
  verify(path: string, signal?: AbortSignal, password?: string | null): Promise<ArchiveVerifyResult>
  /** REPLACE restore: the database ends up equal to the backup (see replace.ts). */
  replace(
    request: ReplaceRequest,
    hooks?: ReplaceHooks,
    signal?: AbortSignal
  ): Promise<ReplaceResult>
}

/**
 * Reads a backup manifest, served from the persistent index cache while size
 * and mtime are unchanged. The manifest of an encrypted .vqb read with its
 * password is never cached (object names would end up in plain text on
 * disk): only its locked header-only meta is.
 */
export async function readBackupMeta(
  userDataPath: string,
  path: string,
  password?: string | null
): Promise<BackupMeta> {
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
  if (cached && !(password && cached.locked)) return cached
  const meta = await readArchiveMeta(path, password)
  if (meta.encrypted && !meta.locked) return meta
  try {
    cache.set(path, identity, meta)
  } catch {
    /* the cache is an optimisation; a write failure must not break reading */
  }
  return meta
}

/** Pooled PostgreSQL sessions through the connection manager (loaded on first use). */
export function pgSessionProvider(ctx: AppContext): PgSessionProvider {
  return {
    async acquire(connectionId, database) {
      const [{ getConnectionManager }, { isPgConnection }] = await Promise.all([
        import('../db/manager'),
        import('../postgres/connection')
      ])
      const connection = await getConnectionManager(ctx).connection(connectionId)
      if (!isPgConnection(connection)) throw new Error('La conexión no es PostgreSQL.')
      return connection.acquire(database ? { database, schema: null } : null)
    }
  }
}

/** Open SQLite connections through the connection manager (loaded on first use). */
export function sqliteConnectionProvider(ctx: AppContext): SqliteConnectionProvider {
  return {
    async connection(connectionId) {
      const [{ getConnectionManager }, { isSqliteConnection }] = await Promise.all([
        import('../db/manager'),
        import('../sqlite/connection')
      ])
      const connection = await getConnectionManager(ctx).connection(connectionId)
      if (!isSqliteConnection(connection)) throw new Error('La conexión no es SQLite.')
      return connection
    }
  }
}

export interface BackupServiceOptions {
  /** PostgreSQL sessions (tests); the connection manager otherwise. */
  pg?: PgSessionProvider
  /** SQLite connections (tests); the connection manager otherwise. */
  sqlite?: SqliteConnectionProvider
  /** Spawner of the temporary SQLite worker of «restaurar en un archivo nuevo» (tests). */
  sqliteSpawner?: () => ProcessSpawner
  /** scrypt cost of new encrypted .vqb backups (tests use a cheap one). */
  scrypt?: ScryptParams
}

export function createBackupService(
  ctx: AppContext,
  sessions: SessionFactory,
  serviceOptions: BackupServiceOptions = {}
): BackupService {
  const pg = serviceOptions.pg ?? pgSessionProvider(ctx)
  const isPg = (connectionId: string | undefined): boolean =>
    !!connectionId && ctx.connections.get(connectionId)?.engine === 'postgresql'
  const isSqlite = (connectionId: string | undefined): boolean =>
    !!connectionId && ctx.connections.get(connectionId)?.engine === 'sqlite'
  const sqliteDeps = {
    connections: ctx.connections,
    sqlite: serviceOptions.sqlite ?? sqliteConnectionProvider(ctx),
    spawner: serviceOptions.sqliteSpawner,
    scrypt: serviceOptions.scrypt,
    // «Crear una conexión para el archivo restaurado»: foreign keys on (a file made here).
    createConnection: (filePath: string): string =>
      ctx.connections.save({
        name: restoredConnectionName(filePath),
        color: null,
        environment: 'local',
        host: '',
        port: 0,
        username: '',
        authMode: 'none',
        savePassword: false,
        customDatabases: [],
        initialQueries: '',
        ssh: {
          enabled: false,
          host: '',
          port: 22,
          username: '',
          authType: 'password',
          savePassword: false
        },
        ssl: { enabled: false, verifyServer: false },
        backupDir: '',
        extraBackupDirs: [],
        engine: 'sqlite',
        sqlite: { ...defaultSqliteOptions(false), filePath, foreignKeys: true }
      }).id
  }
  const guarded = (connectionId: string): boolean =>
    !!ctx.settings && needsTypedConfirm(ctx, ctx.connections.get(connectionId))
  const service: BackupService = {
    list: async (connectionId, schema) => {
      // Engines without .nb3 backups have none to list (section 11); MySQL is unchanged.
      const connection = ctx.connections.get(connectionId)
      if (connection && !hasBackups(connection)) return []
      const files = await listBackups(ctx, connectionId, schema)
      // A .nb3 can only be restored into MySQL: engines without .nb3 list their .vqb files.
      return connection && !engineOf(connection).capabilities.supportsBackupsNb3
        ? files.filter((f) => f.format === 'vqb')
        : files
    },
    readMeta: (path, password) => readBackupMeta(ctx.userDataPath, path, password),
    create: (options, progress, signal) =>
      isSqlite(options?.connectionId)
        ? createSqliteBackup(sqliteDeps, options, progress, signal)
        : isPg(options?.connectionId)
          ? createPgBackup(
              { connections: ctx.connections, pg, scrypt: serviceOptions.scrypt },
              options,
              progress,
              signal
            )
          : createBackup(
              { connections: ctx.connections, sessions, scrypt: serviceOptions.scrypt },
              options,
              progress,
              signal
            ),
    exportSql: (options, progress, signal) =>
      exportSchemaToSql({ connections: ctx.connections, sessions }, options, progress, signal),
    restore: (options, progress, signal) =>
      options?.newFilePath || isSqlite(options?.connectionId)
        ? restoreSqliteBackup(sqliteDeps, options, progress, signal)
        : isPg(options?.connectionId)
          ? restorePgBackup(
              { connections: ctx.connections, pg, guarded },
              options,
              progress,
              signal
            )
          : restoreBackup({ connections: ctx.connections, sessions }, options, progress, signal),
    verify: (path, signal, password) => verifyArchive(path, signal, password),
    replace: (request, hooks, signal) =>
      isSqlite(request?.connectionId)
        ? replaceSqliteDatabase({ ...sqliteDeps, backups: service }, request, hooks, signal)
        : isPg(request?.connectionId)
          ? replacePgDatabase(
              { connections: ctx.connections, pg, guarded, backups: service },
              request,
              hooks,
              signal
            )
          : replaceSchemaFromBackup(
              { connections: ctx.connections, sessions, backups: service },
              request,
              hooks,
              signal
            )
  }
  return service
}
