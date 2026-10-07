import type { UserInfo } from '@shared/types'
import { MysqlUserError, isMysqlErrorLike } from './errors'
import type { Queryable } from './introspect'
import { MARIADB_USERS_SQL, isMariaDbSession } from './mariadb'

const ACCESS_DENIED = new Set([
  'ER_TABLEACCESS_DENIED_ERROR',
  'ER_DBACCESS_DENIED_ERROR',
  'ER_COLUMNACCESS_DENIED_ERROR'
])

function flag(value: unknown): boolean {
  const v = String(value ?? '').toUpperCase()
  return v === 'Y' || v === '1' || v === 'TRUE' || v === 'YES'
}

/**
 * Accounts from mysql.user; needs SELECT on that table. On MariaDB they come
 * from mysql.global_priv (mysql.user is a view there without account_locked).
 */
export async function listUsers(q: Queryable): Promise<UserInfo[]> {
  if (isMariaDbSession(q)) return listMariaDbUsers(q)
  let rows: Record<string, unknown>[]
  try {
    rows = await q.query(
      `SELECT user, host, plugin, account_locked, password_expired, max_user_connections
         FROM mysql.user ORDER BY user, host`
    )
  } catch (err) {
    if (isMysqlErrorLike(err) && err.code && ACCESS_DENIED.has(err.code)) {
      throw new MysqlUserError(
        'No tienes privilegios para ver los usuarios: se necesita SELECT sobre la tabla mysql.user',
        'E_MYSQL_PRIVILEGE'
      )
    }
    throw err
  }
  return rows.map((r) => ({
    user: String(r.user ?? ''),
    host: String(r.host ?? ''),
    plugin: String(r.plugin ?? ''),
    accountLocked: flag(r.account_locked),
    passwordExpired: flag(r.password_expired),
    maxConnections: Number(r.max_user_connections ?? 0) || 0
  }))
}

async function listMariaDbUsers(q: Queryable): Promise<UserInfo[]> {
  let rows: Record<string, unknown>[]
  try {
    rows = await q.query(MARIADB_USERS_SQL)
  } catch (err) {
    if (isMysqlErrorLike(err) && err.code && ACCESS_DENIED.has(err.code)) {
      throw new MysqlUserError(
        'No tienes privilegios para ver los usuarios: se necesita SELECT sobre la tabla mysql.global_priv',
        'E_MYSQL_PRIVILEGE'
      )
    }
    throw err
  }
  return rows.map((r) => ({
    user: String(r.user ?? ''),
    host: String(r.host ?? ''),
    plugin: String(r.plugin ?? ''),
    accountLocked: flag(r.account_locked),
    // MariaDB marks an expired password with password_last_changed = 0.
    passwordExpired: String(r.password_last_changed ?? '') === '0',
    maxConnections: Number(r.max_user_connections ?? 0) || 0
  }))
}
