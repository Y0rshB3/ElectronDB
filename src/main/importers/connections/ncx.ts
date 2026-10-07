import type { SshConfig, SslConfig } from '@shared/types'
import { decryptNcxAes, decryptNcxBlowfish } from '../navicat/ncxCipher'
import { inferEnvironment } from '../../navicat/connPlist'
import {
  NO_SSH,
  type ConnectionSecrets,
  type ParsedConnection,
  type ParsedConnectionFile
} from './types'
import {
  DEFAULT_PORTS,
  applySslMode,
  checkForeignPaths,
  firstHost,
  mysqlFamily,
  normalizeColor,
  positiveInt,
  postgresFamily,
  uniqueKey,
  unsupported,
  type EngineChoice
} from './util'
import { attributeMap, childElements, parseXml } from './xml'

/**
 * Navicat connection export files (.ncx, «Export Connections»). Only the
 * file the user exported and picked is read. Format notes:
 * docs/navicat-storage.md («Archivo .ncx»).
 *
 * <Connections Ver="1.5"><Connection ConnectionName=… ConnType="MYSQL" Host=… …/></Connections>
 * Ver 1.1/1.4 write every attribute; 1.5 omits default/off ones, so every
 * attribute is optional here.
 */

export const NCX_INVALID_MESSAGE =
  'El archivo no es un .ncx válido. Expórtalo de nuevo desde Navicat con «Export Connections» y elige ese archivo.'
export const NCX_PASSWORDS_NOTE =
  'Este archivo contiene contraseñas recuperables: bórralo después de importar.'
export const NCX_NO_PASSWORDS_NOTE =
  'El archivo no incluye contraseñas (se exportó sin «Export Password»): escríbelas al editar cada conexión.'
export const HTTP_TUNNEL_WARNING = 'Túnel HTTP no soportado'

/** ConnType -> the type name Navicat's plist uses (the import identity with the name). */
const TYPE_LABELS: Record<string, string> = {
  MYSQL: 'MySQL',
  MARIADB: 'MariaDB',
  POSTGRESQL: 'PostgreSQL',
  SQLITE: 'SQLite',
  MONGODB: 'MongoDB',
  SQLSERVER: 'SQL Server',
  ORACLE: 'Oracle',
  REDIS: 'Redis',
  SNOWFLAKE: 'Snowflake'
}

export function navicatTypeLabel(connType: string): string {
  const key = connType.trim().toUpperCase()
  return TYPE_LABELS[key] ?? (connType.trim() || 'Desconocido')
}

/** Version number of `Ver="1.4"`; NaN when missing or unreadable. */
function versionOf(raw: string | undefined): number {
  const m = /^\s*(\d+)(?:\.(\d+))?/.exec(raw ?? '')
  return m ? Number(m[1]) + Number(m[2] ?? 0) / 100 : NaN
}

/**
 * Decodes one password attribute. Files older than Ver 1.4 use the Blowfish
 * scheme, newer ones AES; the other scheme is tried as a fallback.
 */
export function decodeNcxSecret(raw: string | undefined, ver: string | undefined): string | null {
  const value = (raw ?? '').trim()
  if (!value) return null
  const v = versionOf(ver)
  const old = Number.isFinite(v) && v < 1.04
  return old
    ? (decryptNcxBlowfish(value) ?? decryptNcxAes(value))
    : (decryptNcxAes(value) ?? decryptNcxBlowfish(value))
}

const bool = (v: string | undefined): boolean => (v ?? '').trim().toLowerCase() === 'true'
const path = (v: string | undefined): string | undefined => {
  const s = (v ?? '').trim()
  return s ? s : undefined
}

function engineFor(connType: string, serviceProvider: string): EngineChoice {
  const key = connType.trim().toUpperCase()
  if (key === 'MYSQL') return mysqlFamily(false)
  if (key === 'MARIADB') return mysqlFamily(true)
  if (key === 'POSTGRESQL') return postgresFamily(serviceProvider)
  return unsupported(navicatTypeLabel(connType))
}

/** Parses .ncx text. Throws NCX_INVALID_MESSAGE when it is not an .ncx file. */
export function parseNcx(
  xml: string,
  platform: NodeJS.Platform = process.platform
): ParsedConnectionFile {
  const doc = parseXml(xml, NCX_INVALID_MESSAGE)
  const root = doc.documentElement!
  if (root.nodeName !== 'Connections') throw new Error(NCX_INVALID_MESSAGE)
  const ver = attributeMap(root).get('ver')
  const used = new Set<string>()
  const connections: ParsedConnection[] = []

  for (const el of childElements(root, 'Connection')) {
    const a = attributeMap(el)
    const get = (name: string): string | undefined => a.get(name.toLowerCase())
    const name = (get('ConnectionName') ?? '').trim()
    if (!name) continue
    const connType = get('ConnType') ?? 'MYSQL'
    const navicatType = navicatTypeLabel(connType)
    const postgres = connType.trim().toUpperCase() === 'POSTGRESQL'
    const choice = engineFor(connType, (get('ServiceProvider') ?? '').trim())
    const warnings: string[] = []
    if (choice.warning) warnings.push(choice.warning)
    // PostgreSQL may list several hosts (failover): only the first one is used.
    const hostList = postgres
      ? firstHost(get('Host') ?? '', warnings)
      : { host: (get('Host') ?? '').trim(), port: null }
    const host = hostList.host
    const defaultPort = hostList.port ?? DEFAULT_PORTS[connType.trim().toLowerCase()] ?? 3306

    const sshAuthKey = (get('SSH_AuthenMethod') ?? '').trim().toUpperCase() === 'PUBLICKEY'
    const ssh: SshConfig = bool(get('SSH'))
      ? {
          enabled: true,
          host: (get('SSH_Host') ?? '').trim(),
          port: positiveInt(get('SSH_Port'), 22),
          username: (get('SSH_UserName') ?? '').trim(),
          authType: sshAuthKey ? 'key' : 'password',
          savePassword: false
        }
      : { ...NO_SSH }
    const keyPath = path(get('SSH_PrivateKey'))
    if (ssh.enabled && sshAuthKey && keyPath) ssh.privateKeyPath = keyPath

    let ssl: SslConfig = { enabled: bool(get('SSL')), verifyServer: false }
    const ca = path(get('SSL_CACert'))
    const cert = path(get('SSL_ClientCert'))
    const key = path(get('SSL_ClientKey'))
    if (ssl.enabled) {
      if (ca) ssl.caCertPath = ca
      if (cert) ssl.clientCertPath = cert
      if (key) ssl.clientKeyPath = key
      // Unverified attribute names: verification is on only when the file says so.
      ssl.verifyServer = bool(get('SSL_VerifyCA')) || (bool(get('SSL_Authen')) && !!ca)
    }
    // PostgreSQL SSL mode (unverified attribute names; tolerant spellings).
    if (postgres) ssl = applySslMode(ssl, get('SSL_Mode') ?? get('SSLMode') ?? '', warnings)
    checkForeignPaths(
      [
        ssh.enabled ? ssh.privateKeyPath : undefined,
        ssl.caCertPath,
        ssl.clientCertPath,
        ssl.clientKeyPath
      ],
      platform,
      warnings
    )
    if (bool(get('HTTP'))) warnings.push(HTTP_TUNNEL_WARNING)

    const secrets: ConnectionSecrets = {}
    const db = decodeNcxSecret(get('Password'), ver)
    if (db !== null) secrets.mysql = db
    const sshSecret = decodeNcxSecret(sshAuthKey ? get('SSH_Passphrase') : get('SSH_Password'), ver)
    if (ssh.enabled && sshSecret !== null) {
      secrets.ssh = sshSecret
      ssh.savePassword = true
    }
    const sslKey = decodeNcxSecret(get('SSL_PEMClientKeyPassword'), ver)
    if (ssl.enabled && sslKey !== null) secrets.sslKey = sslKey

    connections.push({
      key: uniqueKey(`${navicatType}:${name}`, used),
      name,
      engine: choice.engine,
      engineLabel: navicatType,
      unsupportedReason: choice.unsupportedReason,
      host,
      port: positiveInt(get('Port'), defaultPort),
      username: (get('UserName') ?? '').trim(),
      database:
        (postgres ? path(get('InitialDatabase')) : undefined) ?? path(get('Database')) ?? null,
      color: normalizeColor(get('Color') ?? get('ConnectionColor')),
      environment: inferEnvironment(name, host, ssh.enabled),
      ssh,
      ssl,
      secrets,
      warnings,
      navicatType
    })
  }

  const withPassword = connections.some((c) => Object.keys(c.secrets).length > 0)
  return {
    connections,
    notes: connections.length ? [withPassword ? NCX_PASSWORDS_NOTE : NCX_NO_PASSWORDS_NOTE] : []
  }
}
