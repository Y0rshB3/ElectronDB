/**
 * MongoClient options from a connection (docs/multi-engine-design.md, 5.6).
 *
 * - Credentials go in the `auth` option, never in the URI given to
 *   MongoClient; the URI built here only names hosts. Nothing here is logged.
 * - Timeouts from `network.connectTimeoutMs` (10 s by default, not the
 *   driver's 30 s); retryWrites/retryReads from the config; appName Vortaq.
 * - SRV implies TLS. With an SSH tunnel the client goes straight to the
 *   tunnel's local port (`directConnection`), with the real host as TLS
 *   servername; SRV and seed lists cannot go through a tunnel.
 * - GSSAPI, AWS and OIDC are refused; only zlib compression is requested.
 * - Document reads keep their BSON types (RAW_BSON): no promotion of
 *   Int64/Double/Int32, and regular expressions stay BSONRegExp.
 */
import { readFile } from 'node:fs/promises'
import type { MongoClientOptions } from 'mongodb'
import { isMongoCredentialOption } from '@shared/connectionValidation'
import { DEFAULT_NETWORK, defaultMongoOptions } from '@shared/engines'
import { DRIVER_AUTH_MECHANISM } from '@shared/mongo/uri'
import type { ConnectionInput, MongoOptions, NetworkOptions } from '@shared/types'
import type { Endpoint } from '../db/driver'
import { MongoUserError } from './errors'

export const APP_NAME = 'Vortaq'

/**
 * BSON options for reading user data: every value keeps its type (canonical
 * EJSON). Only on the reads that return documents: command results (counts,
 * matchedCount…) stay plain numbers.
 */
export const RAW_BSON = { promoteValues: false, promoteLongs: false, bsonRegExp: true } as const

export function mongoOf(config: Pick<ConnectionInput, 'mongo'>): MongoOptions {
  return { ...defaultMongoOptions(), ...config.mongo }
}

export function networkOf(config: Pick<ConnectionInput, 'network'>): NetworkOptions {
  return { ...DEFAULT_NETWORK, ...config.network }
}

/** Options the driver would treat as a different connection, or that only Vortaq sets. */
const RESERVED_OPTIONS = new Set(
  [
    'appname',
    'authsource',
    'authmechanism',
    'replicaset',
    'directconnection',
    'readpreference',
    'retrywrites',
    'retryreads',
    'tls',
    'ssl',
    'tlscafile',
    'tlscertificatekeyfile',
    'tlsallowinvalidcertificates',
    'tlsallowinvalidhostnames',
    'tlsinsecure',
    'connecttimeoutms',
    'serverselectiontimeoutms',
    'srvservicename',
    'loadbalanced',
    'proxyhost',
    'proxyport',
    // TLS and auth are set from the form only: an extra option must never turn verification off.
    'rejectunauthorized',
    'checkserveridentity',
    'ca',
    'cert',
    'key',
    'passphrase',
    'servername',
    'crl',
    'tlscrlfile',
    'tlscertificatefile',
    'auth',
    'authmechanismproperties',
    'promotevalues',
    'promotelongs',
    'bsonregexp',
    'raw'
  ].map((k) => k.toLowerCase())
)

export interface ClientPlan {
  /** Hosts only: never credentials. */
  uri: string
  options: MongoClientOptions
  /** Facts for «Probar conexión» (no secrets). */
  tls: boolean
}

async function readPem(path: string | undefined, what: string): Promise<Buffer | undefined> {
  if (!path) return undefined
  try {
    return await readFile(path)
  } catch {
    throw new MongoUserError(`No se pudo leer el archivo ${what} TLS en ${path}`)
  }
}

const hostPart = (host: string): string => (host.includes(':') ? `[${host}]` : host)

/**
 * URI (hosts only) and options for MongoClient. `endpoint` is already
 * tunnel-resolved by the manager: with SSH it is 127.0.0.1:<local port> and
 * carries the real host in `tlsServername`.
 */
export async function buildClientPlan(
  config: ConnectionInput,
  secrets: { password: string | null; sslKeyPassword?: string | null },
  endpoint: Endpoint | null
): Promise<ClientPlan> {
  const mongo = mongoOf(config)
  const network = networkOf(config)
  const tunnelled = config.ssh?.enabled === true
  if (tunnelled && mongo.srv)
    throw new MongoUserError('Una conexión SRV (mongodb+srv) no puede usar un túnel SSH.')
  if (tunnelled && mongo.topology !== 'standalone' && !mongo.directConnection)
    throw new MongoUserError(
      'Con un túnel SSH la conexión MongoDB debe ser independiente o directa a un miembro.'
    )

  let uri: string
  if (tunnelled) {
    if (!endpoint) throw new MongoUserError('Falta el extremo local del túnel SSH.')
    uri = `mongodb://${hostPart(endpoint.host)}:${endpoint.port}/`
  } else if (mongo.srv) {
    if (!config.host.trim()) throw new MongoUserError('Indica el nombre SRV del clúster.')
    uri = `mongodb+srv://${hostPart(config.host.trim())}/`
  } else if (mongo.topology !== 'standalone' && mongo.members.length) {
    uri = `mongodb://${mongo.members.map((m) => `${hostPart(m.host)}:${m.port}`).join(',')}/`
  } else {
    const target = endpoint ?? { host: config.host, port: config.port }
    uri = `mongodb://${hostPart(target.host)}:${target.port}/`
  }

  const options: MongoClientOptions = {
    appName: APP_NAME,
    connectTimeoutMS: network.connectTimeoutMs,
    serverSelectionTimeoutMS: network.connectTimeoutMs,
    retryWrites: mongo.retryWrites,
    retryReads: mongo.retryReads,
    readPreference: mongo.readPreference,
    // Only zlib: snappy and zstd need optional native modules that are not shipped.
    compressors: ['zlib'],
    // Small pools: a desktop client needs a few sockets, not a hundred.
    maxPoolSize: 10,
    minPoolSize: 0
  }
  if (tunnelled || mongo.directConnection || (mongo.topology === 'standalone' && !mongo.srv))
    options.directConnection = true
  if (mongo.replicaSet && !tunnelled && !mongo.directConnection)
    options.replicaSet = mongo.replicaSet

  const mechanism = mongo.authMechanism
  if (mechanism !== 'none') {
    const username = config.username?.trim() ?? ''
    if (mechanism === 'x509') {
      options.authMechanism = 'MONGODB-X509'
      if (username) options.auth = { username }
      options.authSource = '$external'
    } else if (username) {
      options.auth = { username, password: secrets.password ?? '' }
      options.authSource = mongo.authSource || 'admin'
      const driverName = DRIVER_AUTH_MECHANISM[mechanism]
      if (driverName) options.authMechanism = driverName as MongoClientOptions['authMechanism']
      if (mechanism === 'plain') options.authSource = mongo.authSource || '$external'
    }
  }

  const tls = mongo.srv || config.ssl?.enabled === true
  if (tls) {
    options.tls = true
    const ca = await readPem(config.ssl?.caCertPath, 'de la CA')
    const cert = await readPem(config.ssl?.clientCertPath, 'del certificado cliente')
    const key = await readPem(
      config.ssl?.clientKeyPath ?? config.ssl?.clientCertPath,
      'de la clave cliente'
    )
    if (ca) options.ca = ca
    if (cert) {
      options.cert = cert
      if (key) options.key = key
      if (secrets.sslKeyPassword) options.passphrase = secrets.sslKeyPassword
    }
    if (config.ssl?.verifyServer === false) {
      options.tlsAllowInvalidCertificates = true
      options.tlsAllowInvalidHostnames = true
    }
    // Through a tunnel the certificate names the real host, not 127.0.0.1.
    if (endpoint?.tlsServername) options.servername = endpoint.tlsServername
  } else if (mechanism === 'x509') {
    throw new MongoUserError('La autenticación X.509 necesita TLS: actívalo en la pestaña SSL.')
  }

  for (const [key, value] of Object.entries(mongo.extraOptions ?? {})) {
    const lower = key.trim().toLowerCase()
    if (isMongoCredentialOption(key))
      throw new MongoUserError(
        `La opción "${key}" lleva credenciales y no se puede usar en las opciones extra.`
      )
    if (RESERVED_OPTIONS.has(lower)) continue
    if (lower === 'compressors') {
      const allowed = value
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c === 'zlib' || c === 'none')
      options.compressors = (
        allowed.length ? allowed : ['zlib']
      ) as MongoClientOptions['compressors']
      continue
    }
    ;(options as Record<string, unknown>)[key] = coerceOption(value)
  }
  return { uri, options, tls }
}

function coerceOption(value: string): string | number | boolean {
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true'
  if (/^-?\d+$/.test(value)) return Number(value)
  return value
}
