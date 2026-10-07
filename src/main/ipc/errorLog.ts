import { describeForLog as describeDbErrorForLog } from '../db/errors'

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
 * our own user-facing errors (IpcError, DbUserError and its MysqlUserError
 * subclass) keep their message; a ServerError is logged as its code and
 * anything else is reduced to its name and code/errno (src/main/db/errors.ts).
 */
export function describeForLog(err: unknown): string {
  if (err instanceof IpcError) return err.message
  return describeDbErrorForLog(err)
}
