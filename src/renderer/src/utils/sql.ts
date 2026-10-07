import { quoteIdent, quoteString } from '@shared/dialects/mysql'

/**
 * Quoting, the plain ';' splitter and analyzeDestructive moved to the MySQL
 * dialect (src/shared/dialects/mysql.ts) in P1a; re-exported here for one phase.
 */
export {
  analyzeDestructive,
  qualified,
  quoteIdent,
  quoteString,
  splitOnSemicolons as splitStatements
} from '@shared/dialects/mysql'
export type { DestructiveCheck } from '@shared/dialects/mysql'

export function createUserSql(
  user: string,
  host: string,
  password: string,
  plugin?: string | null
): string {
  const identified = plugin
    ? `IDENTIFIED WITH ${quoteIdent(plugin)} BY ${quoteString(password)}`
    : `IDENTIFIED BY ${quoteString(password)}`
  return `CREATE USER ${quoteString(user)}@${quoteString(host)} ${identified};`
}

export function dropUserSql(user: string, host: string): string {
  return `DROP USER ${quoteString(user)}@${quoteString(host)};`
}

export function alterPasswordSql(user: string, host: string, password: string): string {
  return `ALTER USER ${quoteString(user)}@${quoteString(host)} IDENTIFIED BY ${quoteString(password)};`
}

export function lockUserSql(user: string, host: string, lock: boolean): string {
  return `ALTER USER ${quoteString(user)}@${quoteString(host)} ACCOUNT ${lock ? 'LOCK' : 'UNLOCK'};`
}

/** Rewrite `DEFINER=`x`@`y`` clauses to CURRENT_USER. */
export function replaceDefiner(sql: string): string {
  return sql.replace(
    /DEFINER\s*=\s*(`[^`]*`|'[^']*'|\w+)@(`[^`]*`|'[^']*'|\w+)/gi,
    'DEFINER=CURRENT_USER'
  )
}

export function formatCellForSql(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  return quoteString(String(value))
}
