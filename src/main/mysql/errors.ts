import { DbUserError, describeForLog as describeDbErrorForLog } from '../db/errors'

/**
 * Error taxonomy for the mysql module.
 *
 * - MysqlUserError: business/usage errors with a Spanish, user-facing message
 *   (missing password, unknown connection, refused operation...). It extends
 *   the engine-neutral DbUserError (src/main/db/errors.ts), so code that checks
 *   `instanceof DbUserError` also accepts it; its code stays 'E_MYSQL_USER'.
 * - Technical errors coming from mysql2/ssh2 are passed through `describeError`
 *   so the renderer receives the server message plus its code.
 */
export class MysqlUserError extends DbUserError {
  constructor(message: string, code = 'E_MYSQL_USER') {
    super(message, code)
    this.name = 'MysqlUserError'
  }
}

export interface MysqlErrorLike {
  message: string
  code?: string
  errno?: number
  sqlState?: string
  sqlMessage?: string
  fatal?: boolean
}

export function isMysqlErrorLike(err: unknown): err is MysqlErrorLike {
  return typeof err === 'object' && err !== null && 'message' in err
}

/** Error codes (from mysql2 / net) that mean the underlying socket is gone. */
const CONNECTION_LOST_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_SERVER_SHUTDOWN'
])

export function isConnectionLost(err: unknown): boolean {
  if (!isMysqlErrorLike(err)) return false
  if (err.code && CONNECTION_LOST_CODES.has(err.code)) return true
  return err.fatal === true
}

/**
 * MySQL server errnos / mysql2 client codes meaning "these credentials were
 * rejected" (wrong or missing password, or an auth plugin the attempt cannot
 * satisfy). Database-level denials (1044) are not authentication failures.
 */
const AUTH_REJECTED_ERRNOS = new Set([1045, 1698, 1251])
const AUTH_REJECTED_CODES = new Set([
  'ER_ACCESS_DENIED_ERROR',
  'ER_ACCESS_DENIED_NO_PASSWORD_ERROR',
  'ER_NOT_SUPPORTED_AUTH_MODE',
  'AUTH_SWITCH_PLUGIN_ERROR',
  'MYSQL_CLEAR_PASSWORD_NOT_ENABLED'
])

export function isAuthRejected(err: unknown): boolean {
  if (!isMysqlErrorLike(err)) return false
  if (err.errno !== undefined && AUTH_REJECTED_ERRNOS.has(err.errno)) return true
  return !!err.code && AUTH_REJECTED_CODES.has(err.code)
}

/**
 * Human readable description of a MySQL error: "<message> (<code>)".
 * Never includes SQL text or parameter values.
 */
export function describeError(err: unknown): string {
  if (!isMysqlErrorLike(err)) return String(err)
  const message = err.sqlMessage ?? err.message ?? 'Error desconocido'
  const code = err.errno ? `${err.code ?? 'ER'} ${err.errno}` : err.code
  return code ? `${message} (${code})` : message
}

/** Log-safe description (the driver's describeForLog): never the server message. */
export const describeForLog = describeDbErrorForLog

/** Wraps a low-level error into a plain Error with a readable message. */
export function toUserError(err: unknown, prefix?: string): Error {
  if (err instanceof DbUserError) return err
  const description = describeError(err)
  return new Error(prefix ? `${prefix}: ${description}` : description)
}
