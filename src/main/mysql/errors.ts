import {
  DbUserError,
  describeForLog as describeDbErrorForLog,
  describeNetworkError,
  withServerMessage
} from '../db/errors'

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

const PRIVILEGES =
  'La cuenta conectada no tiene privilegios suficientes para esta operación: pide los permisos a un administrador'
const ACCESS_DENIED =
  'Usuario o contraseña incorrectos (o ese usuario no puede conectarse desde este equipo)'

/** Spanish explanations of the MySQL/MariaDB server errors users meet daily (by errno). */
const EXPLANATIONS: Record<number, string> = {
  1045: ACCESS_DENIED,
  1698: ACCESS_DENIED,
  1251: 'El servidor pide un método de autenticación que esta conexión no admite',
  1044: 'El usuario no tiene acceso a esa base de datos',
  1049: 'La base de datos no existe',
  1007: 'La base de datos ya existe',
  1146: 'La tabla o vista no existe',
  1050: 'La tabla ya existe',
  1054: 'La columna no existe',
  1064: 'Error de sintaxis SQL',
  1062: 'Valor duplicado en una clave única o primaria',
  1451: 'Otras filas dependen de esta (clave foránea): no se puede borrar ni cambiar',
  1217: 'Otras filas dependen de esta (clave foránea): no se puede borrar ni cambiar',
  1452: 'El valor no existe en la tabla referenciada (clave foránea)',
  1216: 'El valor no existe en la tabla referenciada (clave foránea)',
  1048: 'Una columna NOT NULL quedaría sin valor',
  1364: 'Una columna obligatoria no tiene valor ni valor por defecto',
  1406: 'El valor es demasiado largo para la columna',
  1264: 'Número fuera de rango para la columna',
  1142: PRIVILEGES,
  1143: PRIVILEGES,
  1227: PRIVILEGES,
  1370: PRIVILEGES,
  3530: PRIVILEGES,
  1205: 'Tiempo de espera de bloqueo agotado: otra transacción tiene bloqueadas esas filas',
  1213: 'Interbloqueo con otra transacción: repite la operación',
  1040: 'El servidor tiene demasiadas conexiones abiertas',
  1317: 'Consulta interrumpida',
  3024: 'La consulta superó el tiempo máximo de ejecución',
  1969: 'La consulta superó el tiempo máximo de ejecución',
  1290: 'El servidor está en modo de solo lectura o no permite esta opción',
  1792: 'La transacción es de solo lectura'
}

/** The error is the server's reply (errno + SQLSTATE), not a client or socket failure. */
function isServerReply(err: MysqlErrorLike): boolean {
  return typeof err.sqlState === 'string' || typeof err.sqlMessage === 'string'
}

/**
 * Human readable description of a MySQL error. A server reply becomes
 * "<explicación>. Mensaje del servidor: <message> (<code>)" (the explanation
 * only for the common errnos), a socket error "<explicación>. Detalle: …".
 * The "(<code>)" suffix stays last: privileges.ts parses it.
 * Never includes SQL text or parameter values.
 */
export function describeError(err: unknown): string {
  if (!isMysqlErrorLike(err)) return String(err)
  const message = err.sqlMessage ?? err.message ?? 'Error desconocido'
  const code = err.errno ? `${err.code ?? 'ER'} ${err.errno}` : err.code
  const suffix = code ? ` (${code})` : ''
  if (err instanceof DbUserError) return `${message}${suffix}`
  if (isServerReply(err))
    return `${withServerMessage(err.errno ? EXPLANATIONS[err.errno] : undefined, message)}${suffix}`
  const network = describeNetworkError(err.code, message)
  return `${network ?? message}${suffix}`
}

/** Log-safe description (the driver's describeForLog): never the server message. */
export const describeForLog = describeDbErrorForLog

/** Wraps a low-level error into a plain Error with a readable message. */
export function toUserError(err: unknown, prefix?: string): Error {
  if (err instanceof DbUserError) return err
  const description = describeError(err)
  return new Error(prefix ? `${prefix}: ${description}` : description)
}
