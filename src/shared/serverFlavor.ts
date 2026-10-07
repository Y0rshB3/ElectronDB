/**
 * Server flavour of a MySQL-protocol connection (docs/multi-engine-design.md,
 * D4 and section 5.6): a `mysql` connection may point at a MariaDB server.
 * Feature gates follow the configured engine; correctness fixes follow the
 * flavour detected here from `SELECT VERSION()`. Pure functions, no imports.
 */

export type MysqlFlavor = 'mysql' | 'mariadb'

/** Replication-compatible MariaDB servers may report "5.5.5-10.6.12-MariaDB". */
const COMPAT_PREFIX = /^5\.5\.5-/

/** 'mariadb' when VERSION() names MariaDB (after the 5.5.5- prefix); 'mysql' otherwise. */
export function detectMysqlFlavor(version: string | null | undefined): MysqlFlavor {
  return /mariadb/i.test(String(version ?? '').replace(COMPAT_PREFIX, '')) ? 'mariadb' : 'mysql'
}

export function isMariaDbVersion(version: string | null | undefined): boolean {
  return detectMysqlFlavor(version) === 'mariadb'
}

/** "8.4.7" -> 80407, "11.8.9-MariaDB-ubu2404" -> 110809, "5.5.5-10.6.12-MariaDB" -> 100612. */
export function mysqlVersionNumber(version: string | null | undefined): number {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(version ?? '').replace(COMPAT_PREFIX, ''))
  if (!m) return 0
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3] ?? 0)
}

/**
 * RETURNING support of the server: MariaDB has it on INSERT from 10.5 and on
 * DELETE from 10.0 (only both together count); MySQL never.
 */
export function mysqlReturning(version: string | null | undefined): 'none' | 'insert-delete' {
  return isMariaDbVersion(version) && mysqlVersionNumber(version) >= 100500
    ? 'insert-delete'
    : 'none'
}
