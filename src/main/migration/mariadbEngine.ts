/**
 * P5: MariaDB is its own engine. Connections stored as `mysql` before it keep
 * working; these helpers move the ones that are MariaDB to `mariadb`
 * (ConnectionsRepo.promoteToMariaDb, idempotent):
 *
 * - at startup, records imported from a MariaDB entry (Navicat `MariaDB`
 *   section or `.ncx` ConnType, kept in `source.navicatType`);
 * - when a `mysql` connection opens and its server reports MariaDB
 *   (src/main/db/manager.ts, interactive runs only).
 *
 * The MariaDB engine has everything the MySQL one has (backups, jobs, users),
 * so nothing the user had stops working; credentials keep the same id.
 */
import { isMariaDbVersion } from '@shared/serverFlavor'
import type { ConnectionConfig } from '@shared/types'
import type { ConnectionsRepo } from '../storage/repos'

/** A `mysql` record that was imported from a MariaDB entry. */
export function isImportedMariaDb(c: Pick<ConnectionConfig, 'engine' | 'source'>): boolean {
  return c.engine === 'mysql' && /^maria\s*db$/i.test(c.source?.navicatType?.trim() ?? '')
}

/** A `mysql` record whose server reported a MariaDB VERSION(). */
export function servesMariaDb(
  c: Pick<ConnectionConfig, 'engine'>,
  serverVersion: string | null | undefined
): boolean {
  return c.engine === 'mysql' && isMariaDbVersion(serverVersion)
}

/** Startup pass; returns how many records changed (0 on every later start). */
export function migrateImportedMariaDb(
  repo: Pick<ConnectionsRepo, 'list' | 'promoteToMariaDb'>
): number {
  let changed = 0
  for (const c of repo.list()) {
    if (isImportedMariaDb(c) && repo.promoteToMariaDb(c.id)) changed++
  }
  return changed
}
