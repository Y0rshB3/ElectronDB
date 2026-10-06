/**
 * Shared domain types used by main, preload and renderer.
 * Keep this file free of Node/Electron/browser-only imports.
 */

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
 * rejects writes to a connection whose environment is 'production' (while
 * AppSettings.confirmProductionWrites is on) unless the UI sets
 * confirmProduction after the user confirmed.
 */
export interface WriteOptions {
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
  /** Required when the target connection is flagged production. */
  confirmProduction?: boolean
}

export interface RestoreResult {
  objectsRestored: number
  rowsInserted: number
  errors: { object: string; message: string }[]
  durationMs: number
}

/* ---------- Automation ---------- */

export type JobTaskType = 'backupschema' | 'runquery'

export interface JobTask {
  id: string
  type: JobTaskType
  connectionId: string
  schema: string
  referenceName: string
  /** For runquery: SQL to execute. */
  sql?: string
  includeData?: boolean
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
  outputPath: string | null
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
}

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
  confirmProductionWrites: boolean
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
