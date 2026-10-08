/**
 * Engine-neutral connection manager (docs/multi-engine-design.md, section 5.3).
 * Moved from mysql/manager.ts: open dedupe, secrets, SSH tunnel resolution,
 * fatal handling and closeAll. Everything engine-specific goes through the
 * driver from the registry (MySQL: src/main/mysql/driver.ts).
 */
import { performance } from 'node:perf_hooks'
import { engineOf } from '@shared/engines'
import type {
  ConnectionConfig,
  ConnectionInput,
  ConnectionTestResult,
  EngineId,
  ServerInfo
} from '@shared/types'
import type { AppContext } from '../context'
import { DB_PASSWORD } from '../credentials/store'
import { getLogger } from '../log'
import type { PooledSession } from '../mysql/session'
import type { SessionFactory } from '../mysql/types'
import {
  isMysqlFamily,
  type Driver,
  type DriverConnection,
  type DriverSecrets,
  type Endpoint,
  type MysqlFamilyConnection
} from './driver'
import { CAPABILITY_MESSAGES, DbUserError, requireCapability } from './errors'
import { getDriver } from './registry'
import { openSshTunnel, type SshTunnel } from './tunnel'
import { needsTypedConfirm } from '../ipc/productionGuard'
import { servesMariaDb } from '../migration/mariadbEngine'

// Log scope kept from v0.1.0 so existing log lines read the same.
const log = getLogger('mysql.manager')

/** SSH handshake timeout; the same 15 s v0.1.0 used for MySQL. */
const TUNNEL_READY_TIMEOUT_MS = 15000

interface OpenEntry {
  config: ConnectionConfig
  driver: Driver
  connection: DriverConnection
  tunnel: SshTunnel | null
}

interface Resolved {
  endpoint: Endpoint | null
  tunnel: SshTunnel | null
}

export type DriverLookup = (engine: EngineId) => Promise<Driver>

export interface ConnectionManagerOptions {
  /** Overrides the driver registry (unit tests). */
  drivers?: DriverLookup
}

/**
 * Password to send, decided before connecting (v0.1.8 «Sin contraseña»).
 * - 'none' mode: never a password, never the missing-password error.
 * - 'password' mode with a typed or stored password: that password.
 * - 'password' mode with nothing: one attempt with an empty password
 *   (`emptyAttempt`); if the server rejects it the caller reports the
 *   driver's missingPasswordError instead of the raw access-denied message.
 */
export interface PasswordPlan {
  password: string | undefined
  emptyAttempt: boolean
}

export function planPassword(
  config: Pick<ConnectionInput, 'authMode'>,
  provided: string | null
): PasswordPlan {
  if (config.authMode === 'none') return { password: undefined, emptyAttempt: false }
  if (provided !== null) return { password: provided, emptyAttempt: false }
  return { password: undefined, emptyAttempt: true }
}

/** Plain message of anything thrown before a driver is known. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Per-AppContext connection manager: one driver connection (plus optional SSH
 * tunnel) per ConnectionConfig id, and dedicated sessions on top of it.
 */
export class ConnectionManager implements SessionFactory {
  private readonly entries = new Map<string, OpenEntry>()
  private readonly opening = new Map<string, Promise<OpenEntry>>()
  private readonly drivers: DriverLookup

  constructor(
    private readonly ctx: AppContext,
    options: ConnectionManagerOptions = {}
  ) {
    this.drivers = options.drivers ?? getDriver
  }

  isOpen(id: string): boolean {
    return this.entries.has(id)
  }

  async open(id: string): Promise<ServerInfo> {
    const entry = await this.ensureOpen(id)
    return entry.connection.serverInfo()
  }

  /**
   * A dedicated session on a MySQL connection (SessionFactory). The db:*
   * handlers, backups and jobs use today's PooledSession; other engines get
   * their own session types in their phases.
   */
  async acquire(id: string, schema?: string | null): Promise<PooledSession> {
    const { connection } = await this.ensureOpen(id)
    if (!isMysqlFamily(connection)) {
      throw new DbUserError(
        `${engineOf(connection.config).label} todavía no está disponible en esta versión de Vortaq.`,
        'E_ENGINE_UNAVAILABLE'
      )
    }
    return connection.acquire(schema ? { database: schema, schema: null } : null)
  }

  /**
   * The open driver connection of any engine (opening it on first use). The
   * engine-specific db:* handlers (PostgreSQL) work on it directly.
   */
  async connection(id: string): Promise<DriverConnection> {
    return (await this.ensureOpen(id)).connection
  }

  /**
   * The mysql2 pool of a MySQL connection (v0.1.x API, used by tests and
   * diagnostics). Other engines have no pool to hand out.
   */
  async getPool(id: string): Promise<MysqlFamilyConnection['pool']> {
    const { connection } = await this.ensureOpen(id)
    if (!isMysqlFamily(connection)) {
      throw new DbUserError(
        `${engineOf(connection.config).label} todavía no está disponible en esta versión de Vortaq.`,
        'E_ENGINE_UNAVAILABLE'
      )
    }
    return connection.pool
  }

  async close(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    await this.teardown(entry)
    log.info(`connection ${entry.config.name} closed`)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.close(id)))
  }

  /** Opens a throw-away connection with the given settings; never persists anything. */
  async test(
    input: ConnectionInput,
    password: string | null,
    sshPassword: string | null
  ): Promise<ConnectionTestResult> {
    const started = performance.now()
    let resolved: Resolved | null = null
    let driver: Driver | null = null
    try {
      const engine = engineOf(input)
      driver = await this.drivers(engine.id)
      const plan = planPassword(
        input,
        input.authMode === 'none'
          ? null
          : (password ?? (input.id ? this.ctx.credentials.get(DB_PASSWORD, input.id) : null))
      )
      const sshSecret = sshPassword ?? (input.id ? this.ctx.credentials.get('ssh', input.id) : null)
      const sslKeyPassword = input.id ? this.ctx.credentials.get('sslKey', input.id) : null
      resolved = await this.resolveEndpoint(input, sshSecret)
      let result: ConnectionTestResult
      try {
        result = await driver.test(
          input,
          { password: plan.password ?? null, sshPassword: sshSecret, sslKeyPassword },
          resolved.endpoint,
          started
        )
      } catch (err) {
        if (plan.emptyAttempt && driver.isAuthRejected(err))
          throw driver.missingPasswordError(input.name)
        throw err
      }
      return plan.emptyAttempt && result.ok ? { ...result, connectedWithoutPassword: true } : result
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof DbUserError
            ? err.message
            : driver
              ? driver.describeForUser(err)
              : messageOf(err),
        durationMs: Math.round(performance.now() - started)
      }
    } finally {
      await resolved?.tunnel?.close().catch(() => undefined)
    }
  }

  /* ---------- internals ---------- */

  private ensureOpen(id: string): Promise<OpenEntry> {
    const existing = this.entries.get(id)
    if (existing) return Promise.resolve(existing)
    const pending = this.opening.get(id)
    if (pending) return pending
    const task = this.doOpen(id).finally(() => this.opening.delete(id))
    this.opening.set(id, task)
    return task
  }

  private async doOpen(id: string): Promise<OpenEntry> {
    const stored = this.ctx.connections.get(id)
    if (!stored) throw new DbUserError(`La conexión ${id} no existe`)
    let config: ConnectionConfig = stored
    const engine = engineOf(config)
    const driver = await this.drivers(engine.id)
    const plan = planPassword(
      config,
      config.authMode === 'none' ? null : this.ctx.credentials.get(DB_PASSWORD, id)
    )

    let resolved: Resolved | null = null
    try {
      const sshPassword = this.ctx.credentials.get('ssh', id)
      resolved = await this.resolveEndpoint(config, sshPassword)
      const secrets: DriverSecrets = {
        password: plan.password ?? null,
        sshPassword,
        sslKeyPassword: this.ctx.credentials.get('sslKey', id)
      }
      const hooks = {
        onFatal: (reason: string) => this.handleFatal(id, reason),
        // Read the stored config each time: the environment can change while it is open.
        isGuarded: () => needsTypedConfirm(this.ctx, this.ctx.connections.get(id) ?? config)
      }
      let connection = await driver.open(config, secrets, resolved.endpoint, hooks)
      // P5: a `mysql` connection whose server is MariaDB becomes a `mariadb` one
      // (interactive runs only: a headless job never rewrites connections.json).
      if (!this.ctx.headless && servesMariaDb(config, connection.serverVersion)) {
        const promoted = this.ctx.connections.promoteToMariaDb(id)
        if (promoted) {
          log.info(`connection ${config.name} reports MariaDB: stored as a MariaDB connection`)
          await connection.close().catch(() => undefined)
          config = promoted
          connection = await driver.open(config, secrets, resolved.endpoint, hooks)
        }
      }
      const entry: OpenEntry = { config, driver, connection, tunnel: resolved.tunnel }
      resolved.tunnel?.onClose((reason) => this.handleFatal(id, reason))
      this.entries.set(id, entry)
      log.info(
        `connection ${config.name} opened (server ${connection.serverVersion})` +
          (plan.emptyAttempt
            ? ' without a password: none is stored and the server accepted it'
            : '')
      )
      return entry
    } catch (err) {
      await resolved?.tunnel?.close().catch(() => undefined)
      if (err instanceof DbUserError) throw err
      if (plan.emptyAttempt && driver.isAuthRejected(err))
        throw driver.missingPasswordError(config.name)
      throw new Error(`No se pudo conectar a ${config.name}: ${driver.describeForUser(err)}`)
    }
  }

  /** Engines without a host (SQLite) get no endpoint; SSH only where the engine supports it. */
  private async resolveEndpoint(
    config: ConnectionInput,
    sshSecret: string | null
  ): Promise<Resolved> {
    const capabilities = engineOf(config).capabilities
    if (!capabilities.needsHost) return { endpoint: null, tunnel: null }
    if (!config.ssh.enabled || !capabilities.supportsSsh)
      return { endpoint: { host: config.host, port: config.port }, tunnel: null }
    const tunnel = await openSshTunnel({
      ssh: config.ssh,
      secret: sshSecret,
      targetHost: config.host,
      targetPort: config.port,
      readyTimeout: TUNNEL_READY_TIMEOUT_MS
    })
    // tlsServername: engines that verify TLS (PostgreSQL) check the real host, not 127.0.0.1.
    return {
      endpoint: { host: tunnel.localHost, port: tunnel.localPort, tlsServername: config.host },
      tunnel
    }
  }

  private handleFatal(id: string, reason: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    log.warn(`connection ${entry.config.name} lost: ${reason}`)
    void this.teardown(entry)
    this.ctx.emit('event:connectionClosed', { connectionId: id, reason })
  }

  /** Never logs a raw driver error: closeAll runs on quit and in headless jobs. */
  private async teardown(entry: OpenEntry): Promise<void> {
    try {
      await entry.connection.close()
    } catch (err) {
      log.debug(`pool end failed for ${entry.config.name}: ${entry.driver.describeForLog(err)}`)
    }
    await entry.tunnel?.close().catch(() => undefined)
  }
}

const managers = new WeakMap<AppContext, ConnectionManager>()

export function getConnectionManager(ctx: AppContext): ConnectionManager {
  let m = managers.get(ctx)
  if (!m) {
    m = new ConnectionManager(ctx)
    managers.set(ctx, m)
  }
  return m
}

/**
 * Sessions for backups and jobs. Both stay MySQL-only (section 11): a
 * connection whose engine lacks `supportsBackupsNb3` is refused before any
 * connection is opened. A missing connection keeps the manager's own message.
 */
export function getSessionFactory(ctx: AppContext): SessionFactory {
  const manager = getConnectionManager(ctx)
  return {
    async acquire(connectionId, schema) {
      const config = ctx.connections.get(connectionId)
      if (config) requireCapability(config, 'supportsBackupsNb3', CAPABILITY_MESSAGES.sessions)
      return manager.acquire(connectionId, schema)
    }
  }
}
