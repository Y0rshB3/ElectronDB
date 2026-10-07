/**
 * Engine-neutral error taxonomy (docs/multi-engine-design.md, section 5.7).
 *
 * - DbUserError: written by Vortaq, safe to show AND safe to log. It never
 *   carries server text. Each driver may subclass it (MysqlUserError) so its
 *   own `code` keeps appearing where its describeForUser appends one.
 * - ServerError: server-derived text that may echo values (a duplicate key, a
 *   rejected literal). Shown to the user, logged only as its class and code.
 * - Anything else (raw driver errors) is logged as name + code/errno only.
 */
import { engineOf, type BooleanCapability } from '@shared/engines'
import type { EngineId } from '@shared/types'

export class DbUserError extends Error {
  constructor(
    message: string,
    readonly code = 'E_DB_USER'
  ) {
    super(message)
    this.name = 'DbUserError'
  }
}

export class ServerError extends Error {
  constructor(
    message: string,
    /** Server code (SQLSTATE, errno, Mongo code...), or null when the server sent none. */
    readonly code: string | number | null = null
  ) {
    super(message)
    this.name = 'ServerError'
  }
}

/**
 * What may reach the log file for an error. Server errors can quote row data,
 * e.g. "Duplicate entry 'x' for key ...", so only DbUserError keeps its
 * message; ServerError becomes `ServerError(<code>)` and any other error is
 * reduced to its name and code/errno.
 */
export function describeForLog(err: unknown): string {
  if (err instanceof DbUserError) return err.message
  if (err instanceof ServerError) return `ServerError(${err.code ?? 'sin código'})`
  if (typeof err !== 'object' || err === null) return typeof err
  const e = err as { name?: unknown; code?: unknown; errno?: unknown }
  const parts = [typeof e.name === 'string' ? e.name : 'Error']
  if (typeof e.code === 'string' || typeof e.code === 'number') parts.push(String(e.code))
  if (typeof e.errno === 'number') parts.push(`errno ${e.errno}`)
  return parts.join(' ')
}

/**
 * Main-side capability gate: throws a DbUserError with `message` when the
 * connection's engine lacks `cap`. A missing engine means MySQL (D1); an
 * unknown engine throws the engines.ts message.
 */
export function requireCapability(
  connection: { engine?: EngineId | null },
  cap: BooleanCapability,
  message: string
): void {
  if (!engineOf(connection).capabilities[cap]) throw new DbUserError(message, 'E_CAPABILITY')
}

/** Gate messages (Spanish, shown to the user). Never reached by MySQL connections. */
export const CAPABILITY_MESSAGES = {
  /** SessionFactory: the session type backups and jobs use is MySQL's. */
  sessions:
    'Las copias de seguridad y la automatización solo están disponibles para conexiones MySQL.',
  backups: (name: string, engine: string): string =>
    `Las copias de seguridad .nb3 solo están disponibles para conexiones MySQL; «${name}» es ${engine}.`,
  automation: (name: string, engine: string): string =>
    `Las tareas automáticas solo pueden usar conexiones MySQL; «${name}» es ${engine}.`,
  events: (name: string, engine: string): string =>
    `Los eventos programados no existen en ${engine} («${name}»).`
} as const

/** requireCapability with the connection's own name and engine label in the message. */
export function requireConnectionCapability(
  connection: { name: string; engine?: EngineId | null },
  cap: BooleanCapability,
  message: (name: string, engineLabel: string) => string
): void {
  const engine = engineOf(connection)
  if (!engine.capabilities[cap])
    throw new DbUserError(message(connection.name, engine.label), 'E_CAPABILITY')
}
