/**
 * MongoDB connection strings (docs/multi-engine-design.md, 8.2 and 13).
 *
 * - `parseMongoUri`: «Pegar URI» in the connection dialog. It fills the
 *   form fields; the password is returned apart so the dialog hands it to the
 *   credential store, and query parameters that carry secrets are refused.
 *   The raw URI is never stored, logged or echoed.
 * - `mongoUriOf`: «Copiar URI», built from a saved config, never with a password.
 *
 * Pure: shared by the renderer (dialog, menu) and main (tests, import).
 */
import { isMongoCredentialOption } from '../connectionValidation'
import { defaultMongoOptions } from '../engines'
import type {
  ConnectionInput,
  MongoAuthMechanism,
  MongoOptions,
  MongoReadPreference,
  MongoTopology
} from '../types'

export class MongoUriError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MongoUriError'
  }
}

export const CREDENTIALS_IN_PARAMETERS =
  'La URI contiene credenciales en los parámetros: quítalas y escribe la contraseña en su campo.'

const AUTH_MECHANISMS: Record<string, MongoAuthMechanism> = {
  'scram-sha-1': 'scram-sha-1',
  'scram-sha-256': 'scram-sha-256',
  'mongodb-x509': 'x509',
  plain: 'plain',
  default: 'default'
}
const UNSUPPORTED_MECHANISMS = new Set(['gssapi', 'mongodb-aws', 'mongodb-oidc', 'mongodb-cr'])

/** Driver name of a mechanism ('default' and 'none' send none). */
export const DRIVER_AUTH_MECHANISM: Record<MongoAuthMechanism, string | null> = {
  default: null,
  'scram-sha-1': 'SCRAM-SHA-1',
  'scram-sha-256': 'SCRAM-SHA-256',
  x509: 'MONGODB-X509',
  plain: 'PLAIN',
  none: null
}

const READ_PREFERENCES: MongoReadPreference[] = [
  'primary',
  'primaryPreferred',
  'secondary',
  'secondaryPreferred',
  'nearest'
]

export interface ParsedMongoUri {
  host: string
  port: number
  username: string
  /** Password from the URI user info: for the credential store only. */
  password: string | null
  mongo: MongoOptions
  ssl: { enabled: boolean; verifyServer: boolean; caCertPath?: string; clientCertPath?: string }
  /** Connect timeout from connectTimeoutMS / serverSelectionTimeoutMS, when given. */
  connectTimeoutMs: number | null
}

function decode(part: string, what: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    throw new MongoUriError(`La URI no es válida: ${what} tiene un carácter % mal codificado.`)
  }
}

function bool(value: string, key: string): boolean {
  if (/^(true|1|yes)$/i.test(value)) return true
  if (/^(false|0|no)$/i.test(value)) return false
  throw new MongoUriError(`La opción ${key} de la URI debe ser true o false.`)
}

/**
 * Splits a mongodb:// or mongodb+srv:// URI into connection fields. Throws
 * MongoUriError (Spanish, without echoing the URI) when it cannot be used.
 */
export function parseMongoUri(input: string): ParsedMongoUri {
  const uri = input.trim()
  const scheme = /^(mongodb(?:\+srv)?):\/\//i.exec(uri)
  if (!scheme) throw new MongoUriError('La URI debe empezar por mongodb:// o mongodb+srv://.')
  const srv = scheme[1].toLowerCase() === 'mongodb+srv'
  let rest = uri.slice(scheme[0].length)
  const queryAt = rest.indexOf('?')
  const query = queryAt >= 0 ? rest.slice(queryAt + 1) : ''
  if (queryAt >= 0) rest = rest.slice(0, queryAt)
  const slash = rest.indexOf('/')
  const authority = slash >= 0 ? rest.slice(0, slash) : rest
  const database = slash >= 0 ? decode(rest.slice(slash + 1), 'la base de datos') : ''
  const at = authority.lastIndexOf('@')
  const userInfo = at >= 0 ? authority.slice(0, at) : ''
  const hostList = at >= 0 ? authority.slice(at + 1) : authority
  let username = ''
  let password: string | null = null
  if (userInfo) {
    const colon = userInfo.indexOf(':')
    username = decode(colon >= 0 ? userInfo.slice(0, colon) : userInfo, 'el usuario')
    if (colon >= 0) password = decode(userInfo.slice(colon + 1), 'la contraseña')
  }
  if (!hostList) throw new MongoUriError('La URI no indica ningún servidor.')
  const members = hostList.split(',').map((entry) => {
    const ipv6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry)
    const plain = /^([^:]+)(?::(\d+))?$/.exec(entry)
    const m = ipv6 ?? plain
    if (!m) throw new MongoUriError('La lista de servidores de la URI no es válida.')
    const port = m[2] ? Number(m[2]) : 27017
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new MongoUriError('Un puerto de la URI no es válido.')
    return { host: decode(m[1], 'el servidor'), port, explicitPort: !!m[2] }
  })
  if (srv && (members.length > 1 || members[0].explicitPort))
    throw new MongoUriError('Una URI mongodb+srv lleva un solo nombre de servidor y sin puerto.')

  const mongo: MongoOptions = { ...defaultMongoOptions(), srv, defaultDatabase: database }
  const ssl: ParsedMongoUri['ssl'] = { enabled: srv, verifyServer: true }
  let connectTimeoutMs: number | null = null
  let topology: MongoTopology | null = null
  for (const pair of query ? query.split('&') : []) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const key = decode(eq >= 0 ? pair.slice(0, eq) : pair, 'una opción')
    const value = decode(eq >= 0 ? pair.slice(eq + 1) : '', 'una opción')
    if (isMongoCredentialOption(key)) throw new MongoUriError(CREDENTIALS_IN_PARAMETERS)
    switch (key.toLowerCase()) {
      case 'replicaset':
        mongo.replicaSet = value
        topology = 'replicaSet'
        break
      case 'authsource':
        mongo.authSource = value
        break
      case 'authmechanism': {
        const lower = value.toLowerCase()
        if (UNSUPPORTED_MECHANISMS.has(lower))
          throw new MongoUriError('Mecanismo de autenticación no soportado en esta versión.')
        const mech = AUTH_MECHANISMS[lower]
        if (!mech) throw new MongoUriError('Mecanismo de autenticación desconocido en la URI.')
        mongo.authMechanism = mech
        break
      }
      case 'readpreference':
        if (!READ_PREFERENCES.includes(value as MongoReadPreference))
          throw new MongoUriError('La preferencia de lectura de la URI no es válida.')
        mongo.readPreference = value as MongoReadPreference
        break
      case 'directconnection':
        mongo.directConnection = bool(value, key)
        break
      case 'retrywrites':
        mongo.retryWrites = bool(value, key)
        break
      case 'retryreads':
        mongo.retryReads = bool(value, key)
        break
      case 'tls':
      case 'ssl':
        ssl.enabled = bool(value, key)
        break
      case 'tlsallowinvalidhostnames':
      case 'tlsallowinvalidcertificates':
      case 'tlsinsecure':
        if (bool(value, key)) ssl.verifyServer = false
        break
      case 'tlscafile':
        ssl.caCertPath = value
        ssl.enabled = true
        break
      case 'tlscertificatekeyfile':
        ssl.clientCertPath = value
        ssl.enabled = true
        break
      case 'connecttimeoutms':
      case 'serverselectiontimeoutms': {
        const ms = Number(value)
        if (Number.isFinite(ms) && ms > 0) connectTimeoutMs = Math.max(connectTimeoutMs ?? 0, ms)
        break
      }
      default:
        mongo.extraOptions[key] = value
    }
  }
  if (!srv && members.length > 1) {
    mongo.members = members.map(({ host, port }) => ({ host, port }))
    mongo.topology = topology ?? 'shardCluster'
  } else if (!srv && topology) {
    mongo.members = members.map(({ host, port }) => ({ host, port }))
    mongo.topology = topology
  } else if (srv) {
    mongo.topology = topology ?? 'replicaSet'
  }
  if (mongo.authMechanism === 'default' && !username && password === null)
    mongo.authMechanism = 'none'
  return {
    host: members[0].host,
    port: srv ? 0 : members[0].port,
    username,
    password,
    mongo,
    ssl,
    connectTimeoutMs
  }
}

const enc = encodeURIComponent

/**
 * mongodb:// URI of a connection, without any password («Copiar URI»). The
 * user name is included; SSH tunnels are not part of a URI.
 */
export function mongoUriOf(
  c: Pick<ConnectionInput, 'host' | 'port' | 'username' | 'mongo' | 'ssl'>
): string {
  const m = { ...defaultMongoOptions(), ...c.mongo }
  const scheme = m.srv ? 'mongodb+srv' : 'mongodb'
  const hostOf = (h: string): string => (h.includes(':') ? `[${h}]` : h)
  const hosts = m.srv
    ? hostOf(c.host)
    : m.topology !== 'standalone' && m.members.length
      ? m.members.map((x) => `${hostOf(x.host)}:${x.port}`).join(',')
      : `${hostOf(c.host)}:${c.port}`
  const user = c.username && m.authMechanism !== 'none' ? `${enc(c.username)}@` : ''
  const params: string[] = []
  if (m.replicaSet) params.push(`replicaSet=${enc(m.replicaSet)}`)
  if (user && m.authSource && m.authSource !== 'admin')
    params.push(`authSource=${enc(m.authSource)}`)
  const mech = DRIVER_AUTH_MECHANISM[m.authMechanism]
  if (mech) params.push(`authMechanism=${mech}`)
  if (m.readPreference !== 'primary') params.push(`readPreference=${m.readPreference}`)
  if (m.directConnection) params.push('directConnection=true')
  if (!m.retryWrites) params.push('retryWrites=false')
  if (!m.retryReads) params.push('retryReads=false')
  if (c.ssl?.enabled && !m.srv) params.push('tls=true')
  if (c.ssl?.enabled && !c.ssl.verifyServer) params.push('tlsAllowInvalidCertificates=true')
  for (const [k, v] of Object.entries(m.extraOptions)) {
    if (!isMongoCredentialOption(k)) params.push(`${enc(k)}=${enc(v)}`)
  }
  const db = m.defaultDatabase ? enc(m.defaultDatabase) : ''
  return `${scheme}://${user}${hosts}/${db}${params.length ? `?${params.join('&')}` : ''}`
}
