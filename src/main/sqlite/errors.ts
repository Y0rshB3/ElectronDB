/**
 * SQLite error taxonomy (docs/multi-engine-design.md, section 5.7).
 *
 * - SqliteUserError: written by Vortaq (path checks, the shared-transaction
 *   rule, cancel), safe to show and to log.
 * - SqliteServerError: text from SQLite. It rarely echoes values, but a syntax
 *   error quotes the statement, so it is shown and logged only as its code.
 */
import { explainSqliteError } from '@shared/dialects/sqlite'
import { DbUserError, ServerError, describeForLog as describeDbErrorForLog } from '../db/errors'
import type { WorkerError } from './protocol'

export class SqliteUserError extends DbUserError {
  constructor(message: string, code = 'E_SQLITE_USER') {
    super(message, code)
    this.name = 'SqliteUserError'
  }
}

export class SqliteServerError extends ServerError {
  constructor(
    message: string,
    /** SQLite extended result code. */
    readonly errcode: number | null
  ) {
    super(message, errcode)
    this.name = 'SqliteServerError'
  }
}

/** Error of a worker answer, as a JS error of the right class. */
export function fromWorkerError(error: WorkerError): Error {
  if (error.trusted) return new SqliteUserError(error.message, error.code ?? 'E_SQLITE_USER')
  return new SqliteServerError(error.message, error.errcode)
}

/** Names of the result codes Vortaq explains (for the "(CODE)" suffix). */
const CODE_NAMES: Record<number, string> = {
  1: 'SQLITE_ERROR',
  5: 'SQLITE_BUSY',
  6: 'SQLITE_LOCKED',
  8: 'SQLITE_READONLY',
  9: 'SQLITE_INTERRUPT',
  11: 'SQLITE_CORRUPT',
  13: 'SQLITE_FULL',
  14: 'SQLITE_CANTOPEN',
  19: 'SQLITE_CONSTRAINT',
  23: 'SQLITE_AUTH',
  26: 'SQLITE_NOTADB',
  275: 'SQLITE_CONSTRAINT_CHECK',
  264: 'SQLITE_READONLY_RECOVERY',
  520: 'SQLITE_READONLY_CANTLOCK',
  776: 'SQLITE_READONLY_ROLLBACK',
  787: 'SQLITE_CONSTRAINT_FOREIGNKEY',
  1032: 'SQLITE_READONLY_DBMOVED',
  1299: 'SQLITE_CONSTRAINT_NOTNULL',
  1555: 'SQLITE_CONSTRAINT_PRIMARYKEY',
  2067: 'SQLITE_CONSTRAINT_UNIQUE',
  3091: 'SQLITE_CONSTRAINT_DATATYPE'
}

export function codeName(errcode: number): string {
  return CODE_NAMES[errcode] ?? `SQLITE ${errcode}`
}

/** "<explanation>: <SQLite message> (SQLITE_NAME)". */
export function describeError(err: unknown): string {
  if (err instanceof DbUserError) return err.message
  if (err instanceof SqliteServerError) {
    const explanation = err.errcode !== null ? explainSqliteError(String(err.errcode)) : null
    const text = explanation ? `${explanation} Detalle: ${err.message}` : err.message
    return err.errcode !== null ? `${text} (${codeName(err.errcode)})` : text
  }
  return err instanceof Error ? err.message : String(err)
}

export const describeForLog = describeDbErrorForLog

/** The SQLite result code of an error, when it has one. */
export function sqliteErrcode(err: unknown): number | null {
  return err instanceof SqliteServerError ? err.errcode : null
}

export const CANCELLED_MESSAGE =
  'Consulta cancelada; la conexión se ha reabierto y se han perdido las tablas temporales, los ATTACH de sesión y la transacción abierta.'

export const OTHER_TAB_TRANSACTION =
  'Hay una transacción abierta en otra pestaña de consulta de esta conexión: confírmala o deshazla allí antes de escribir (las lecturas sí se pueden ejecutar).'

export const WORKER_GONE = 'El proceso de SQLite terminó inesperadamente.'
