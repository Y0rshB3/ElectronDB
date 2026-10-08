/**
 * MariaDB fixes for `mysql` connections (docs/multi-engine-design.md, P1b).
 * Everything here runs only when the server reports MariaDB (serverFlavor.ts),
 * so MySQL servers keep the v0.1.x SQL text byte for byte. All verified on
 * MariaDB 11.8 (tests/integration/mariadb.test.ts).
 */
import { isMariaDbVersion } from '@shared/serverFlavor'
import type { ObjectSummary } from '@shared/types'

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

/**
 * Column-level CHECK constraints of a table. MariaDB stores `doc JSON` as
 * LONGTEXT with the check `json_valid(\`doc\`)` named after the column.
 */
export const MARIADB_COLUMN_CHECKS_SQL = `SELECT CONSTRAINT_NAME AS name, CHECK_CLAUSE AS clause
       FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? AND LEVEL = 'Column'`

/** Names of the columns whose only column check is MariaDB's JSON one. */
export function jsonColumnsFromChecks(rows: { name: unknown; clause: unknown }[]): Set<string> {
  const out = new Set<string>()
  for (const r of rows) {
    const name = String(r.name ?? '')
    const quoted = '`' + name.replace(/`/g, '``') + '`'
    if (String(r.clause ?? '').trim() === `json_valid(${quoted})`) out.add(name)
  }
  return out
}

/** Full collation names per charset (MariaDB 11.x; absent before, the caller ignores errors). */
export const MARIADB_FULL_COLLATIONS_SQL = `SELECT FULL_COLLATION_NAME AS collation, CHARACTER_SET_NAME AS charset
       FROM information_schema.COLLATION_CHARACTER_SET_APPLICABILITY
      WHERE FULL_COLLATION_NAME <> COLLATION_NAME`

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

/* ---------- Sequences (MariaDB engine, P5) ---------- */

/** information_schema.SEQUENCES (MariaDB 11); older servers fall back to the TABLES listing. */
export const MARIADB_SEQUENCES_SQL = `SELECT SEQUENCE_NAME AS name, DATA_TYPE AS dataType, START_VALUE AS seqStart,
            MINIMUM_VALUE AS seqMin, MAXIMUM_VALUE AS seqMax, INCREMENT AS seqStep,
            CYCLE_OPTION AS seqCycle
       FROM information_schema.SEQUENCES
      WHERE SEQUENCE_SCHEMA = ?
      ORDER BY SEQUENCE_NAME`

export const MARIADB_SEQUENCE_TABLES_SQL = `SELECT TABLE_NAME AS name, TABLE_COMMENT AS comment
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'SEQUENCE'
      ORDER BY TABLE_NAME`

type SequenceQueryable = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
}

/** "inicio 1 · incremento 1 · 1…9223372036854775806 · cíclica" */
export function describeMariaDbSequence(row: Record<string, unknown>): string {
  const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
  const cycle = text(row.seqCycle) === '1' || /^yes$/i.test(text(row.seqCycle))
  return [
    `inicio ${text(row.seqStart)}`,
    `incremento ${text(row.seqStep)}`,
    `${text(row.seqMin)}…${text(row.seqMax)}`,
    cycle ? 'cíclica' : 'sin ciclo'
  ].join(' · ')
}

/** Sequences of a database for the tree (`db:objects` type 'sequence'). Names and options only. */
export async function listMariaDbSequences(
  q: SequenceQueryable,
  schema: string
): Promise<ObjectSummary[]> {
  try {
    const rows = await q.query<Record<string, unknown>>(MARIADB_SEQUENCES_SQL, [schema])
    return rows.map((r) => ({
      name: String(r.name),
      type: 'sequence' as const,
      schema,
      kind: String(r.dataType ?? ''),
      detail: describeMariaDbSequence(r)
    }))
  } catch {
    // MariaDB before information_schema.SEQUENCES: the names are in TABLES.
    const rows = await q.query<Record<string, unknown>>(MARIADB_SEQUENCE_TABLES_SQL, [schema])
    return rows.map((r) => ({
      name: String(r.name),
      type: 'sequence' as const,
      schema,
      detail: null,
      comment: r.comment ? String(r.comment) : undefined
    }))
  }
}
