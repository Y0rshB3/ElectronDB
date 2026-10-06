import { MysqlUserError } from '../mysql/errors'

export class IpcError extends Error {
  constructor(
    message: string,
    readonly code = 'E_GENERIC'
  ) {
    super(message)
  }
}

/**
 * What may reach the log file for a failed handler. Server errors (mysql2,
 * ssh2) can quote row data, e.g. "Duplicate entry 'x' for key ...", so only
 * our own user-facing errors keep their message; anything else is reduced
 * to its name and code/errno.
 */
export function describeForLog(err: unknown): string {
  if (err instanceof IpcError || err instanceof MysqlUserError) return err.message
  if (typeof err !== 'object' || err === null) return typeof err
  const e = err as { name?: unknown; code?: unknown; errno?: unknown }
  const parts = [typeof e.name === 'string' ? e.name : 'Error']
  if (typeof e.code === 'string' || typeof e.code === 'number') parts.push(String(e.code))
  if (typeof e.errno === 'number') parts.push(`errno ${e.errno}`)
  return parts.join(' ')
}
