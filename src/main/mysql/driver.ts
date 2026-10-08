/**
 * MySQL driver: adapts the v0.1.0 mysql2 pool code (moved here verbatim from
 * mysql/manager.ts) to the engine-neutral Driver interface. The generic
 * ConnectionManager (src/main/db/manager.ts) owns open dedupe, secrets, the
 * SSH tunnel, fatal handling and closeAll; this file owns everything mysql2.
 * No SQL text changed in the move.
 */
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
import { mariadbDialect } from '@shared/dialects/mariadb'
import { mysqlDialect } from '@shared/dialects/mysql'
import type {
  ConnectionConfig,
  ConnectionInput,
  ConnectionTestResult,
  ServerInfo
} from '@shared/types'
import type { SqlDialect } from '@shared/dialects/types'
import type { Driver, DriverSecrets, Endpoint, MysqlFamilyConnection, Scope } from '../db/driver'
import { getLogger } from '../log'
import {
  MysqlUserError,
  describeError,
  describeForLog,
  isAuthRejected,
  isConnectionLost
} from './errors'
import { mariaDbAuthPlugins } from './authPlugins'
import { fetchServerInfo, type Queryable } from './introspect'
import { PooledSession } from './session'

const log = getLogger('mysql.manager')

const CONNECTION_LIMIT = 4
const CONNECT_TIMEOUT_MS = 15000

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
    ssl: await buildSsl(config),
    // MariaDB ed25519 / parsec accounts; a MySQL server never asks for these plugins.
    authPlugins: mariaDbAuthPlugins()
  }
}

export function missingPasswordError(name: string): MysqlUserError {
  return new MysqlUserError(
    `No hay contraseña guardada para la conexión ${name}: escríbela en la conexión o marca «Sin contraseña»`,
    'E_MYSQL_NO_PASSWORD'
  )
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
 * «Probar conexión» note when the configured engine and the server differ
 * (P5): a MySQL connection to MariaDB is stored as MariaDB when it opens; a
 * MariaDB connection to MySQL works, but MariaDB-only features fail.
 */
export function flavorHint(
  engine: ConnectionInput['engine'],
  flavor: string | undefined
): string | null {
  if ((engine ?? 'mysql') === 'mysql' && flavor === 'mariadb')
    return 'El servidor es MariaDB: al abrirla, la conexión se guardará como MariaDB.'
  if (engine === 'mariadb' && flavor === 'mysql')
    return 'El servidor es MySQL: crea la conexión como MySQL (las secuencias y otras funciones de MariaDB no existen en él).'
  return null
}

/** MySQL always connects to a host; the manager resolves the tunnel first. */
function requireEndpoint(endpoint: Endpoint | null): Endpoint {
  if (!endpoint) throw new MysqlUserError('La conexión MySQL necesita un servidor y un puerto')
  return endpoint
}

/**
 * One mysql2 pool for one ConnectionConfig, and dedicated sessions on top of it.
 */
export class MysqlDriverConnection implements MysqlFamilyConnection {
  readonly family = 'sql' as const
  /** MariaDB connections split `/*M!` comments as code and guard sequence functions. */
  readonly dialect: SqlDialect
  private activeSessions = 0
  /** Outcome of the initial queries of each pooled connection: null = ok, else the error text. */
  private readonly initialState = new WeakMap<object, Promise<string | null>>()
  private version = ''

  constructor(
    readonly config: ConnectionConfig,
    readonly pool: Pool
  ) {
    this.dialect = config.engine === 'mariadb' ? mariadbDialect : mysqlDialect
    this.attachPoolHooks()
  }

  get serverVersion(): string {
    return this.version
  }

  /** Reads the server version on a first pooled connection (runs the initial queries). */
  async probe(): Promise<void> {
    const probe = await this.checkout()
    try {
      const [rows] = await probe.query('SELECT VERSION() AS version')
      this.version = String((rows as { version: string }[])[0]?.version ?? '')
    } finally {
      probe.release()
    }
  }

  async acquire(scope: Scope | null): Promise<PooledSession> {
    const schema = scope?.database ?? null
    const conn = await this.checkout()
    this.activeSessions++
    const session = new PooledSession(this.config.id, this.version, conn, () => {
      this.activeSessions = Math.max(0, this.activeSessions - 1)
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

  async serverInfo(): Promise<ServerInfo> {
    const conn = await this.checkout()
    try {
      return await fetchServerInfo(queryableOf(conn), this.config)
    } finally {
      conn.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  /**
   * Per pooled connection: a lost socket only affects that connection (mysql2
   * removes it from the pool and opens a new one on demand), so it is logged
   * and never tears down the pool, which may have busy sessions. Only the SSH
   * tunnel closing is fatal for the whole connection (see the manager).
   * Initial queries run once per physical connection; their outcome is kept so
   * checkout() can refuse a connection that is not configured as requested.
   */
  private attachPoolHooks(): void {
    const config = this.config
    const initial = this.dialect.splitStatements(config.initialQueries ?? '')
    this.pool.on('connection', (raw) => {
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
  private async checkout(): Promise<PoolConnection> {
    const conn = await this.pool.getConnection()
    const failure = await (this.initialState.get(conn.connection as unknown as object) ??
      Promise.resolve(null))
    if (failure) {
      conn.destroy()
      log.debug(`refused a pooled connection of ${this.config.name}: initial queries failed`)
      throw new MysqlUserError(failure)
    }
    return conn
  }
}

export const mysqlDriver: Driver = {
  engines: ['mysql', 'mariadb'],

  /** Opens a throw-away connection with the given settings; never persists anything. */
  async test(
    input: ConnectionInput,
    secrets: DriverSecrets,
    endpoint: Endpoint | null,
    startedAt: number
  ): Promise<ConnectionTestResult> {
    const options = await buildOptions(
      input,
      secrets.password ?? undefined,
      requireEndpoint(endpoint)
    )
    const conn = await createConnection(options)
    try {
      const info = await fetchServerInfo(queryableOf(conn), input)
      const hint = flavorHint(input.engine, info.runtime?.flavor)
      return {
        ok: true,
        serverVersion: info.version,
        durationMs: Math.round(performance.now() - startedAt),
        ...(hint ? { details: [hint] } : {})
      }
    } finally {
      await conn.end().catch(() => conn.destroy())
    }
  },

  async open(config, secrets, endpoint): Promise<MysqlDriverConnection> {
    // MySQL never reports a fatal error itself: a lost socket only drops that
    // pooled connection. The SSH tunnel closing is handled by the manager.
    const pool = createPool(
      await buildOptions(config, secrets.password ?? undefined, requireEndpoint(endpoint))
    )
    const connection = new MysqlDriverConnection(config, pool)
    try {
      await connection.probe()
      return connection
    } catch (err) {
      await pool.end().catch(() => undefined)
      throw err
    }
  },

  describeForUser: describeError,
  describeForLog,
  userError: (message) => new MysqlUserError(message),
  isAuthRejected,
  missingPasswordError
}
