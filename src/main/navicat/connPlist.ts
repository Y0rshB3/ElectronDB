import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type {
  ConnectionConfig,
  EngineId,
  Environment,
  MongoOptions,
  NavicatConnectionPreview,
  NavicatSection,
  SshConfig,
  SslConfig
} from '@shared/types'
import {
  MONGO_RETRY_WRITES_WARNING,
  applySslMode,
  checkForeignPaths,
  firstHost,
  mongoMechanismOf,
  mongoProviderNeedsNoRetry,
  mongoReadPreferenceOf,
  mongoTopologyOf,
  mysqlFamily,
  positiveInt,
  postgresFamily,
  sqliteBlock
} from '../importers/connections/util'
import { SQLITE_ENCRYPTED_REASON, type FileExists } from '../importers/connections/types'
import { countNb3Files, resolveBackupSourceDir } from './backupsScan'
import { readMarkerColorsByType } from './colors'
import { connectionSettingsDir, navicatPaths } from './paths'
import { isPlistDict as isDict, parsePlistXml, type PlistDict as Dict } from './plist'

/**
 * `conn.plist` type sections Vortaq maps (docs/multi-engine-design.md, 12.1).
 * `MySQL` is verified on real files; `MariaDB` (same keys as MySQL),
 * `PostgreSQL`, `SQLite` and `MongoDB` follow the design's mapping and are
 * tested with synthetic files only. Every other section is left out, as before.
 */
export const NAVICAT_SECTIONS: readonly NavicatSection[] = [
  'MySQL',
  'MariaDB',
  'PostgreSQL',
  'SQLite',
  'MongoDB'
]

/** SQLite `attacheddatabases` (shape unverified): never imported, the user attaches them again. */
export const SQLITE_ATTACHED_WARNING =
  'Las bases de datos adjuntas no se importan: adjúntalas al editar la conexión'
/** MongoDB `memberlist` in a shape the import does not know. */
export const MONGO_MEMBERS_WARNING =
  'No se ha podido leer la lista de miembros: revisa los servidores al editar la conexión'

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
  /** SQLite: the database file as written (flagged when it is not usable on this computer). */
  sqlite?: { filePath: string; pathNeedsReview: boolean }
  /** MongoDB options read from the section (merged over the defaults on import). */
  mongo?: Partial<MongoOptions>
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

/** Where the parser checks paths (tests pass another platform and a fake file system). */
export interface PlistEnvironment {
  platform: NodeJS.Platform
  fileExists: FileExists
}

const HOST_ENV: PlistEnvironment = { platform: process.platform, fileExists: existsSync }

const NO_SSH: SshConfig = {
  enabled: false,
  host: '',
  port: 22,
  username: '',
  authType: 'password',
  savePassword: false
}

/** The fields every section shares, for the SQLite and MongoDB parsers. */
function baseConnection(
  name: string,
  type: NavicatSection,
  raw: Dict
): Pick<
  NavicatConnection,
  | 'navicatType'
  | 'name'
  | 'savePath'
  | 'customDatabases'
  | 'initialQueries'
  | 'color'
  | 'savePassword'
> {
  return {
    navicatType: type,
    name,
    savePath: optionalPath(raw.savepath) ?? null,
    customDatabases: [],
    initialQueries: '',
    color: null,
    savePassword: bool(raw.savepassword)
  }
}

/**
 * SQLite section: `databasefile` (the path on the machine that wrote the file;
 * only the text is checked, the file is never opened or created),
 * `sqliteencrypted` (Navicat's encrypted files cannot be opened) and
 * `attacheddatabases` (shape unverified: listed as a warning).
 */
function parseSqliteConnection(name: string, raw: Dict, env: PlistEnvironment): NavicatConnection {
  const warnings: string[] = []
  const filePath = str(raw.databasefile ?? raw.databasefilename).trim()
  checkForeignPaths([filePath], env.platform, warnings)
  const file = sqliteBlock(name, filePath, env.platform, env.fileExists, warnings)
  const attached = raw.attacheddatabases
  if (
    (Array.isArray(attached) && attached.length) ||
    (isDict(attached) && Object.keys(attached).length)
  )
    warnings.push(SQLITE_ATTACHED_WARNING)
  return {
    ...baseConnection(name, 'SQLite', raw),
    engine: 'sqlite',
    unsupportedReason: bool(raw.sqliteencrypted) ? SQLITE_ENCRYPTED_REASON : null,
    warnings,
    sqlite: { filePath: file.filePath, pathNeedsReview: file.pathNeedsReview },
    host: '',
    port: 0,
    username: '',
    savePassword: false,
    environment: inferEnvironment(name, '', false),
    ssh: { ...NO_SSH },
    ssl: { enabled: false, verifyServer: false }
  }
}

/** `memberlist` as an array of "host:port" strings or of {host, port} dicts (shape unverified). */
function mongoMembers(raw: unknown, warnings: string[]): { host: string; port: number }[] {
  if (raw === undefined || raw === null || raw === '') return []
  const items = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : isDict(raw)
        ? Object.values(raw)
        : null
  if (!items) {
    warnings.push(MONGO_MEMBERS_WARNING)
    return []
  }
  const members: { host: string; port: number }[] = []
  for (const item of items) {
    if (typeof item === 'string') {
      const m = /^\s*\[?([^\]\s]+?)\]?(?::(\d+))?\s*$/.exec(item)
      if (m?.[1]) members.push({ host: m[1], port: positiveInt(m[2], 27017) })
    } else if (isDict(item) && str(item.host).trim()) {
      members.push({ host: str(item.host).trim(), port: int(item.port, 27017) })
    } else {
      warnings.push(MONGO_MEMBERS_WARNING)
      return []
    }
  }
  return members
}

/**
 * MongoDB section (design 12.1; keys unverified against real files, read
 * case-insensitively by value and never required): `connmethod`,
 * `usesrvrecord`, `memberlist`, `replicasetname`, `authsource`,
 * `authmechanism` (Kerberos/AWS/OIDC are not importable), `readpreference`,
 * `retrywrites`/`retryreads` and `serviceprovider` (DocumentDB/Cosmos DB turn
 * retryable writes off; Atlas and SRV turn TLS on).
 */
function parseMongoConnection(name: string, raw: Dict, env: PlistEnvironment): NavicatConnection {
  const warnings: string[] = []
  const ssh = parseSsh(raw)
  const method = mongoTopologyOf(str(raw.connmethod) || undefined, warnings)
  const members = mongoMembers(raw.memberlist, warnings)
  const srv = bool(raw.usesrvrecord) || method?.srv === true
  const topology = method?.topology ?? (members.length > 1 ? 'replicaSet' : 'standalone')
  const auth = mongoMechanismOf(str(raw.authmechanism) || undefined, warnings)
  const readPreference = mongoReadPreferenceOf(str(raw.readpreference) || undefined, warnings)
  const provider = str(raw.serviceprovider).trim()
  const noRetry = mongoProviderNeedsNoRetry(provider)
  if (noRetry) warnings.push(MONGO_RETRY_WRITES_WARNING(noRetry))
  const seedList = topology !== 'standalone' && !srv && members.length > 0
  const host = seedList ? members[0].host : str(raw.host).trim()
  const port = srv ? 0 : seedList ? members[0].port : int(raw.port, 27017)
  let ssl = parseSsl(raw)
  const tls = ssl.enabled || srv || /atlas/i.test(provider)
  ssl = tls ? { ...ssl, enabled: true, verifyServer: ssl.verifyServer || !ssl.enabled } : ssl
  checkForeignPaths(
    [
      ssh.enabled ? ssh.privateKeyPath : undefined,
      ssl.caCertPath,
      ssl.clientCertPath,
      ssl.clientKeyPath
    ],
    env.platform,
    warnings
  )
  const username = str(raw.username).trim()
  const database = str(raw.database ?? raw.initialdatabase).trim()
  const flag = (v: unknown, fallback: boolean): boolean =>
    v === undefined || v === null || v === '' ? fallback : bool(v)
  return {
    ...baseConnection(name, 'MongoDB', raw),
    engine: 'mongodb',
    unsupportedReason: auth.unsupported,
    warnings,
    host,
    port,
    username,
    environment: inferEnvironment(name, host, ssh.enabled),
    ssh,
    ssl,
    mongo: {
      topology,
      srv,
      members: seedList ? members : [],
      replicaSet: str(raw.replicasetname).trim(),
      authMechanism: auth.mechanism ?? (username ? 'default' : 'none'),
      authSource: str(raw.authsource).trim() || 'admin',
      defaultDatabase: database,
      ...(readPreference ? { readPreference } : {}),
      directConnection: ssh.enabled,
      retryWrites: noRetry ? false : flag(raw.retrywrites, true),
      retryReads: flag(raw.retryreads, true)
    }
  }
}

function parseConnection(
  name: string,
  raw: Dict,
  type: NavicatSection = 'MySQL',
  env: PlistEnvironment = HOST_ENV
): NavicatConnection {
  if (type === 'SQLite') return parseSqliteConnection(name, raw, env)
  if (type === 'MongoDB') return parseMongoConnection(name, raw, env)
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
export async function parseConnPlist(
  xml: string,
  env: PlistEnvironment = HOST_ENV
): Promise<NavicatConnection[]> {
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
      if (isDict(raw)) connections.push(parseConnection(name, raw, type, env))
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
      alreadyImported: existing.some((c) => isImportedFromNavicat(c, connection.name, type)),
      ...(connection.sqlite ? { filePath: connection.sqlite.filePath } : {})
    }
    entries.push({ connection, preview, backupSourceDir })
  }
  return entries
}
