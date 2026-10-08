/**
 * MongoDB error taxonomy (docs/multi-engine-design.md, 5.7).
 *
 * - MongoUserError: written by Vortaq, safe to show and to log.
 * - MongoServerSideError: the server's text, which can echo values
 *   (`E11000 duplicate key … dup key: { email: "…" }`, `errInfo` of a
 *   validation failure). Shown to the user, logged only as its code.
 * - Raw driver errors are converted by `toServerError` before they leave the
 *   driver, so `describeForLog` never sees their text.
 */
import {
  DbUserError,
  ServerError,
  describeForLog as describeDbErrorForLog,
  withServerMessage
} from '../db/errors'

export class MongoUserError extends DbUserError {
  constructor(message: string, code = 'E_MONGO_USER') {
    super(message, code)
    this.name = 'MongoUserError'
  }
}

export class MongoServerSideError extends ServerError {
  constructor(
    message: string,
    code: number | string | null,
    /** Driver class name (MongoServerError, MongoNetworkError…). */
    readonly driverName: string
  ) {
    super(message, code)
    this.name = 'MongoServerSideError'
  }
}

interface MongoErrorLike {
  name?: string
  message?: string
  code?: number | string
  codeName?: string
  errInfo?: unknown
  errorResponse?: { errInfo?: unknown; codeName?: string }
}

function isErrorLike(err: unknown): err is MongoErrorLike {
  return typeof err === 'object' && err !== null && 'message' in err
}

/** Spanish explanation of the codes users meet daily. */
const EXPLAINED: Record<number, string> = {
  11000: 'Clave duplicada en un índice único.',
  121: 'El documento no cumple el validador de la colección.',
  13: 'Sin permisos para esta operación.',
  50: 'La operación superó el tiempo máximo (maxTimeMS).',
  11601: 'Operación cancelada.',
  26: 'La colección o la base de datos no existe.',
  48: 'Ya existe una colección con ese nombre.',
  18: 'Usuario o contraseña incorrectos.',
  10107: 'Conectado a un secundario: solo lectura.',
  13435: 'Conectado a un secundario: solo lectura.',
  189: 'Conectado a un secundario: solo lectura.',
  85: 'Ya existe un índice con esas claves y otras opciones.',
  86: 'Ya existe un índice con ese nombre y otras claves.',
  27: 'El índice no existe.',
  72: 'Opción no válida.',
  2: 'Valor no válido.',
  9: 'Error al interpretar la orden.',
  20: 'Operación no permitida en esta colección (p. ej. borrar en una colección limitada).',
  263: 'Esta operación no se puede hacer dentro de una transacción.',
  251: 'La transacción ya no existe (caducó o se deshizo).',
  112: 'Conflicto de escritura con otra transacción: repítela.',
  20000: 'Conflicto de escritura con otra transacción: repítela.'
}

/** The server or the driver says the operation was cancelled / interrupted. */
export function isInterrupted(err: unknown): boolean {
  return isErrorLike(err) && (err.code === 11601 || err.code === 11602 || err.code === 237)
}

/** The server rejected the credentials. */
export function isAuthRejected(err: unknown): boolean {
  if (!isErrorLike(err)) return false
  return err.code === 18 || /Authentication failed/i.test(err.message ?? '')
}

/** The connection to the server is gone. */
export function isConnectionLost(err: unknown): boolean {
  return (
    isErrorLike(err) &&
    (err.name === 'MongoNetworkError' ||
      err.name === 'MongoNetworkTimeoutError' ||
      err.name === 'MongoTopologyClosedError' ||
      err.name === 'MongoNotConnectedError')
  )
}

/** "<explicación>. Mensaje del servidor: <texto> (código)". Shown, never logged. */
export function describeError(err: unknown): string {
  if (err instanceof DbUserError) return err.message
  if (err instanceof MongoServerSideError) return err.message
  if (!isErrorLike(err)) return String(err)
  return serverMessage(err)
}

function serverMessage(err: MongoErrorLike): string {
  const code = typeof err.code === 'number' ? err.code : null
  const name = err.name ?? 'Error'
  if (name === 'MongoServerSelectionError' || name === 'MongoNetworkTimeoutError')
    return `No se pudo contactar con el servidor MongoDB a tiempo: revisa el host, el puerto, el túnel y la red. Detalle: ${err.message}`
  if (name === 'MongoNetworkError')
    return `Se perdió la conexión con el servidor MongoDB. Detalle: ${err.message}`
  if (name === 'MongoParseError' || name === 'MongoInvalidArgumentError')
    return `Opción de conexión no válida: ${err.message}`
  const explanation = code !== null ? EXPLAINED[code] : undefined
  // A server reply (it has a numeric code) is marked as the server's text.
  let text =
    code !== null ? withServerMessage(explanation, err.message ?? name) : (err.message ?? name)
  if (code === 121) {
    const info = summarizeErrInfo(err.errInfo ?? err.errorResponse?.errInfo)
    if (info) text += ` · ${info}`
  }
  const codeName = err.codeName ?? err.errorResponse?.codeName
  if (code !== null) text += ` (${codeName ? `${codeName} ` : ''}${code})`
  return text
}

/** A one-line summary of a validation failure's errInfo (shown only). */
function summarizeErrInfo(info: unknown): string | null {
  if (!info || typeof info !== 'object') return null
  const details = (info as { details?: { schemaRulesNotSatisfied?: unknown[] } }).details
  const rules = details?.schemaRulesNotSatisfied
  if (!Array.isArray(rules) || !rules.length) return null
  const parts: string[] = []
  for (const rule of rules.slice(0, 5)) {
    const r = rule as {
      operatorName?: string
      propertiesNotSatisfied?: { propertyName?: string }[]
      missingProperties?: string[]
    }
    if (r.missingProperties?.length) parts.push(`faltan: ${r.missingProperties.join(', ')}`)
    else if (r.propertiesNotSatisfied?.length)
      parts.push(
        `no cumplen: ${r.propertiesNotSatisfied.map((p) => p.propertyName ?? '?').join(', ')}`
      )
    else if (r.operatorName) parts.push(r.operatorName)
  }
  return parts.length ? parts.join('; ') : null
}

/**
 * Wraps a raw driver error so its text is shown but never logged. DbUserError
 * and already-wrapped errors pass through.
 */
export function toServerError(err: unknown): Error {
  if (err instanceof DbUserError || err instanceof MongoServerSideError) return err
  if (!isErrorLike(err)) return new MongoServerSideError(String(err), null, 'Error')
  const code = typeof err.code === 'number' || typeof err.code === 'string' ? err.code : null
  return new MongoServerSideError(serverMessage(err), code, err.name ?? 'Error')
}

/** Class and code only (invariant 5). */
export function describeForLog(err: unknown): string {
  if (err instanceof MongoServerSideError) return `${err.driverName}(${err.code ?? 'sin código'})`
  return describeDbErrorForLog(err)
}
