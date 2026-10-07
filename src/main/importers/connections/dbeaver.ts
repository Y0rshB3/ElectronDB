import type { Environment, SshConfig, SslConfig } from '@shared/types'
import { inferEnvironment } from '../../navicat/connPlist'
import { NO_SSH, type ParsedConnection, type ParsedConnectionFile } from './types'
import {
  checkForeignPaths,
  isLoopback,
  mysqlFamily,
  normalizeColor,
  positiveInt,
  stripBom,
  uniqueKey,
  unsupported,
  type EngineChoice
} from './util'

/**
 * DBeaver workspace connections (`.dbeaver/data-sources.json`). Only this
 * plain JSON file is read. Users and passwords that DBeaver keeps in its
 * encrypted credentials file are never read or decrypted: connections are
 * imported without passwords.
 */

export const DBEAVER_INVALID_MESSAGE =
  'El archivo no es un data-sources.json de DBeaver válido. Elige el archivo .dbeaver/data-sources.json de tu espacio de trabajo.'
export const DBEAVER_PASSWORDS_NOTE =
  'Las contraseñas no se importan: DBeaver las guarda cifradas. Escríbelas al editar cada conexión.'
export const DBEAVER_USER_WARNING =
  'El usuario está en el almacén cifrado de DBeaver: escríbelo al editar la conexión'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string =>
  typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
const bool = (v: unknown): boolean => v === true || v === 'true'

/** host, port and database of a `jdbc:mysql://host:port/db?…` URL. */
export function parseJdbcUrl(
  url: string
): { host: string; port: number | null; database: string } | null {
  const m =
    /^jdbc:(?:mysql|mariadb)(?::[a-z]+)?:\/\/([^/:?#]*|\[[^\]]+\])(?::(\d+))?(?:\/([^?#;]*))?/i.exec(
      url.trim()
    )
  if (!m) return null
  return {
    host: m[1].replace(/^\[|\]$/g, ''),
    port: m[2] ? Number(m[2]) : null,
    database: m[3] ? decodeURIComponent(m[3]) : ''
  }
}

const LABELS: Record<string, string> = {
  postgresql: 'PostgreSQL',
  postgres: 'PostgreSQL',
  sqlite: 'SQLite',
  mongodb: 'MongoDB',
  sqlserver: 'SQL Server',
  mssql: 'SQL Server',
  oracle: 'Oracle',
  db2: 'Db2',
  clickhouse: 'ClickHouse',
  redis: 'Redis',
  snowflake: 'Snowflake'
}

function engineFor(provider: string, driver: string): { choice: EngineChoice; label: string } {
  const p = provider.toLowerCase()
  const d = driver.toLowerCase()
  const maria = p === 'mariadb' || d.includes('maria')
  if (p === 'mysql' || p === 'mariadb' || (p === 'generic' && /^(mysql|maria)/.test(d)))
    return { choice: mysqlFamily(maria), label: maria ? 'MariaDB' : 'MySQL' }
  const known = Object.keys(LABELS).find((k) => p.includes(k) || d.includes(k))
  const label = known ? LABELS[known] : driver || provider || 'Desconocido'
  return { choice: unsupported(label), label }
}

function environmentFor(type: string, name: string, host: string, ssh: boolean): Environment {
  const inferred = inferEnvironment(name, host, ssh)
  switch (type.toLowerCase()) {
    case 'prod':
      return 'production'
    case 'test':
      // A name that says production keeps the strictest environment.
      return inferred === 'production' ? 'production' : 'staging'
    case 'dev':
      if (inferred === 'production') return 'production'
      return isLoopback(host) && !ssh ? 'local' : 'other'
    default:
      return inferred
  }
}

function parseSsh(handlers: Json, warnings: string[]): SshConfig {
  const tunnel = Object.entries(handlers).find(
    ([id, h]) => isObj(h) && (id === 'ssh_tunnel' || str(h.type).toUpperCase() === 'TUNNEL')
  )?.[1]
  if (!isObj(tunnel) || !bool(tunnel.enabled)) return { ...NO_SSH }
  const p = isObj(tunnel.properties) ? tunnel.properties : {}
  const auth = str(p.authType).toUpperCase()
  const ssh: SshConfig = {
    enabled: true,
    host: str(p.host),
    port: positiveInt(p.port, 22),
    username: str(p.user ?? p.userName),
    authType: auth === 'PUBLIC_KEY' ? 'key' : 'password',
    savePassword: false
  }
  const keyPath = str(p.keyPath)
  if (ssh.authType === 'key' && keyPath) ssh.privateKeyPath = keyPath
  if (auth === 'AGENT')
    warnings.push('Autenticación SSH por agente: elige una clave al editar la conexión')
  return ssh
}

/** DBeaver's SSL handler (id varies by driver); tolerant of its property names. */
function parseSsl(handlers: Json): SslConfig {
  const handler = Object.entries(handlers).find(
    ([id, h]) => isObj(h) && /ssl/i.test(id) && bool(h.enabled)
  )?.[1]
  if (!isObj(handler)) return { enabled: false, verifyServer: false }
  const p = isObj(handler.properties) ? handler.properties : {}
  const find = (re: RegExp): string => {
    const entry = Object.entries(p).find(([k]) => re.test(k))
    return entry ? str(entry[1]) : ''
  }
  const ssl: SslConfig = {
    enabled: true,
    verifyServer: ['true', '1'].includes(find(/verify/i).toLowerCase())
  }
  const ca = find(/ca[._-]?cert/i)
  const cert = find(/client[._-]?cert/i)
  const key = find(/client[._-]?key/i)
  if (ca) ssl.caCertPath = ca
  if (cert) ssl.clientCertPath = cert
  if (key) ssl.clientKeyPath = key
  return ssl
}

/** Colour of a connection type (`"r,g,b"`); DBeaver's white default means none. */
function typeColors(root: Json): Map<string, string> {
  const map = new Map<string, string>()
  const types = isObj(root['connection-types']) ? root['connection-types'] : {}
  for (const [id, t] of Object.entries(types)) {
    if (!isObj(t)) continue
    const color = normalizeColor(t.color)
    if (color && color !== '#ffffff') map.set(id, color)
  }
  return map
}

export function parseDbeaverDataSources(
  text: string,
  platform: NodeJS.Platform = process.platform
): ParsedConnectionFile {
  let root: unknown
  try {
    root = JSON.parse(stripBom(text))
  } catch {
    throw new Error(DBEAVER_INVALID_MESSAGE)
  }
  if (!isObj(root) || !isObj(root.connections)) throw new Error(DBEAVER_INVALID_MESSAGE)
  const colors = typeColors(root)
  const used = new Set<string>()
  const connections: ParsedConnection[] = []

  for (const [id, raw] of Object.entries(root.connections)) {
    if (!isObj(raw)) continue
    const cfg = isObj(raw.configuration) ? raw.configuration : {}
    const handlers = isObj(cfg.handlers) ? cfg.handlers : {}
    const name = str(raw.name) || id
    const { choice, label } = engineFor(str(raw.provider), str(raw.driver))
    const warnings: string[] = []
    if (choice.warning) warnings.push(choice.warning)

    const fromUrl = parseJdbcUrl(str(cfg.url))
    const host = str(cfg.host) || fromUrl?.host || ''
    const port = positiveInt(cfg.port, fromUrl?.port ?? 3306)
    const database = str(cfg.database) || fromUrl?.database || ''
    const username = str(cfg.user)
    const ssh = parseSsh(handlers, warnings)
    const ssl = parseSsl(handlers)
    if (choice.engine && !username) warnings.push(DBEAVER_USER_WARNING)
    checkForeignPaths(
      [ssh.privateKeyPath, ssl.caCertPath, ssl.clientCertPath, ssl.clientKeyPath],
      platform,
      warnings
    )
    const type = str(cfg.type)
    connections.push({
      key: uniqueKey(id, used),
      name,
      engine: choice.engine,
      engineLabel: label,
      unsupportedReason: choice.unsupportedReason,
      host,
      port,
      username,
      database: database || null,
      color: normalizeColor(cfg.color) ?? colors.get(type) ?? null,
      environment: environmentFor(type, name, host, ssh.enabled),
      ssh,
      ssl,
      secrets: {},
      warnings
    })
  }
  return { connections, notes: [DBEAVER_PASSWORDS_NOTE] }
}
