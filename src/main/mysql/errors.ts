/**
 * Error taxonomy for the mysql module.
 *
 * - MysqlUserError: business/usage errors with a Spanish, user-facing message
 *   (missing password, unknown connection, refused operation...).
 * - Technical errors coming from mysql2/ssh2 are passed through `describeError`
 *   so the renderer receives the server message plus its code.
 */
export class MysqlUserError extends Error {
  constructor(
    message: string,
    readonly code = 'E_MYSQL_USER'
  ) {
    super(message)
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
 * Human readable description of a MySQL error: "<message> (<code>)".
 * Never includes SQL text or parameter values.
 */
export function describeError(err: unknown): string {
  if (!isMysqlErrorLike(err)) return String(err)
  const message = err.sqlMessage ?? err.message ?? 'Error desconocido'
  const code = err.errno ? `${err.code ?? 'ER'} ${err.errno}` : err.code
  return code ? `${message} (${code})` : message
}

/** Wraps a low-level error into a plain Error with a readable message. */
export function toUserError(err: unknown, prefix?: string): Error {
  if (err instanceof MysqlUserError) return err
  const description = describeError(err)
  return new Error(prefix ? `${prefix}: ${description}` : description)
}
