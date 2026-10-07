/**
 * Shared domain types used by main, preload and renderer.
 * Keep this file free of Node/Electron/browser-only imports.
 */
import type { AiEffort } from './ai'
import type { WhatsNewEntry } from './whatsNew'

export type Environment = 'local' | 'staging' | 'production' | 'other'

export type SshAuthType = 'password' | 'key'

export interface SshConfig {
  enabled: boolean
  host: string
  port: number
  username: string
  authType: SshAuthType
  privateKeyPath?: string
  savePassword: boolean
}

/**
 * How the MySQL user authenticates.
 * - 'password': a password typed or stored in the CredentialStore (default).
 * - 'none': no password at all (local auth proxy such as Cloud SQL Auth Proxy,
 *   a user with an empty password, or client-certificate auth via SSL).
 */
export type MysqlAuthMode = 'password' | 'none'

export interface SslConfig {
  enabled: boolean
  caCertPath?: string
  clientCertPath?: string
  clientKeyPath?: string
  verifyServer: boolean
}

export interface ConnectionConfig {
  id: string
  name: string
  /** Hex colour like #4bd67a, or null for none. */
  color: string | null
  environment: Environment
  host: string
  port: number
  username: string
  /** Missing on records saved before 0.1.8: treated as 'password'. */
  authMode?: MysqlAuthMode
  savePassword: boolean
  /** Restrict object tree to these schemas when non-empty. */
  customDatabases: string[]
  initialQueries: string
  ssh: SshConfig
  ssl: SslConfig
  /** Directory where this connection's backups are written/read. */
  backupDir: string
  /** Extra read-only directories (e.g. Navicat's savepath) scanned for .nb3 files. */
  extraBackupDirs: string[]
  createdAt: string
  updatedAt: string
  source?: { app: 'navicat'; name: string; importedAt: string }
}

export type ConnectionInput = Omit<ConnectionConfig, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string
}

export interface ConnectionTestResult {
  ok: boolean
  serverVersion?: string
  /**
   * True when no password was typed or stored in 'password' mode and the
   * server accepted an empty one: the dialog suggests «Sin contraseña».
   */
  connectedWithoutPassword?: boolean
  durationMs: number
  error?: string
}

export interface ServerInfo {
  version: string
  versionComment: string
  host: string
  port: number
  username: string
  characterSet: string
  uptimeSeconds: number
  threadsConnected: number
}

export interface DatabaseInfo {
  name: string
  characterSet: string
  collation: string
}

export interface TableInfo {
  name: string
  engine: string | null
  rows: number | null
  dataLength: number | null
  indexLength: number | null
  autoIncrement: number | null
  createTime: string | null
  updateTime: string | null
  collation: string | null
  comment: string
}

export interface ViewInfo {
  name: string
  definer: string
  security: string
  updatable: boolean
  createTime?: string | null
}

export type RoutineType = 'FUNCTION' | 'PROCEDURE'

export interface RoutineInfo {
  name: string
  type: RoutineType
  definer: string
  returns: string | null
  created: string | null
  modified: string | null
  comment: string
}

export interface EventInfo {
  name: string
  definer: string
  status: string
  type: string
  executeAt: string | null
  intervalValue: string | null
  intervalField: string | null
  starts: string | null
  ends: string | null
  created: string | null
  modified: string | null
  comment: string
}

export interface TriggerInfo {
  name: string
  table: string
  event: string
  timing: string
  statement: string
  definer: string
}

export interface ColumnInfo {
  name: string
  ordinal: number
  columnType: string
  dataType: string
  nullable: boolean
  key: string
  defaultValue: string | null
  extra: string
  characterSet: string | null
  collation: string | null
  comment: string
}

export interface IndexInfo {
  name: string
  unique: boolean
  type: string
  columns: string[]
  comment: string
}

export interface ForeignKeyInfo {
  name: string
  columns: string[]
  referencedSchema: string
  referencedTable: string
  referencedColumns: string[]
  onUpdate: string
  onDelete: string
}

export interface TableStructure {
  schema: string
  name: string
  /** information_schema TABLE_TYPE ('BASE TABLE', 'VIEW', 'SYSTEM VIEW'); absent from older callers. */
  tableType?: string
  columns: ColumnInfo[]
  indexes: IndexInfo[]
  foreignKeys: ForeignKeyInfo[]
  engine: string | null
  collation: string | null
  comment: string
  autoIncrement: number | null
  createSql: string
}

export interface UserInfo {
  user: string
  host: string
  plugin: string
  accountLocked: boolean
  passwordExpired: boolean
  maxConnections: number
}

export type ObjectType = 'table' | 'view' | 'function' | 'procedure' | 'event' | 'trigger'

export interface QueryColumn {
  /** Name shown in the result (the alias when the query uses `AS`). */
  name: string
  type: string
  /** Real source table (mysql2 orgTable, falling back to table). */
  table?: string
  schema?: string
  /** True when the column is part of the source table primary key. */
  primaryKey?: boolean
  /** Real column name in the source table (mysql2 orgName); absent for expressions. */
  sourceName?: string
  /** Table alias used by the query (mysql2 table); tells self-joins apart. */
  tableAlias?: string
}

export type CellValue = string | number | boolean | null

export interface QueryResultSet {
  columns: QueryColumn[]
  rows: CellValue[][]
  truncated: boolean
}

export interface QueryStatementResult {
  sql: string
  durationMs: number
  affectedRows: number | null
  insertId: number | null
  changedRows: number | null
  warnings: number
  resultSet: QueryResultSet | null
  error: string | null
}

/**
 * Trailing options of the IPC channels that write to a connection. Main
 * rejects writes to a connection that needs the typed-name confirmation
 * (environment 'production', always, plus AppSettings.typedConfirmEnvironments)
 * unless the UI sets confirmProduction after the user typed the name.
 */
export interface WriteOptions {
  /**
   * The user typed the connection name. Historical name: it now covers every
   * environment in AppSettings.typedConfirmEnvironments, not only production.
   */
  confirmProduction?: boolean
}

export interface QueryExecuteOptions extends WriteOptions {
  schema?: string | null
  /** Max rows kept per result set. */
  maxRows?: number
  stopOnError?: boolean
}

export interface TableDataRequest {
  schema: string
  table: string
  limit: number
  offset: number
  orderBy?: { column: string; direction: 'ASC' | 'DESC' } | null
  /** Raw WHERE clause without the keyword, run as-is. */
  where?: string | null
  /**
   * Structured filter (Navicat filter builder). Main turns it into a WHERE with
   * escaped identifiers checked against the table's columns and escaped values.
   * When both `where` and `filter` are given they are combined with AND.
   */
  filter?: TableFilter | null
}

/**
 * Filter builder operators. Labels live in the renderer; main maps each one to SQL:
 * - eq/ne/lt/le/gt/ge: `col = ?`, `col <> ?`... (NULL never matches, like SQL)
 * - contains/beginsWith/endsWith (+ not*): `col [NOT] LIKE ?` with %, _ and \ escaped
 * - isNull/isNotNull: `col IS [NOT] NULL`
 * - isEmpty: `(col = '' OR col IS NULL)`; isNotEmpty: `(col <> '' AND col IS NOT NULL)`
 * - in/notIn: `col [NOT] IN (?, ?...)` with one value per list item
 * - between/notBetween: `col [NOT] BETWEEN ? AND ?`
 * - custom: the row's raw SQL fragment, run as-is (same trust level as the raw WHERE)
 * Siblings are joined with their connectors in order; like SQL, AND binds tighter
 * than OR (`a OR b AND c` = `a OR (b AND c)`): brackets (groups) set any other order.
 * Disabled conditions and empty groups are skipped.
 */
export type TableFilterOperator =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'contains'
  | 'notContains'
  | 'beginsWith'
  | 'notBeginsWith'
  | 'endsWith'
  | 'notEndsWith'
  | 'isNull'
  | 'isNotNull'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'in'
  | 'notIn'
  | 'between'
  | 'notBetween'
  | 'custom'

export type TableFilterJoin = 'AND' | 'OR'

/**
 * One condition line. `connector` joins it with the NEXT sibling (Navicat "y"/"o");
 * the last item's connector is unused.
 */
export interface TableFilterCondition {
  kind: 'condition'
  enabled: boolean
  /** Table column (ignored by `custom`). */
  column: string
  operator: TableFilterOperator
  /** One value; two for between/notBetween; the list items for in/notIn; none otherwise. */
  values: string[]
  connector: TableFilterJoin
  /** Raw SQL fragment of a `custom` row. */
  sql?: string | null
}

/** Bracket: its children are combined in order with their own connectors. Groups nest. */
export interface TableFilterGroup {
  kind: 'group'
  enabled: boolean
  connector: TableFilterJoin
  children: TableFilterNode[]
}

export type TableFilterNode = TableFilterCondition | TableFilterGroup

/** The root group (its own connector and brackets are not rendered). */
export type TableFilter = TableFilterGroup

/** Saved filter of one table (Navicat filter profile). */
export interface TableFilterProfile {
  name: string
  filter: TableFilter
  updatedAt: string
}

export interface TableDataPage {
  columns: QueryColumn[]
  rows: CellValue[][]
  primaryKey: string[]
  total: number | null
  durationMs: number
}

export type RowChange =
  | { kind: 'insert'; values: Record<string, CellValue> }
  | { kind: 'update'; key: Record<string, CellValue>; values: Record<string, CellValue> }
  | { kind: 'delete'; key: Record<string, CellValue> }

export interface ApplyRowChangesResult {
  applied: number
  statements: string[]
  /**
   * Generated AUTO_INCREMENT id of each change, aligned with the request
   * (null for updates, deletes and inserts without a generated id).
   */
  insertIds?: (number | null)[]
}

/* ---------- Backups (.nb3) ---------- */

export type BackupObjectType =
  'Table' | 'View' | 'Function' | 'Procedure' | 'Event' | 'Trigger' | string

export interface BackupObjectSummary {
  uuid: string
  type: BackupObjectType
  name: string
  rows: number | null
}

export interface BackupMeta {
  metaVersion: string
  databaseType: string
  schema: string
  startTime: string | null
  endTime: string | null
  encryption: string
  comment: string
  objects: BackupObjectSummary[]
}

export interface BackupFile {
  path: string
  fileName: string
  connectionId: string | null
  schema: string | null
  sizeBytes: number
  createdAt: string
  modifiedAt: string
  source: 'navicat' | 'electrondb' | 'unknown'
  /** Free-text suffix parsed from Navicat names like 20260317145120-staging.nb3 */
  label: string | null
  /**
   * The automation run whose backup step wrote this file (matched by path in
   * the run history; no archive is opened). Absent/null: not written by a job.
   */
  run?: BackupRunRef | null
}

/** Backup step of a job run that produced a file. */
export interface BackupRunRef {
  runId: string
  jobId: string
  jobName: string
  /** When the run started (ISO). */
  startedAt: string
  taskId: string
  /** False when the step copied the structure only. */
  includeData: boolean
}

export interface BackupCreateOptions {
  connectionId: string
  schema: string
  /** Optional override; defaults to the connection backupDir/<schema>. */
  targetDir?: string
  comment?: string
  label?: string
  /** Table names to include; empty = all objects. */
  objects?: string[]
  includeData: boolean
}

export interface BackupCreateResult {
  path: string
  sizeBytes: number
  objects: number
  rows: number
  durationMs: number
}

export interface RestoreOptions {
  backupPath: string
  connectionId: string
  targetSchema: string
  createSchema: boolean
  dropObjectsFirst: boolean
  includeStructure: boolean
  includeData: boolean
  /** Object names to restore; empty = all. */
  objects?: string[]
  continueOnError: boolean
  /**
   * REPLACE the whole database (DROP + CREATE DATABASE, then every object
   * of the backup): it ends up exactly like the backup. Ignores objects,
   * createSchema, dropObjectsFirst and includeStructure; `includeData: false`
   * creates every object with empty tables («Solo estructura»).
   */
  replaceSchema?: boolean
  /** With replaceSchema: back up the current database first (default true). */
  safetyBackup?: boolean
  /** Required when the target connection needs the typed confirmation (see WriteOptions). */
  confirmProduction?: boolean
  /**
   * Internal (replace «Solo estructura»): create tables without the backup's
   * AUTO_INCREMENT value so counters start fresh. Object restores keep it.
   */
  skipAutoIncrement?: boolean
}

export interface RestoreResult {
  objectsRestored: number
  rowsInserted: number
  errors: { object: string; message: string }[]
  durationMs: number
  /** replaceSchema: safety copy of the database that was replaced (null = none taken). */
  safetyBackupPath?: string | null
  /** replaceSchema with `includeData: false`: objects created, no rows inserted. */
  structureOnly?: boolean
}

/* ---------- Automation ---------- */

export type JobTaskType = 'backupschema' | 'runquery' | 'restoreschema'

/**
 * Where a restore step ('restoreschema') takes its .nb3 from:
 * - `task`: the file produced in the same run by an earlier backup step of the job;
 * - `latest`: the newest backup of `schema` from `connectionId` found on disk;
 * - `file`: one explicit file (used by «Restaurar todo» from the run history, never saved in jobs).
 */
export type RestoreTaskSource =
  | { kind: 'task'; taskId: string }
  | { kind: 'latest'; connectionId: string; schema: string }
  | { kind: 'file'; path: string; schema: string; connectionId: string | null }

export interface JobTask {
  id: string
  type: JobTaskType
  /** Connection the step works on (for restoreschema: the TARGET connection). */
  connectionId: string
  /**
   * Schema the step works on. For restoreschema: the target schema, empty =
   * same name as the source schema.
   */
  schema: string
  referenceName: string
  /** For runquery: SQL to execute. */
  sql?: string
  /**
   * backupschema: copy the rows too. restoreschema: restore the rows too;
   * false = «Solo estructura» (empty tables). Absent = true (older jobs).
   */
  includeData?: boolean
  /** For restoreschema: backup to restore. */
  restoreSource?: RestoreTaskSource
  /** For restoreschema: back up the target schema before replacing it (default true). */
  safetyBackup?: boolean
}

export interface JobSchedule {
  enabled: boolean
  /** 5-field cron expression. */
  cron: string
  /** Run even if the app is closed via a launchd agent. */
  launchAgent: boolean
}

export interface Job {
  id: string
  name: string
  continueOnError: boolean
  tasks: JobTask[]
  schedule: JobSchedule
  createdAt: string
  updatedAt: string
  lastRunAt: string | null
  source?: { app: 'navicat'; fileName: string; importedAt: string }
}

export type JobInput = Omit<Job, 'id' | 'createdAt' | 'updatedAt' | 'lastRunAt'> & { id?: string }

export type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled'

export interface JobTaskRun {
  taskId: string
  referenceName: string
  status: RunStatus
  startedAt: string | null
  finishedAt: string | null
  message: string | null
  /** backupschema: the .nb3 written; restoreschema: the safety backup of the target (if any). */
  outputPath: string | null
  /** Step type, connection and schema when the run started (absent in older runs). */
  type?: JobTaskType
  connectionId?: string
  schema?: string
  /** backupschema: the copy includes rows (false = structure only). */
  includeData?: boolean
}

export interface JobRun {
  id: string
  jobId: string
  jobName: string
  status: RunStatus
  trigger: 'manual' | 'schedule' | 'cli'
  startedAt: string
  finishedAt: string | null
  tasks: JobTaskRun[]
  logPath: string
  /** Process executing the run (stale `running` runs are recovered when it no longer exists). */
  pid?: number
  /** 'rollback': restore of the backups of another run («Restaurar todo»). Absent = job run. */
  kind?: 'job' | 'rollback'
  /** For rollback runs: the run whose backups were restored. */
  rollbackOf?: string
}

/* ---------- Rollback of a run («Restaurar todo en Local») ---------- */

export interface RollbackPlanItem {
  /** Backup step of the source run. */
  taskId: string
  referenceName: string
  sourceConnectionId: string | null
  sourceConnectionName: string
  /** Schema stored in the backup (the database that was backed up). */
  schema: string
  /** Database replaced on the target connection (same name as the source). */
  targetSchema: string
  backupPath: string
  sizeBytes: number | null
  /** True: exists on the target and will be REPLACED; null: unknown (target not reachable). */
  targetExists: boolean | null
  /** Why this database cannot be restored (missing file, other schema, encrypted...). */
  problem: string | null
  /** Objects and rows stored in the backup (from its manifest; null = unknown). */
  objects: number | null
  rows: number | null
  /** The backup step copied the structure only: the target tables would end up empty. */
  structureOnly: boolean
  /** Something the user must know before restoring it (no rows...); null = nothing. */
  warning: string | null
}

export interface RollbackPlan {
  /** 'run': the backups of one run; 'files': backup files picked in the backups list. */
  source?: 'run' | 'files'
  /** Source run ('' for a file plan whose files do not all come from one run). */
  runId: string
  /** Job the restore is recorded under (MANUAL_ROLLBACKS_JOB_ID of shared/backupPackages for mixed files). */
  jobId: string
  /** Run: the job name. Files: the title of the selection («staging · 2026-10-05 23:16»). */
  jobName: string
  /** Run start; files: the newest file date. */
  runStartedAt: string
  targetConnectionId: string | null
  items: RollbackPlanItem[]
  /** The target connection could not be inspected; `targetExists` is then null. */
  targetError: string | null
}

export interface RollbackRunRequest {
  source?: 'run'
  runId: string
  targetConnectionId: string
  /** Backup steps of the run to restore (subset of the plan items). */
  taskIds: string[]
  /** Back up each existing target database before replacing it. */
  safetyBackup: boolean
  /** False = «Solo estructura»: every object, empty tables. Absent = true. */
  includeData?: boolean
}

/**
 * Backup files to restore (a package or files picked by hand in the backups
 * list). Each one must live in a backup folder of a known connection.
 */
export interface RollbackFilesSource {
  source: 'files'
  backupPaths: string[]
  /** Connection whose backups list the files were picked from. */
  sourceConnectionId: string
  /** What the user selected, for the dialog and the run name (package title). */
  title?: string
}

export interface RollbackFilesRequest extends RollbackFilesSource {
  targetConnectionId: string
  /** Back up each existing target database before replacing it. */
  safetyBackup: boolean
  /** False = «Solo estructura»: every object, empty tables. Absent = true. */
  includeData?: boolean
}

export type RollbackRequest = RollbackRunRequest | RollbackFilesRequest

/* ---------- Navicat import ---------- */

export interface NavicatDetection {
  found: boolean
  rootPath: string
  connPlistPath: string | null
  prefPlistPath: string | null
  profilesDir: string | null
  connectionCount: number
  jobCount: number
  backupCount: number
}

/** Where an automatically found Navicat folder lives. */
export type NavicatCandidateSource = 'default' | 'appStore' | 'legacy' | 'copied'

/** A Navicat data folder found automatically (its Common/conn.plist parses). */
export interface NavicatCandidate {
  rootPath: string
  source: NavicatCandidateSource
  connectionCount: number
  jobCount: number
  backupCount: number
  /** Last change of Common/conn.plist (ISO), null when unknown. */
  modifiedAt: string | null
}

export interface NavicatCandidatesResult {
  /**
   * False outside macOS: Navicat for Windows/Linux keeps its connections
   * elsewhere (Registry...), only a copied macOS «Navicat CC» folder can be read.
   */
  supportedPlatform: boolean
  /** Best first: most connections, then most recently changed. */
  candidates: NavicatCandidate[]
}

export interface NavicatConnectionPreview {
  name: string
  host: string
  port: number
  username: string
  color: string | null
  environment: Environment
  ssh: SshConfig
  ssl: SslConfig
  savePath: string | null
  customDatabases: string[]
  initialQueries: string
  backupCount: number
  alreadyImported: boolean
}

export interface NavicatJobPreview {
  fileName: string
  name: string
  continueOnError: boolean
  tasks: { type: string; server: string; schema: string; referenceName: string }[]
  alreadyImported: boolean
}

export interface NavicatImportRequest {
  connections: string[]
  jobs: string[]
}

export interface NavicatImportResult {
  connections: ConnectionConfig[]
  jobs: Job[]
  warnings: string[]
}

export interface KeychainRecoveryResult {
  attempted: number
  recovered: { account: string; connectionName: string | null }[]
  warnings: string[]
}

/* ---------- Settings / app ---------- */

/** A message the renderer shows once after start, then dismisses through IPC. */
export interface StartupNotice {
  id: string
  level: 'info' | 'warning'
  title: string
  message: string
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  node: string
  platform: string
  userDataPath: string
  logPath: string
}

export interface AppSettings {
  navicatRootPath: string
  backupsRootDir: string
  defaultRowLimit: number
  theme: 'dark' | 'light'
  /**
   * Environments whose connections need the typed-name confirmation before
   * any write (and `confirmProduction: true` on the IPC call). Always contains
   * 'production' (it cannot be removed); defaults to ['production']. Replaces
   * the old boolean `confirmProductionWrites`, which is no longer honoured.
   */
  typedConfirmEnvironments: Environment[]
  /**
   * Ask before DROP / TRUNCATE / DELETE (and deleting rows or objects) on any
   * connection, not only production. Renderer-only convenience: main does not
   * enforce it. Defaults to true, also for profiles saved before it existed.
   */
  confirmDestructiveEverywhere: boolean
  /** Look for a new release on GitHub a few seconds after start (at most every 6 hours). */
  checkUpdatesOnStartup: boolean
  /**
   * «Descargar actualizaciones automáticamente» (off by default): when the startup check finds
   * a new version, start the in-app download without waiting for a click. Installing always
   * needs the user (or happens when the app quits). Only where the app can update itself
   * (Windows installer, Linux AppImage).
   */
  autoDownloadUpdates: boolean
  /** «Activar asistente de IA» (off by default; needs a configured provider). */
  aiEnabled: boolean
  /** Provider profile used by the assistant (null: the first one). */
  aiDefaultProviderId: string | null
  /** Reasoning effort for providers that support it (Claude): Bajo / Medio / Alto. */
  aiEffort: AiEffort
  /** Max output tokens per answer. */
  aiMaxTokens: number
}

/* ---------- Updates ---------- */

/** How this copy runs: an installer build, or `npm run dev` / `electron .` from a folder. */
export type UpdateRunMode = 'packaged' | 'source'

/**
 * How this copy installs a new version:
 * - 'auto': downloaded and installed from the app (electron-updater; Windows NSIS installer,
 *   Linux AppImage). The download is checked against the sha512 of latest.yml.
 * - 'mac-dmg': the app downloads the .dmg and checks its SHA-256, the user drags the app to
 *   Applications (self-install needs an Apple Developer ID signature, which ElectronDB lacks).
 * - 'manual': the browser downloads the file (portable .exe, .deb, test profiles).
 * - 'source': runs from a folder (`npm run dev`): commands to paste in a terminal.
 */
export type UpdateInstallMode = 'auto' | 'mac-dmg' | 'manual' | 'source'

/** In-app download/installation of an update (the dialog's progress and buttons). */
export interface UpdateInstallState {
  mode: UpdateInstallMode
  phase: 'idle' | 'downloading' | 'downloaded' | 'error'
  /** Version being downloaded or ready. */
  version?: string
  /** Bytes received so far and expected (0 when unknown). */
  transferred?: number
  total?: number
  bytesPerSecond?: number
  /** 'mac-dmg': the verified .dmg on disk. */
  filePath?: string
  /** Spanish, actionable message when phase is 'error'. */
  error?: string
  /** «Descargar manualmente»: the asset or release page (allowlisted for app:openExternal). */
  manualUrl?: string
  /** The last download was cancelled by the user (phase is back to 'idle'). */
  cancelled?: boolean
}

export interface UpdateAsset {
  url: string
  fileName: string
  sizeBytes: number
  /** Short Spanish label for buttons ("Instalador", "Portable", ".deb"...). */
  label: string
}

/** How to update a copy that runs from a git checkout. */
export interface SourceUpdateInfo {
  /** Folder holding the checkout (where the commands must run). */
  dir: string
  /** False when no `.git` was found (a copied folder): `git pull` cannot update it. */
  isGit: boolean
  /** Current branch read from .git/HEAD; null when detached or unknown. */
  branch: string | null
  /** Commands to paste into a terminal, one per line. */
  commands: string[]
}

export interface UpdateCheckResult {
  status: 'up-to-date' | 'available' | 'error'
  currentVersion: string
  latestVersion?: string
  releaseName?: string
  releaseUrl?: string
  publishedAt?: string
  /** Release notes (markdown, truncated to ~4000 characters). */
  notes?: string
  /** Best download for this OS/architecture (packaged copies). */
  download?: UpdateAsset
  alternatives?: UpdateAsset[]
  runMode: UpdateRunMode
  /** How this copy can install the new version (see UpdateInstallMode). */
  installMode?: UpdateInstallMode
  /** Present in source mode: the folder and the commands to update it. */
  source?: SourceUpdateInfo
  /** The user chose «Omitir esta versión» for latestVersion. */
  dismissed?: boolean
  /** «Más tarde» was chosen less than 6 hours ago: no automatic popup. */
  snoozed?: boolean
  /** ISO date of the GitHub data used (fresh fetch or the cached one). */
  checkedAt?: string
  /** Spanish, actionable message when status is 'error'. */
  error?: string
}

/** «Novedades» popup shown once after updating (see src/shared/whatsNew.ts). */
export interface WhatsNewInfo {
  currentVersion: string
  /** Version seen before the update; null when unknown (profile from an older build). */
  previousVersion: string | null
  /** Curated entries in the range, newest first. */
  entries: WhatsNewEntry[]
  /** Release page of the current version (allowlisted for app:openExternal). */
  releaseUrl: string
}

/* ---------- Progress events ---------- */

export interface ProgressEvent {
  /** Correlates with the invoke that started the operation. */
  operationId: string
  kind: 'backup' | 'restore' | 'job' | 'import' | 'query'
  phase: string
  current: number
  total: number | null
  message: string
  done: boolean
  error?: string
  /** Structured progress (backups and automation runs); renderers fall back to `message`. */
  detail?: ProgressDetail
}

/** Structured progress of a backup or an automation run. Every field is optional. */
export interface ProgressDetail {
  /** Automation runs: job name, 1-based step number, step count and step label (schema). */
  jobName?: string
  step?: number
  steps?: number
  stepLabel?: string
  /** Object being processed: `Statement` for SQL steps, backup object types otherwise. */
  objectType?: BackupObjectType | 'Statement'
  objectName?: string
  /** 1-based index of the current object and object count of the step/operation. */
  objectIndex?: number
  objects?: number
  /** Objects already finished in the step/operation. */
  objectsDone?: number
  /** Rows written so far for the current object (null: structure only). */
  rows?: number | null
  /** Failure message of the current object. */
  error?: string
  /** Estimated row count of the current table (information_schema TABLE_ROWS), null if unknown. */
  rowsEstimate?: number | null
  /** Weighted work units (objects + estimated rows) done / total in the step/operation. */
  workDone?: number
  workTotal?: number
}

/** Live lines of an automation run log (event:jobLog). `seq` is the index of `lines[0]` in the log. */
export interface JobLogEvent {
  runId: string
  seq: number
  lines: string[]
}

export interface LogEvent {
  level: 'debug' | 'info' | 'warn' | 'error'
  scope: string
  message: string
  at: string
}
