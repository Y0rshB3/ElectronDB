import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import type { Connection as CoreConnection } from 'mysql2'
import {
  createPool,
  createConnection,
  type Pool,
  type PoolConnection,
  type PoolOptions,
  type SslOptions
} from 'mysql2/promise'
import type {
  ConnectionConfig,
  ConnectionInput,
  ConnectionTestResult,
  ServerInfo
} from '@shared/types'
import type { AppContext } from '../context'
import { getLogger } from '../log'
import { MysqlUserError, describeError, isAuthRejected, isConnectionLost } from './errors'
import { fetchServerInfo, type Queryable } from './introspect'
import { PooledSession } from './session'
import { splitStatements } from './sqlSplit'
import { openSshTunnel, type SshTunnel } from './tunnel'
import type { SessionFactory } from './types'

const log = getLogger('mysql.manager')

const CONNECTION_LIMIT = 4
const CONNECT_TIMEOUT_MS = 15000

interface OpenEntry {
  config: ConnectionConfig
  pool: Pool
  tunnel: SshTunnel | null
  serverVersion: string
  activeSessions: number
}

interface Endpoint {
  host: string
  port: number
}

interface Resolved {
  endpoint: Endpoint
  tunnel: SshTunnel | null
}

/**
 * Password to send, decided before connecting.
 * - 'none' mode: never a password, never the missing-password error.
 * - 'password' mode with a typed or stored password: that password.
 * - 'password' mode with nothing: one attempt with an empty password
 *   (`emptyAttempt`); if the server rejects it the caller reports
 *   missingPasswordError instead of the raw access-denied message.
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

export function missingPasswordError(name: string): MysqlUserError {
  return new MysqlUserError(
    `No hay contraseña guardada para la conexión ${name}: escríbela en la conexión o marca «Sin contraseña»`,
    'E_MYSQL_NO_PASSWORD'
  )
}

export async function buildSsl(config: ConnectionInput): Promise<SslOptions | undefined> {
  if (!config.ssl.enabled) return undefined
  const ssl: SslOptions = { rejectUnauthorized: config.ssl.verifyServer }
  const read = async (path: string | undefined, what: string): Promise<Buffer | undefined> => {
    if (!path) return undefined
    try {
      return await readFile(path)
    } catch {
      throw new MysqlUserError(`No se pudo leer el archivo ${what} SSL en ${path}`)
    }
  }
  ssl.ca = await read(config.ssl.caCertPath, 'CA')
  ssl.cert = await read(config.ssl.clientCertPath, 'de certificado cliente')
  ssl.key = await read(config.ssl.clientKeyPath, 'de clave cliente')
  return ssl
}

/**
 * Keeps GEOMETRY values as the raw MySQL internal format (SRID + WKB) instead
 * of mysql2's parsed {x, y} objects, so backups can re-insert them verbatim and
 * the grid shows them as 0xHEX like any other binary value.
 */
export function castGeometryAsBuffer(
  field: { type: string; buffer(): Buffer | null },
  next: () => unknown
): unknown {
  return field.type === 'GEOMETRY' ? field.buffer() : next()
}

export async function buildOptions(
  config: ConnectionInput,
  password: string | undefined,
  endpoint: Endpoint
): Promise<PoolOptions> {
  return {
    host: endpoint.host,
    port: endpoint.port,
    user: config.username,
    // Omitted (not '') when there is none, so mysql2 sends an empty auth response.
    ...(password !== undefined ? { password } : {}),
    connectionLimit: CONNECTION_LIMIT,
    waitForConnections: true,
    queueLimit: 0,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    // JSON stays the server's text: no float rounding, big numbers kept exact.
    jsonStrings: true,
    typeCast: castGeometryAsBuffer,
    multipleStatements: false,
    charset: 'utf8mb4',
    connectTimeout: CONNECT_TIMEOUT_MS,
    ssl: await buildSsl(config)
  }
}

/** Adapts a promise connection/pool to the tiny Queryable used by introspection. */
function queryableOf(conn: { query(sql: string): Promise<[unknown, unknown]> }): Queryable {
  return {
    query: async <T>(sql: string): Promise<T[]> => {
      const [rows] = await conn.query(sql)
      return Array.isArray(rows) ? (rows as T[]) : []
    }
  }
}

/**
 * Per-AppContext connection manager: one mysql2 pool (plus optional SSH
 * tunnel) per ConnectionConfig id, and dedicated sessions on top of it.
 */
export class ConnectionManager implements SessionFactory {
  private readonly entries = new Map<string, OpenEntry>()
  private readonly opening = new Map<string, Promise<OpenEntry>>()
  /** Outcome of the initial queries of each pooled connection: null = ok, else the error text. */
  private readonly initialState = new WeakMap<object, Promise<string | null>>()

  constructor(private readonly ctx: AppContext) {}

  isOpen(id: string): boolean {
    return this.entries.has(id)
  }

  async open(id: string): Promise<ServerInfo> {
    const entry = await this.ensureOpen(id)
    return this.serverInfo(entry)
  }

  async getPool(id: string): Promise<Pool> {
    return (await this.ensureOpen(id)).pool
  }

  async acquire(id: string, schema?: string | null): Promise<PooledSession> {
    const entry = await this.ensureOpen(id)
    const conn = await this.checkout(entry.pool, entry.config)
    entry.activeSessions++
    const session = new PooledSession(id, entry.serverVersion, conn, () => {
      entry.activeSessions = Math.max(0, entry.activeSessions - 1)
    })
    if (schema) {
      try {
        await session.useSchema(schema)
      } catch (err) {
        await session.release()
        throw new Error(`No se pudo seleccionar la base de datos ${schema}: ${describeError(err)}`)
      }
    }
    return session
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
    try {
      const plan = planPassword(
        input,
        input.authMode === 'none'
          ? null
          : (password ?? (input.id ? this.ctx.credentials.get('mysql', input.id) : null))
      )
      const sshSecret = sshPassword ?? (input.id ? this.ctx.credentials.get('ssh', input.id) : null)
      resolved = await this.resolveEndpoint(input, sshSecret)
      const options = await buildOptions(input, plan.password, resolved.endpoint)
      let conn: Awaited<ReturnType<typeof createConnection>>
      try {
        conn = await createConnection(options)
      } catch (err) {
        if (plan.emptyAttempt && isAuthRejected(err)) throw missingPasswordError(input.name)
        throw err
      }
      try {
        const info = await fetchServerInfo(queryableOf(conn), input)
        return {
          ok: true,
          serverVersion: info.version,
          durationMs: Math.round(performance.now() - started),
          ...(plan.emptyAttempt ? { connectedWithoutPassword: true } : {})
        }
      } finally {
        await conn.end().catch(() => conn.destroy())
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof MysqlUserError ? err.message : describeError(err),
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
    const config = this.ctx.connections.get(id)
    if (!config) throw new MysqlUserError(`La conexión ${id} no existe`)
    const plan = planPassword(
      config,
      config.authMode === 'none' ? null : this.ctx.credentials.get('mysql', id)
    )

    let resolved: Resolved | null = null
    let pool: Pool | null = null
    try {
      resolved = await this.resolveEndpoint(config, this.ctx.credentials.get('ssh', id))
      pool = createPool(await buildOptions(config, plan.password, resolved.endpoint))
      this.attachPoolHooks(pool, config)
      const probe = await this.checkout(pool, config)
      let serverVersion: string
      try {
        const [rows] = await probe.query('SELECT VERSION() AS version')
        serverVersion = String((rows as { version: string }[])[0]?.version ?? '')
      } finally {
        probe.release()
      }
      const entry: OpenEntry = {
        config,
        pool,
        tunnel: resolved.tunnel,
        serverVersion,
        activeSessions: 0
      }
      resolved.tunnel?.onClose((reason) => this.handleFatal(id, reason))
      this.entries.set(id, entry)
      log.info(
        `connection ${config.name} opened (server ${serverVersion})` +
          (plan.emptyAttempt ? ' without a password: none is stored and the server accepted it' : '')
      )
      return entry
    } catch (err) {
      await pool?.end().catch(() => undefined)
      await resolved?.tunnel?.close().catch(() => undefined)
      if (err instanceof MysqlUserError) throw err
      if (plan.emptyAttempt && isAuthRejected(err)) throw missingPasswordError(config.name)
      throw new Error(`No se pudo conectar a ${config.name}: ${describeError(err)}`)
    }
  }

  private async resolveEndpoint(
    config: ConnectionInput,
    sshSecret: string | null
  ): Promise<Resolved> {
    if (!config.ssh.enabled)
      return { endpoint: { host: config.host, port: config.port }, tunnel: null }
    const tunnel = await openSshTunnel({
      ssh: config.ssh,
      secret: sshSecret,
      targetHost: config.host,
      targetPort: config.port,
      readyTimeout: CONNECT_TIMEOUT_MS
    })
    return { endpoint: { host: tunnel.localHost, port: tunnel.localPort }, tunnel }
  }

  /**
   * Per pooled connection: a lost socket only affects that connection (mysql2
   * removes it from the pool and opens a new one on demand), so it is logged
   * and never tears down the pool, which may have busy sessions. Only the SSH
   * tunnel closing is fatal for the whole connection (see doOpen).
   * Initial queries run once per physical connection; their outcome is kept so
   * checkout() can refuse a connection that is not configured as requested.
   */
  private attachPoolHooks(pool: Pool, config: ConnectionConfig): void {
    const initial = splitStatements(config.initialQueries ?? '')
    pool.on('connection', (raw) => {
      // The promise pool forwards the core (callback) connection here.
      const conn = raw as unknown as CoreConnection
      conn.on('error', (err) => {
        if (isConnectionLost(err))
          log.info(`a pooled connection of ${config.name} was dropped: ${describeError(err)}`)
        else log.warn(`connection ${config.name} reported an error: ${describeError(err)}`)
      })
      if (initial.length === 0) return
      const outcome = (async (): Promise<string | null> => {
        for (const stmt of initial) {
          const failure = await new Promise<string | null>((resolve) => {
            conn.query(stmt.sql, (err) => resolve(err ? describeError(err) : null))
          })
          if (failure) {
            log.warn(`initial query #${stmt.startLine} failed on ${config.name}: ${failure}`)
            return `La consulta inicial de la línea ${stmt.startLine} falló en ${config.name}: ${failure}. Revisa las consultas iniciales de la conexión.`
          }
        }
        return null
      })()
      this.initialState.set(conn, outcome)
    })
  }

  /** Borrows a pooled connection whose initial queries succeeded. */
  private async checkout(pool: Pool, config: ConnectionConfig): Promise<PoolConnection> {
    const conn = await pool.getConnection()
    const failure = await (this.initialState.get(conn.connection as unknown as object) ??
      Promise.resolve(null))
    if (failure) {
      conn.destroy()
      log.debug(`refused a pooled connection of ${config.name}: initial queries failed`)
      throw new MysqlUserError(failure)
    }
    return conn
  }

  private handleFatal(id: string, reason: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    log.warn(`connection ${entry.config.name} lost: ${reason}`)
    void this.teardown(entry)
    this.ctx.emit('event:connectionClosed', { connectionId: id, reason })
  }

  private async teardown(entry: OpenEntry): Promise<void> {
    try {
      await entry.pool.end()
    } catch (err) {
      log.debug(`pool end failed for ${entry.config.name}: ${describeError(err)}`)
    }
    await entry.tunnel?.close().catch(() => undefined)
  }

  private async serverInfo(entry: OpenEntry): Promise<ServerInfo> {
    const conn = await this.checkout(entry.pool, entry.config)
    try {
      return await fetchServerInfo(queryableOf(conn), entry.config)
    } finally {
      conn.release()
    }
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

export function getSessionFactory(ctx: AppContext): SessionFactory {
  return getConnectionManager(ctx)
}
