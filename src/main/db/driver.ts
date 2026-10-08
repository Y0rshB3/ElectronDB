/**
 * Driver interfaces of the engine-neutral layer (docs/multi-engine-design.md,
 * section 5.2). P1a declares the members the generic ConnectionManager and the
 * MySQL adapter use today; each later member (tab sessions, cancel,
 * introspector, document operations) is added with its first consumer.
 */
import type { SqlDialect } from '@shared/dialects/types'
import type {
  ConnectionConfig,
  ConnectionInput,
  ConnectionTestResult,
  EngineId,
  ServerInfo
} from '@shared/types'
import type { Pool } from 'mysql2/promise'
import type { PooledSession } from '../mysql/session'
import type { DbUserError } from './errors'

/** Where the driver connects; already tunnel-resolved by the manager. */
export interface Endpoint {
  host: string
  port: number
  /** Real host for TLS SNI/verification when connecting through a tunnel (P2a). */
  tlsServername?: string
}

export interface DriverSecrets {
  /** Credential slot 'mysql:<id>', the generic database password (D10). */
  password: string | null
  /** 'ssh:<id>': SSH password or key passphrase. Consumed by the manager's tunnel. */
  sshPassword: string | null
  /** 'sslKey:<id>': passphrase of the SSL client key (PostgreSQL); absent/null = none. */
  sslKeyPassword?: string | null
}

export interface DriverHooks {
  /** The connection is gone for good; the manager tears it down and tells the renderer. */
  onFatal(reason: string): void
  /**
   * Writes to this connection need the typed confirmation right now (production,
   * Ajustes › Seguridad). Engines with server-side read-only sessions (PostgreSQL)
   * open them read-only while it is true. Absent => false.
   */
  isGuarded?(): boolean
}

export interface Driver {
  /** Engines this driver serves (the MySQL driver also serves MariaDB from P5). */
  readonly engines: readonly EngineId[]
  /**
   * Opens a throw-away connection and reads the server version. Throws on
   * failure; the manager turns the error into `{ ok: false }` with
   * describeForUser. `startedAt` (performance.now()) is when the manager began,
   * tunnel included, so durationMs measures the same span as v0.1.0.
   */
  test(
    config: ConnectionInput,
    secrets: DriverSecrets,
    endpoint: Endpoint | null,
    startedAt: number
  ): Promise<ConnectionTestResult>
  /** Opens a long-lived connection; on failure it releases whatever it created. */
  open(
    config: ConnectionConfig,
    secrets: DriverSecrets,
    endpoint: Endpoint | null,
    hooks: DriverHooks
  ): Promise<DriverConnection>
  /** Spanish text for the user plus the "(CODE)" suffix privileges.ts/friendlyError parse. */
  describeForUser(err: unknown): string
  /** Code and object name only: safe for the log (invariant 5). */
  describeForLog(err: unknown): string
  /** The driver's DbUserError subclass, so its code suffix stays the engine's own. */
  userError(message: string): DbUserError
  /**
   * The server rejected the credentials (wrong or missing password, or an auth
   * plugin the attempt cannot satisfy); a database-level denial is not one.
   */
  isAuthRejected(err: unknown): boolean
  /**
   * Actionable error for an empty-password attempt the server rejected, when no
   * password is typed or stored and the connection is in 'password' mode.
   */
  missingPasswordError(name: string): DbUserError
}

interface DriverConnectionBase {
  readonly config: ConnectionConfig
  readonly serverVersion: string
  serverInfo(): Promise<ServerInfo>
  close(): Promise<void>
}

export interface Scope {
  database: string | null
  schema: string | null
}

/** The part of an internal pooled session every SQL engine provides. */
export interface SqlSession {
  readonly connectionId: string
  readonly serverVersion: string
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  release(): Promise<void>
}

export interface SqlDriverConnection<
  S extends SqlSession = SqlSession
> extends DriverConnectionBase {
  readonly family: 'sql'
  readonly dialect: SqlDialect
  /** Pooled internal session (introspection, grid saves, table data, backups). */
  acquire(scope: Scope | null): Promise<S>
}

/**
 * A document engine (MongoDB): no SQL sessions; its own mongo:* handlers work
 * on the concrete connection class (src/main/mongo/connection.ts).
 */
export interface DocumentDriverConnection extends DriverConnectionBase {
  readonly family: 'document'
}

export type DriverConnection = SqlDriverConnection<SqlSession> | DocumentDriverConnection

/**
 * Connections whose sessions are today's MysqlSession-based PooledSession.
 * Backups, jobs and the db:* handlers keep using that type in P1a (section 5.2).
 */
export type MysqlFamilyConnection = SqlDriverConnection<PooledSession> & {
  /** The mysql2 pool (ConnectionManager.getPool, v0.1.x API). */
  readonly pool: Pool
}

export function isMysqlFamily(connection: DriverConnection): connection is MysqlFamilyConnection {
  return (
    connection.family === 'sql' &&
    (connection.dialect.id === 'mysql' || connection.dialect.id === 'mariadb')
  )
}
