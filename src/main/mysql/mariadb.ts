/**
 * MariaDB fixes for `mysql` connections (docs/multi-engine-design.md, P1b).
 * Everything here runs only when the server reports MariaDB (serverFlavor.ts),
 * so MySQL servers keep the v0.1.x SQL text byte for byte. All verified on
 * MariaDB 11.8 (tests/integration/mariadb.test.ts).
 */
import { isMariaDbVersion } from '@shared/serverFlavor'

/** True when a session/queryable talks to a MariaDB server (it carries the server version). */
export function isMariaDbSession(q: { serverVersion?: string } | null | undefined): boolean {
  return isMariaDbVersion(q?.serverVersion)
}

/**
 * information_schema.COLUMNS.COLUMN_DEFAULT on MariaDB: the text 'NULL' means
 * "no default / DEFAULT NULL", string literals come quoted ('x''y', with
 * backslash escapes), and numbers and expressions come bare. Returns MySQL's
 * shape: null, the unquoted literal, or the expression as it is.
 */
export function unquoteMariaDbDefault(raw: string | null): string | null {
  if (raw === null || raw === 'NULL') return null
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    const body = raw.slice(1, -1)
    let out = ''
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]
      if (ch === "'" && body[i + 1] === "'") {
        out += "'"
        i++
      } else if (ch === '\\' && i + 1 < body.length) {
        const next = body[++i]
        out +=
          next === 'n'
            ? '\n'
            : next === 't'
              ? '\t'
              : next === 'r'
                ? '\r'
                : next === '0'
                  ? '\0'
                  : next
      } else out += ch
    }
    return out
  }
  return raw
}

/** Tables in the tree: system-versioned tables are tables too (MariaDB only). */
export const MARIADB_LIST_TABLES_SQL = `SELECT TABLE_NAME, ENGINE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, AUTO_INCREMENT,
            CREATE_TIME, UPDATE_TIME, TABLE_COLLATION, TABLE_COMMENT
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('BASE TABLE', 'SYSTEM VERSIONED')
      ORDER BY TABLE_NAME`

/**
 * Accounts on MariaDB: `mysql.user` is a view over `mysql.global_priv` without
 * `account_locked`, so the attributes are read from the JSON column. Roles
 * are not accounts. password_last_changed = 0 means the password is expired.
 */
export const MARIADB_USERS_SQL = `SELECT User AS user, Host AS host,
            JSON_VALUE(Priv, '$.plugin') AS plugin,
            JSON_VALUE(Priv, '$.account_locked') AS account_locked,
            JSON_VALUE(Priv, '$.password_last_changed') AS password_last_changed,
            JSON_VALUE(Priv, '$.max_user_connections') AS max_user_connections
       FROM mysql.global_priv
      WHERE COALESCE(JSON_VALUE(Priv, '$.is_role'), 'false') NOT IN ('true', '1')
      ORDER BY User, Host`

/** Objects a .nb3 backup leaves out on MariaDB (the format has no slot for them). */
export interface SkippedBackupObject {
  kind: 'system-versioned' | 'sequence'
  name: string
}

export const MARIADB_SKIPPED_OBJECTS_SQL = `SELECT TABLE_NAME AS name, TABLE_TYPE AS type
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('SYSTEM VERSIONED', 'SEQUENCE')
      ORDER BY TABLE_NAME`

/** Maps information_schema TABLE_TYPE values to skipped objects; other types are ignored. */
export function skippedFromTableTypes(
  rows: { name: unknown; type: unknown }[]
): SkippedBackupObject[] {
  const out: SkippedBackupObject[] = []
  for (const r of rows) {
    const type = String(r.type ?? '').toUpperCase()
    const name = String(r.name ?? '')
    if (type === 'SYSTEM VERSIONED') out.push({ kind: 'system-versioned', name })
    else if (type === 'SEQUENCE') out.push({ kind: 'sequence', name })
  }
  return out
}

/**
 * "La copia no incluye 1 tabla versionada y 2 secuencias: a, s1, s2" (names
 * only, never data); null when nothing is skipped.
 */
export function describeSkippedObjects(objects: SkippedBackupObject[]): string | null {
  if (!objects.length) return null
  const versioned = objects.filter((o) => o.kind === 'system-versioned').length
  const sequences = objects.length - versioned
  const parts: string[] = []
  if (versioned)
    parts.push(`${versioned} ${versioned === 1 ? 'tabla versionada' : 'tablas versionadas'}`)
  if (sequences) parts.push(`${sequences} ${sequences === 1 ? 'secuencia' : 'secuencias'}`)
  return `La copia no incluye ${parts.join(' y ')} (MariaDB): ${objects.map((o) => o.name).join(', ')}. Copia esos objetos con otra herramienta si los necesitas.`
}
