/**
 * PostgreSQL error taxonomy (docs/multi-engine-design.md, section 5.7).
 *
 * - PgUserError: written by Vortaq, safe to show and to log (DbUserError).
 * - Server errors (pg DatabaseError) carry text that may echo values (`detail`
 *   of 23505 quotes the duplicate key). They are shown to the user through
 *   describeForUser, and logged only as `name + SQLSTATE` (describeForLog).
 */
import {
  DbUserError,
  describeForLog as describeDbErrorForLog,
  describeNetworkError,
  withServerMessage
} from '../db/errors'

export class PgUserError extends DbUserError {
  constructor(message: string, code = 'E_PG_USER') {
    super(message, code)
    this.name = 'PgUserError'
  }
}

/** Fields of pg's DatabaseError (and of socket errors) that we read. */
export interface PgErrorLike {
  message: string
  code?: string
  detail?: string
  hint?: string
  position?: string
  severity?: string
  constraint?: string
  table?: string
  column?: string
}

export function isPgErrorLike(err: unknown): err is PgErrorLike {
  return typeof err === 'object' && err !== null && 'message' in err
}

/** SQLSTATE is five characters: digits and upper-case letters. */
export function sqlState(err: unknown): string | null {
  if (!isPgErrorLike(err) || typeof err.code !== 'string') return null
  return /^[0-9A-Z]{5}$/.test(err.code) ? err.code : null
}

const CONNECTION_LOST_STATES = new Set(['57P01', '57P02', '57P03', '08006', '08003', '08000'])
const CONNECTION_LOST_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH'
])

/** The socket or the server session is gone (admin shutdown, crash, network). */
export function isConnectionLost(err: unknown): boolean {
  if (!isPgErrorLike(err)) return false
  if (err.code && (CONNECTION_LOST_STATES.has(err.code) || CONNECTION_LOST_CODES.has(err.code)))
    return true
  return /Connection terminated|connection is closed|Client has encountered a connection error/i.test(
    err.message
  )
}

/** 28P01 invalid_password, 28000 invalid_authorization_specification (no pg_hba entry, etc.). */
export function isAuthRejected(err: unknown): boolean {
  // pg refuses an empty password client-side when the server asks for SCRAM.
  if (isPgErrorLike(err) && /password must be a non-empty string/i.test(err.message)) return true
  const state = sqlState(err)
  if (state === '28P01') return true
  if (state !== '28000') return false
  // "no pg_hba.conf entry … no encryption" is an SSL-mode problem, not a password one.
  return !/no encryption|SSL/i.test((err as PgErrorLike).message)
}

/** Short Spanish explanations prepended to the server message for common SQLSTATEs. */
const EXPLANATIONS: Record<string, string> = {
  '25P02': 'Transacción abortada: ejecuta ROLLBACK',
  '25006':
    'La transacción es de solo lectura (conexión protegida o transacción abierta en modo lectura)',
  '0A000': 'Referencia a otra base de datos: cambia la base de datos de la pestaña',
  '57014': 'Consulta cancelada',
  '42501': 'Permiso denegado',
  '40P01': 'Interbloqueo detectado: repite la operación',
  '55P03': 'No se pudo obtener el bloqueo',
  '23505': 'Valor duplicado',
  '23503': 'Viola una clave foránea',
  '23502': 'Falta un valor obligatorio (NOT NULL)',
  '22001': 'El valor es demasiado largo para la columna',
  '22003': 'Número fuera de rango',
  '22P02': 'Valor con formato no válido (las listas se escriben {a,b,"c d"})',
  '3D000': 'La base de datos no existe',
  '42P04': 'La base de datos ya existe',
  '42P01': 'La tabla o vista no existe (revisa el esquema y el search_path)',
  '42P07': 'Ya existe un objeto con ese nombre',
  '42703': 'La columna no existe',
  '42601': 'Error de sintaxis SQL',
  '53300': 'El servidor tiene demasiadas conexiones abiertas',
  '57P01': 'El servidor cerró la sesión (apagado o reinicio)',
  '28P01': 'Contraseña o usuario incorrectos',
  '28000': 'El servidor rechazó la conexión'
}

/**
 * A server reply becomes "<explicación>. Mensaje del servidor: <message> —
 * <detail> (SQLSTATE)" (the explanation only for common SQLSTATEs); a socket
 * error "<explicación>. Detalle: …". The `(CODE)` suffix is the contract
 * privileges.ts/friendlyError parse. Never contains SQL text.
 */
export function describeError(err: unknown): string {
  if (err instanceof DbUserError) return err.message
  if (!isPgErrorLike(err)) return String(err)
  const state = sqlState(err)
  const message = err.message || 'Error desconocido'
  const code = state ?? err.code
  const suffix = code ? ` (${code})` : ''
  if (state === '57014') return `Consulta cancelada por el usuario${suffix}`
  if (!state) return `${describeNetworkError(err.code, message) ?? message}${suffix}`
  let text = withServerMessage(EXPLANATIONS[state], message)
  if (err.detail) text += ` — ${err.detail}`
  if (err.hint) text += ` (Sugerencia: ${err.hint})`
  return `${text}${suffix}`
}

/** Log-safe description: class name and SQLSTATE only (detail may echo values). */
export const describeForLog = describeDbErrorForLog

/** 0-based offset of the error inside the statement, from pg's 1-based `position`. */
export function errorPosition(err: unknown): number | null {
  if (!isPgErrorLike(err) || !err.position) return null
  const n = Number(err.position)
  return Number.isInteger(n) && n > 0 ? n - 1 : null
}

export function missingPasswordError(name: string): PgUserError {
  return new PgUserError(
    `No hay contraseña guardada para la conexión ${name}: escríbela en la conexión o marca «Sin contraseña»`,
    'E_PG_NO_PASSWORD'
  )
}
