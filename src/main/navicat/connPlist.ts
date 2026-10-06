import { readFile } from 'node:fs/promises'
import type {
  ConnectionConfig,
  Environment,
  NavicatConnectionPreview,
  SshConfig,
  SslConfig
} from '@shared/types'
import { countNb3Files, resolveBackupSourceDir } from './backupsScan'
import { readMarkerColors } from './colors'
import { connectionSettingsDir, navicatPaths } from './paths'
import { isPlistDict as isDict, parsePlistXml, type PlistDict as Dict } from './plist'

/** A connection as stored by Navicat, independent of ElectronDB state. */
export interface NavicatConnection {
  name: string
  host: string
  port: number
  username: string
  savePassword: boolean
  color: string | null
  environment: Environment
  ssh: SshConfig
  ssl: SslConfig
  savePath: string | null
  customDatabases: string[]
  initialQueries: string
}

/** Preview enriched with the resolved, existing backup directory (if any). */
export interface NavicatConnectionEntry {
  connection: NavicatConnection
  preview: NavicatConnectionPreview
  /** Existing directory holding Navicat `.nb3` files for this connection. */
  backupSourceDir: string | null
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const bool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true'
const int = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}
const optionalPath = (v: unknown): string | undefined => {
  const s = str(v).trim()
  return s ? s : undefined
}

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

/**
 * Name/host heuristic. A loopback host only means "local" when no SSH tunnel
 * is used: through a tunnel the host is relative to the remote machine.
 */
export function inferEnvironment(name: string, host: string, sshTunnel = false): Environment {
  if (/prod/i.test(name)) return 'production'
  if (/stag|stg|qa|uat/i.test(name)) return 'staging'
  const h = host.trim().toLowerCase()
  const loopback = h === '127.0.0.1' || h === 'localhost' || h === '::1'
  if ((loopback && !sshTunnel) || /local/i.test(name)) return 'local'
  return 'other'
}

function parseSsh(raw: Dict): SshConfig {
  const p = isDict(raw.ssh_param) ? raw.ssh_param : {}
  const ssh: SshConfig = {
    enabled: bool(raw.usetunnel),
    host: str(p.host),
    port: int(p.port, 22),
    username: str(p.username),
    authType: int(p.authtype, 0) === 1 ? 'key' : 'password',
    savePassword: bool(p.savepassword)
  }
  const keyPath = optionalPath(p.pkeyfile)
  if (keyPath) ssh.privateKeyPath = keyPath
  return ssh
}

function parseSsl(raw: Dict): SslConfig {
  const p = isDict(raw.ssl_param) ? raw.ssl_param : {}
  const ssl: SslConfig = { enabled: bool(raw.usessl), verifyServer: bool(p.verifyca) }
  const ca = optionalPath(p.cacert)
  const cert = optionalPath(p.clientcert)
  const key = optionalPath(p.clientkeyfile)
  if (ca) ssl.caCertPath = ca
  if (cert) ssl.clientCertPath = cert
  if (key) ssl.clientKeyPath = key
  return ssl
}

function parseConnection(name: string, raw: Dict): NavicatConnection {
  const host = str(raw.host)
  const ssh = parseSsh(raw)
  const customList = Array.isArray(raw.customdblist)
    ? raw.customdblist.filter((x): x is string => typeof x === 'string')
    : []
  return {
    name,
    host,
    port: int(raw.port, 3306),
    username: str(raw.username),
    savePassword: bool(raw.savepassword),
    color: null,
    environment: inferEnvironment(name, host, ssh.enabled),
    ssh,
    ssl: parseSsl(raw),
    savePath: optionalPath(raw.savepath) ?? null,
    customDatabases: bool(raw.usecustomdblist) ? customList : [],
    initialQueries: str(raw.initialsessionqueries)
  }
}

/** Finds every `MySQL` dict at `<root>/<x>/<y>/MySQL` (Navicat uses `0/0`). */
function mysqlSections(root: unknown): Dict[] {
  if (!isDict(root)) return []
  const sections: Dict[] = []
  for (const level1 of Object.values(root)) {
    if (!isDict(level1)) continue
    for (const level2 of Object.values(level1)) {
      if (isDict(level2) && isDict(level2.MySQL)) sections.push(level2.MySQL)
    }
  }
  return sections
}

/** Parses conn.plist XML. Throws an actionable error when the plist is not readable. */
export async function parseConnPlist(xml: string): Promise<NavicatConnection[]> {
  let root: unknown
  try {
    root = await parsePlistXml(xml)
  } catch (err) {
    throw new Error(
      `No se pudo leer conn.plist de Navicat: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const connections: NavicatConnection[] = []
  for (const section of mysqlSections(root)) {
    for (const [name, raw] of Object.entries(section)) {
      if (isDict(raw)) connections.push(parseConnection(name, raw))
    }
  }
  return connections.sort((a, b) => a.name.localeCompare(b.name))
}

export function isImportedFromNavicat(connection: ConnectionConfig, navicatName: string): boolean {
  return connection.source?.app === 'navicat' && connection.source.name === navicatName
}

/**
 * Reads connections + colours from a Navicat root and enriches them with
 * ElectronDB state (backup counts, alreadyImported).
 */
export async function readNavicatConnections(
  root: string,
  existing: ConnectionConfig[]
): Promise<NavicatConnectionEntry[]> {
  const paths = navicatPaths(root)
  const connections = await parseConnPlist(await readTextFile(paths.connPlist))
  let colors = new Map<string, string>()
  try {
    colors = await readMarkerColors(await readTextFile(paths.prefPlist))
  } catch {
    /* pref.plist is optional: colours stay null */
  }

  const entries: NavicatConnectionEntry[] = []
  for (const connection of connections) {
    connection.color = colors.get(connection.name) ?? null
    const backupSourceDir = await resolveBackupSourceDir(
      connection.savePath,
      connectionSettingsDir(paths, connection.name)
    )
    const backupCount = backupSourceDir ? await countNb3Files(backupSourceDir) : 0
    const preview: NavicatConnectionPreview = {
      name: connection.name,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      color: connection.color,
      environment: connection.environment,
      ssh: connection.ssh,
      ssl: connection.ssl,
      savePath: connection.savePath,
      customDatabases: connection.customDatabases,
      initialQueries: connection.initialQueries,
      backupCount,
      alreadyImported: existing.some((c) => isImportedFromNavicat(c, connection.name))
    }
    entries.push({ connection, preview, backupSourceDir })
  }
  return entries
}
