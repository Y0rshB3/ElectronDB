/**
 * Static engine descriptors and capability flags (docs/multi-engine-design.md,
 * section 3). Pure data plus small helpers: no driver, Node or browser imports,
 * so main and renderer read the same flags.
 *
 * `mysql` and `postgresql` ship drivers (`available`); PostgreSQL stays
 * `preview` (offered only with Ajustes › Motores en vista previa). The other
 * engines are declared so the model is complete and are never offered.
 */
import type {
  ConnectionConfig,
  ConnectionInput,
  EngineId,
  MongoOptions,
  NetworkOptions,
  PostgresOptions,
  SqliteOptions
} from './types'
import type { SqlDialectId } from './dialects/types'

export type Hierarchy =
  | 'database' //              conn → database → group → object        (MySQL, MariaDB)
  | 'database>schema' //       conn → database → schema → group → object (PostgreSQL)
  | 'attached' //              conn → main/temp/aux → group → object   (SQLite)
  | 'database>collection' //   conn → database → group → collection    (MongoDB)

/** Tree groups under a database/schema, across every engine. */
export type EngineGroupKind =
  | 'tables'
  | 'views'
  | 'materializedViews'
  | 'functions'
  | 'events'
  | 'sequences'
  | 'types'
  | 'indexes'
  | 'triggers'
  | 'collections'
  | 'queries'
  | 'backups'

export interface EngineCapabilities {
  family: 'sql' | 'document'
  hierarchy: Hierarchy
  /** PostgreSQL: extra schema level under each database. */
  hasSchemas: boolean
  /** Users view + db:users. */
  hasUsers: boolean
  /** backups:* and the backup UI. */
  supportsBackupsNb3: boolean
  /** jobs:* tasks may target this connection. */
  supportsAutomation: boolean
  supportsSsh: boolean
  supportsSsl: boolean
  /** false for SQLite (file picker instead). */
  needsHost: boolean
  /** SQLite always; MongoDB only when username is empty or authMechanism is 'x509'/'none'. */
  passwordOptional: boolean
  /** Query tabs own a dedicated session. false for mysql/mariadb in v1. */
  tabSessions: boolean
  /** Engine is hidden from the connection pickers unless previews are enabled. */
  preview: boolean
  /** Run SQL on every new session. */
  initialQueries: boolean
  createDatabase: 'charset' | 'pg' | 'mongo' | false
  /** db:charsets, charset/collation pickers. */
  charsets: boolean
  events: boolean
  routines: boolean
  triggers: boolean
  sequences: boolean
  materializedViews: boolean
  /** DEFINER handling in the DDL editor. */
  definer: boolean
  /** ENGINE= table option. */
  tableEngines: boolean
  unsignedTypes: boolean
  /** The designer can reorder existing columns. */
  columnPositions: boolean
  /** false => SQLite rebuild. */
  alterColumnInPlace: boolean
  /** The designer wraps the plan in BEGIN/COMMIT. */
  transactionalDdl: boolean
  /** PostgreSQL offers both options. */
  truncate: false | { restartIdentity: boolean; cascade: boolean }
  /** The driver reports the table alias of result columns (mysql2 field.table). */
  resultAliasMetadata: boolean
  /** Static upper bound; ServerInfo.runtime may lower it. */
  returning: 'none' | 'insert-delete' | 'all'
  cancel: 'kill-query' | 'pg-cancel' | 'kill-process' | 'kill-op'
  sqlDialect: SqlDialectId | null
  /** MongoDB views instead of SQL views. */
  documentModel: boolean
  designer: 'table' | 'collection'
}

export interface EngineDescriptor {
  id: EngineId
  /** 'MySQL', 'MariaDB', 'PostgreSQL', 'SQLite', 'MongoDB' */
  label: string
  /** mdi icon for the tree and the picker. */
  icon: string
  defaultPort: number
  defaultUser: string
  /** Tree groups under a database/schema, in order. */
  groups: EngineGroupKind[]
  /** A driver for this engine ships in this build. Unavailable engines are never offered. */
  available: boolean
  capabilities: EngineCapabilities
}

const MYSQL_FAMILY = {
  family: 'sql',
  hierarchy: 'database',
  hasSchemas: false,
  hasUsers: true,
  supportsSsh: true,
  supportsSsl: true,
  needsHost: true,
  passwordOptional: false,
  tabSessions: false,
  initialQueries: true,
  createDatabase: 'charset',
  charsets: true,
  events: true,
  routines: true,
  triggers: true,
  materializedViews: false,
  definer: true,
  tableEngines: true,
  unsignedTypes: true,
  columnPositions: true,
  alterColumnInPlace: true,
  transactionalDdl: false,
  truncate: { restartIdentity: false, cascade: false },
  resultAliasMetadata: true,
  cancel: 'kill-query',
  documentModel: false,
  designer: 'table'
} as const satisfies Partial<EngineCapabilities>

export const ENGINES: Readonly<Record<EngineId, EngineDescriptor>> = {
  mysql: {
    id: 'mysql',
    label: 'MySQL',
    icon: 'mdi-dolphin',
    defaultPort: 3306,
    defaultUser: 'root',
    groups: ['tables', 'views', 'functions', 'events', 'queries', 'backups'],
    available: true,
    capabilities: {
      ...MYSQL_FAMILY,
      supportsBackupsNb3: true,
      supportsAutomation: true,
      preview: false,
      sequences: false,
      returning: 'none',
      sqlDialect: 'mysql'
    }
  },
  mariadb: {
    id: 'mariadb',
    label: 'MariaDB',
    icon: 'mdi-seal',
    defaultPort: 3306,
    defaultUser: 'root',
    groups: ['tables', 'views', 'functions', 'events', 'sequences', 'queries'],
    available: false,
    capabilities: {
      ...MYSQL_FAMILY,
      supportsBackupsNb3: false,
      supportsAutomation: false,
      preview: true,
      sequences: true,
      returning: 'insert-delete',
      sqlDialect: 'mariadb'
    }
  },
  postgresql: {
    id: 'postgresql',
    label: 'PostgreSQL',
    icon: 'mdi-elephant',
    defaultPort: 5432,
    defaultUser: 'postgres',
    groups: ['tables', 'views', 'materializedViews', 'functions', 'sequences', 'types', 'queries'],
    available: true,
    capabilities: {
      family: 'sql',
      hierarchy: 'database>schema',
      hasSchemas: true,
      hasUsers: false,
      supportsBackupsNb3: false,
      supportsAutomation: false,
      supportsSsh: true,
      supportsSsl: true,
      needsHost: true,
      passwordOptional: false,
      tabSessions: true,
      preview: true,
      initialQueries: true,
      createDatabase: 'pg',
      charsets: false,
      events: false,
      routines: true,
      triggers: true,
      sequences: true,
      materializedViews: true,
      definer: false,
      tableEngines: false,
      unsignedTypes: false,
      columnPositions: false,
      alterColumnInPlace: true,
      transactionalDdl: true,
      truncate: { restartIdentity: true, cascade: true },
      resultAliasMetadata: false,
      returning: 'all',
      cancel: 'pg-cancel',
      sqlDialect: 'postgresql',
      documentModel: false,
      designer: 'table'
    }
  },
  sqlite: {
    id: 'sqlite',
    label: 'SQLite',
    icon: 'mdi-database-outline',
    defaultPort: 0,
    defaultUser: '',
    groups: ['tables', 'views', 'indexes', 'triggers', 'queries'],
    available: false,
    capabilities: {
      family: 'sql',
      hierarchy: 'attached',
      hasSchemas: false,
      hasUsers: false,
      supportsBackupsNb3: false,
      supportsAutomation: false,
      supportsSsh: false,
      supportsSsl: false,
      needsHost: false,
      passwordOptional: true,
      tabSessions: true,
      preview: true,
      initialQueries: true,
      createDatabase: false,
      charsets: false,
      events: false,
      routines: false,
      triggers: true,
      sequences: false,
      materializedViews: false,
      definer: false,
      tableEngines: false,
      unsignedTypes: false,
      columnPositions: true,
      alterColumnInPlace: false,
      transactionalDdl: true,
      truncate: false,
      resultAliasMetadata: false,
      returning: 'all',
      cancel: 'kill-process',
      sqlDialect: 'sqlite',
      documentModel: false,
      designer: 'table'
    }
  },
  mongodb: {
    id: 'mongodb',
    label: 'MongoDB',
    icon: 'mdi-leaf',
    defaultPort: 27017,
    defaultUser: '',
    groups: ['collections', 'views', 'queries'],
    available: false,
    capabilities: {
      family: 'document',
      hierarchy: 'database>collection',
      hasSchemas: false,
      hasUsers: false,
      supportsBackupsNb3: false,
      supportsAutomation: false,
      supportsSsh: true,
      supportsSsl: true,
      needsHost: true,
      passwordOptional: true,
      tabSessions: true,
      preview: true,
      initialQueries: false,
      createDatabase: 'mongo',
      charsets: false,
      events: false,
      routines: false,
      triggers: false,
      sequences: false,
      materializedViews: false,
      definer: false,
      tableEngines: false,
      unsignedTypes: false,
      columnPositions: false,
      alterColumnInPlace: false,
      transactionalDdl: false,
      truncate: false,
      resultAliasMetadata: false,
      returning: 'none',
      cancel: 'kill-op',
      sqlDialect: null,
      documentModel: true,
      designer: 'collection'
    }
  }
}

export const ENGINE_IDS = Object.keys(ENGINES) as EngineId[]

/** Engine used for records written before multi-engine and for inputs without one. */
export const DEFAULT_ENGINE: EngineId = 'mysql'

export function isEngineId(value: unknown): value is EngineId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ENGINES, value)
}

/** Descriptor of a connection's engine; a missing engine means MySQL. */
export function engineOf(c: { engine?: EngineId | null }): EngineDescriptor {
  const id = c.engine ?? DEFAULT_ENGINE
  const descriptor = isEngineId(id) ? ENGINES[id] : undefined
  if (!descriptor) throw new Error(`Motor de base de datos desconocido: "${String(id)}".`)
  return descriptor
}

/** Capabilities that are plain on/off flags. */
export type BooleanCapability = {
  [K in keyof EngineCapabilities]: EngineCapabilities[K] extends boolean ? K : never
}[keyof EngineCapabilities]

/** Throws `message` (shown to the user) when the connection's engine lacks a capability. */
export function assertCapability(
  c: { engine?: EngineId | null },
  cap: BooleanCapability,
  message: string
): void {
  if (!engineOf(c).capabilities[cap]) throw new Error(message)
}

/**
 * Engines a user may pick for a new connection (and, later, import).
 * Preview engines appear only with Ajustes > "Motores en vista previa" on;
 * an engine without a driver in this build never appears.
 */
export function pickableEngines(previewEnabled: boolean): EngineDescriptor[] {
  return ENGINE_IDS.map((id) => ENGINES[id]).filter(
    (e) => e.available && (previewEnabled || !e.capabilities.preview)
  )
}

/* ---------- Engine block defaults (used by ConnectionsRepo normalisation) ---------- */

export const DEFAULT_NETWORK: Readonly<NetworkOptions> = {
  connectTimeoutMs: 10_000,
  keepAliveSec: 60
}

export const defaultPostgresOptions = (): PostgresOptions => ({
  initialDatabase: 'postgres',
  showSystemSchemas: false,
  timeZone: '',
  searchPath: ''
})

export const defaultSqliteOptions = (production: boolean): SqliteOptions => ({
  filePath: '',
  readOnly: production,
  foreignKeys: false,
  attached: [],
  busyTimeoutMs: 5_000
})

export const defaultMongoOptions = (): MongoOptions => ({
  topology: 'standalone',
  srv: false,
  members: [],
  replicaSet: '',
  authMechanism: 'default',
  authSource: 'admin',
  defaultDatabase: '',
  readPreference: 'primary',
  directConnection: false,
  retryWrites: true,
  retryReads: true,
  extraOptions: {}
})

/**
 * Fills `engine` (missing => 'mysql') and the defaults of the engine's own
 * block, keeping every stored value. A MySQL record only gains `engine`, so
 * MySQL behaviour is unchanged. Returns the same object when nothing is missing.
 */
export function withEngineDefaults<T extends ConnectionInput | ConnectionConfig>(
  c: T
): T & { engine: EngineId } {
  const engine = c.engine ?? DEFAULT_ENGINE
  const patch: Partial<ConnectionConfig> = {}
  if (c.engine !== engine) patch.engine = engine
  if (engine === 'postgresql' || engine === 'mongodb') {
    const network = { ...DEFAULT_NETWORK, ...c.network }
    if (!sameKeys(c.network, network)) patch.network = network
  }
  if (engine === 'postgresql') {
    const postgres = { ...defaultPostgresOptions(), ...c.postgres }
    if (!sameKeys(c.postgres, postgres)) patch.postgres = postgres
  } else if (engine === 'sqlite') {
    const sqlite = { ...defaultSqliteOptions(c.environment === 'production'), ...c.sqlite }
    if (!sameKeys(c.sqlite, sqlite)) patch.sqlite = sqlite
  } else if (engine === 'mongodb') {
    const mongo = { ...defaultMongoOptions(), ...c.mongo }
    if (!sameKeys(c.mongo, mongo)) patch.mongo = mongo
  }
  return Object.keys(patch).length === 0
    ? (c as T & { engine: EngineId })
    : ({ ...c, ...patch } as T & { engine: EngineId })
}

/** True when `stored` already has every key of `filled` (so filling changed nothing). */
function sameKeys(stored: object | undefined, filled: object): boolean {
  if (!stored) return false
  return Object.keys(filled).every((k) => Object.prototype.hasOwnProperty.call(stored, k))
}
