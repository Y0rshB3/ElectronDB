import { readFile } from 'node:fs/promises'
import type {
  ConnectionConfig,
  EngineId,
  Environment,
  NavicatConnectionPreview,
  NavicatSection,
  SshConfig,
  SslConfig
} from '@shared/types'
import { applySslMode, firstHost, mysqlFamily, postgresFamily } from '../importers/connections/util'
import { countNb3Files, resolveBackupSourceDir } from './backupsScan'
import { readMarkerColorsByType } from './colors'
import { connectionSettingsDir, navicatPaths } from './paths'
import { isPlistDict as isDict, parsePlistXml, type PlistDict as Dict } from './plist'

/**
 * `conn.plist` type sections Vortaq maps (docs/multi-engine-design.md, 12.1).
 * `MySQL` is verified on real files; `MariaDB` (same keys as MySQL) and
 * `PostgreSQL` follow the design's mapping and are tested with synthetic
 * files only. Every other section is left out, as before.
 */
export const NAVICAT_SECTIONS: readonly NavicatSection[] = ['MySQL', 'MariaDB', 'PostgreSQL']

/**
 * Selection key of a preview row: the plain name for MySQL (what earlier
 * versions sent), `<section>/<name>` with a unit separator for the others.
 */
export function navicatKey(type: NavicatSection, name: string): string {
  return type === 'MySQL' ? name : `${type}\u001f${name}`
}

/** A connection as stored by Navicat, independent of Vortaq state. */
export interface NavicatConnection {
  /** Section of conn.plist the connection came from. */
  navicatType: NavicatSection
  /** Engine Vortaq creates; null when the server kind is not supported (a PostgreSQL fork). */
  engine: EngineId | null
  unsupportedReason: string | null
  /** Things the import could not map exactly (names only, shown to the user, never logged). */
  warnings: string[]
  /** PostgreSQL: `initialdatabase`. */
  initialDatabase?: string
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

function parseConnection(
  name: string,
  raw: Dict,
  type: NavicatSection = 'MySQL'
): NavicatConnection {
  const ssh = parseSsh(raw)
  const warnings: string[] = []
  const customList = Array.isArray(raw.customdblist)
    ? raw.customdblist.filter((x): x is string => typeof x === 'string')
    : []
  const pg = type === 'PostgreSQL'
  // PostgreSQL: `hostportlist` (failover) imports its first host only, with a warning.
  const listed = pg && !str(raw.host) ? firstHost(str(raw.hostportlist), warnings) : null
  const host = listed?.host ?? str(raw.host)
  let ssl = parseSsl(raw)
  if (pg) {
    const p = isDict(raw.ssl_param) ? raw.ssl_param : {}
    const rootCert = optionalPath(p.rootcert)
    if (rootCert && !ssl.caCertPath) ssl = { ...ssl, caCertPath: rootCert }
    ssl = applySslMode(ssl, str(p.mode ?? p.sslmode), warnings)
  }
  const choice = pg ? postgresFamily(str(raw.serviceprovider)) : mysqlFamily(type === 'MariaDB')
  return {
    navicatType: type,
    engine: choice.engine,
    unsupportedReason: choice.unsupportedReason,
    warnings,
    ...(pg ? { initialDatabase: str(raw.initialdatabase).trim() || 'postgres' } : {}),
    name,
    host,
    port: listed?.port ?? int(raw.port, pg ? 5432 : 3306),
    username: str(raw.username),
    savePassword: bool(raw.savepassword),
    color: null,
    environment: inferEnvironment(name, host, ssh.enabled),
    ssh,
    ssl,
    savePath: optionalPath(raw.savepath) ?? null,
    // `usecustomdblist` is a boolean for MySQL and an integer for PostgreSQL: bool() reads both.
    customDatabases: bool(raw.usecustomdblist) ? customList : [],
    initialQueries: str(raw.initialsessionqueries)
  }
}

/** Every mapped section at `<root>/<user>/<project>/<TypeKey>` (Navicat uses `0/0`). */
function typeSections(root: unknown): { type: NavicatSection; dict: Dict }[] {
  if (!isDict(root)) return []
  const sections: { type: NavicatSection; dict: Dict }[] = []
  for (const level1 of Object.values(root)) {
    if (!isDict(level1)) continue
    for (const level2 of Object.values(level1)) {
      if (!isDict(level2)) continue
      for (const type of NAVICAT_SECTIONS) {
        const dict = level2[type]
        if (isDict(dict)) sections.push({ type, dict })
      }
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
  for (const { type, dict } of typeSections(root)) {
    for (const [name, raw] of Object.entries(dict)) {
      if (isDict(raw)) connections.push(parseConnection(name, raw, type))
    }
  }
  // MySQL first (as before), then by name.
  const order = (t: NavicatSection): number => NAVICAT_SECTIONS.indexOf(t)
  return connections.sort(
    (a, b) => order(a.navicatType) - order(b.navicatType) || a.name.localeCompare(b.name)
  )
}

/**
 * Identity of an imported connection: (section, name). Records imported
 * before the section was kept count as `MySQL`, the only section read then.
 */
export function isImportedFromNavicat(
  connection: ConnectionConfig,
  navicatName: string,
  type: NavicatSection = 'MySQL'
): boolean {
  return (
    connection.source?.app === 'navicat' &&
    connection.source.name === navicatName &&
    (connection.source.navicatType ?? 'MySQL') === type
  )
}

/** Sections whose connections keep Navicat `.nb3` backups Vortaq can read. */
const hasNb3Backups = (type: NavicatSection): boolean => type === 'MySQL' || type === 'MariaDB'

/**
 * Reads connections + colours from a Navicat root and enriches them with
 * Vortaq state (backup counts, alreadyImported).
 */
export async function readNavicatConnections(
  root: string,
  existing: ConnectionConfig[]
): Promise<NavicatConnectionEntry[]> {
  const paths = navicatPaths(root)
  const connections = await parseConnPlist(await readTextFile(paths.connPlist))
  let colors = new Map<NavicatSection, Map<string, string>>()
  try {
    colors = await readMarkerColorsByType(await readTextFile(paths.prefPlist))
  } catch {
    /* pref.plist is optional: colours stay null */
  }

  const entries: NavicatConnectionEntry[] = []
  for (const connection of connections) {
    const type = connection.navicatType
    connection.color = colors.get(type)?.get(connection.name) ?? null
    const backupSourceDir = hasNb3Backups(type)
      ? await resolveBackupSourceDir(
          connection.savePath,
          connectionSettingsDir(paths, connection.name, type)
        )
      : null
    const backupCount = backupSourceDir ? await countNb3Files(backupSourceDir) : 0
    const preview: NavicatConnectionPreview = {
      key: navicatKey(type, connection.name),
      navicatType: type,
      engine: connection.engine,
      blockedReason: connection.unsupportedReason,
      warnings: [...connection.warnings],
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
      alreadyImported: existing.some((c) => isImportedFromNavicat(c, connection.name, type))
    }
    entries.push({ connection, preview, backupSourceDir })
  }
  return entries
}
