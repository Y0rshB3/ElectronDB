/**
 * Import framework contract (renderer <-> main): connection files of other
 * database managers, SQL dumps and dump folders. Every source is read from a
 * file or folder the user owns and picks; nothing here reads another
 * application's keychain, credential manager or registry.
 *
 * Main side: src/main/importers/ (registry.ts lists the sources).
 * Renderer: components/import/ImportWizard.vue («Importar…»).
 */
import type { ConnectionConfig, EngineId, Environment } from './types'

/** Every source the «Importar…» wizard offers. */
export type ImportSourceId =
  | 'navicat-folder'
  | 'navicat-ncx'
  | 'dbeaver'
  | 'workbench'
  | 'sql-dump'
  | 'sql-folder'
  | 'nb3'

/**
 * What the wizard does after the source is picked:
 * - `navicatFolder`: the Navicat folder flow (detection, confirm, preview of connections and jobs);
 * - `connections`: a connections file (preview, select, import);
 * - `sqlDump`: one .sql / .sql.gz file restored into a connection;
 * - `sqlFolder`: a folder of dumps, one per database («paquete»);
 * - `nb3`: a .nb3 copy, restored with the existing restore dialog.
 */
export type ImportFlow = 'navicatFolder' | 'connections' | 'sqlDump' | 'sqlFolder' | 'nb3'

export interface ImportFileFilter {
  name: string
  extensions: string[]
}

/** One entry of the source list (`importers:sources`). */
export interface ImportSourceInfo {
  id: ImportSourceId
  flow: ImportFlow
  /** Short title, e.g. «DBeaver» or «Archivo .sql». */
  label: string
  /** One line under the title. */
  description: string
  icon: string
  /** What the user picks. */
  pick: 'file' | 'folder'
  /** Dialog filters when `pick` is 'file'. */
  filters: ImportFileFilter[]
  /** Usual location of the file on this OS (shown as a hint), or null. */
  defaultPathHint: string | null
  /** The usual location exists on this computer: offered as «Usar este archivo». */
  detectedPath: string | null
  /** Files of this source may carry passwords (Navicat .ncx with «Export Password»). */
  mayContainPasswords: boolean
}

/** One connection found in a connections file. */
export interface ImportConnectionItem {
  /** Stable key inside the file (the name, or the tool's own id); sent back in the request. */
  key: string
  name: string
  /** Engine Vortaq would create; null = not importable (see `unsupportedReason`). */
  engine: EngineId | null
  /** Engine as the file names it («MySQL», «PostgreSQL», «SQL Server»…). */
  engineLabel: string
  host: string
  port: number
  username: string
  /** Default database of the connection, if the file has one. */
  database: string | null
  ssh: boolean
  ssl: boolean
  color: string | null
  environment: Environment
  /** The file carries a password for this connection (decoded only in main). */
  hasPassword: boolean
  /** Id of the Vortaq connection imported earlier from the same source and name, if any. */
  existingConnectionId: string | null
  /** Why it cannot be imported (engine not supported…); null = importable. */
  unsupportedReason: string | null
  warnings: string[]
}

export interface ImportConnectionsPreview {
  source: ImportSourceId
  path: string
  items: ImportConnectionItem[]
  /** Notes for the whole file (passwords not imported, file format version…). */
  notes: string[]
  /** At least one item has a password: the wizard warns to delete the file afterwards. */
  containsPasswords: boolean
}

/**
 * - `passwords`: an already imported connection only gets the passwords of the file;
 * - `replace`: its connection data is replaced too (id, environment chosen by the user,
 *   backup folder and stored secrets the file lacks are kept).
 */
export type ExistingConnectionMode = 'passwords' | 'replace'

export interface ImportConnectionsRequest {
  source: ImportSourceId
  path: string
  /** `ImportConnectionItem.key` of every connection to import. */
  keys: string[]
  existingMode: ExistingConnectionMode
}

export interface ImportConnectionsResult {
  created: ConnectionConfig[]
  updated: ConnectionConfig[]
  /** Connections that received at least one password from the file. */
  passwordsSaved: number
  warnings: string[]
}

/* ---------- SQL dumps ---------- */

/** What a quick scan of a dump found (`importers:inspectSqlDump`). */
export interface SqlDumpInspection {
  path: string
  fileName: string
  sizeBytes: number
  gzip: boolean
  /** Tool named in the header (mysqldump, phpMyAdmin, HeidiSQL…), null when unknown. */
  tool: string | null
  /** Databases named by CREATE DATABASE / USE, in file order. */
  databases: string[]
  hasCreateDatabase: boolean
  hasUse: boolean
  /** Rough counts from the scan (lines that start a statement). */
  counts: SqlObjectCounts
  /** The dump changes DELIMITER (routines or triggers with bodies). */
  usesDelimiter: boolean
  /** The dump names DEFINER accounts. */
  hasDefiners: boolean
  warnings: string[]
}

export interface SqlObjectCounts {
  databases: number
  tables: number
  views: number
  routines: number
  triggers: number
  events: number
  inserts: number
}

/**
 * - `asFile`: run the dump as it is; its USE / CREATE DATABASE decide where objects go
 *   (`targetSchema` is only the default schema for statements before the first USE);
 * - `intoSchema`: everything goes into `targetSchema`: CREATE DATABASE is skipped and
 *   USE is redirected; qualified names of other databases are not rewritten.
 */
export type SqlDumpMode = 'asFile' | 'intoSchema'

export interface SqlDumpImportOptions {
  path: string
  connectionId: string
  mode: SqlDumpMode
  /** Required for `intoSchema`; optional default schema for `asFile`. */
  targetSchema: string | null
  /** Create `targetSchema` when it does not exist (intoSchema / asFile default schema). */
  createSchema: boolean
  /**
   * intoSchema only: drop and create `targetSchema` before importing, so the database ends
   * up equal to the dump.
   */
  replaceSchema: boolean
  /** With `replaceSchema`: a .nb3 copy of the current database is written first (default true). */
  safetyBackup: boolean
  /** Keep going after a failed statement (each error is listed with its line). */
  continueOnError: boolean
  /** Required when the connection needs the typed confirmation (see WriteOptions). */
  confirmProduction?: boolean
}

export interface SqlDumpError {
  /** 1-based line of the statement in the file. */
  line: number
  /** First characters of the statement (shown to the user, never logged). */
  statement: string
  message: string
}

export interface SqlDumpImportResult {
  statements: number
  /** Statements that ran without error. */
  executed: number
  rowsAffected: number
  /** Objects created by successful statements. */
  created: SqlObjectCounts
  errors: SqlDumpError[]
  /** Statements skipped on purpose (CREATE DATABASE in intoSchema mode…). */
  skipped: number
  /** Databases the statements ran in. */
  databases: string[]
  bytesRead: number
  bytesTotal: number
  durationMs: number
  /** .nb3 copy of the replaced database (replaceSchema), null when none was taken. */
  safetyBackupPath: string | null
}

/** Message of the error thrown when the user cancels an import (the log keeps what ran). */
export const SQL_IMPORT_CANCELLED = 'Importación cancelada'

/* ---------- Folder of dumps («paquete») ---------- */

export interface SqlFolderItem {
  path: string
  fileName: string
  sizeBytes: number
  /** Target database proposed from the file name (editable in the wizard). */
  schema: string
}

export interface SqlFolderPreview {
  dir: string
  items: SqlFolderItem[]
  /** Files ignored (not .sql / .sql.gz) or unreadable. */
  warnings: string[]
}

export interface SqlFolderImportRequest {
  dir: string
  connectionId: string
  /** Files to import with their target database (an entry per selected file). */
  items: { path: string; schema: string }[]
  /** Drop and create each target database first (with a safety copy when it exists). */
  replaceSchema: boolean
  safetyBackup: boolean
  continueOnError: boolean
  confirmProduction?: boolean
}

export interface SqlFolderImportResult {
  items: {
    path: string
    schema: string
    /** null when the file did not run (cancelled before it, or a fatal error). */
    result: SqlDumpImportResult | null
    error: string | null
  }[]
  durationMs: number
}

/* ---------- Export to .sql ---------- */

export interface SqlExportOptions {
  connectionId: string
  schema: string
  /** Folder for the file; defaults to the connection's backup folder/<schema>. */
  targetDir?: string
  /** Exact file path; overrides targetDir (the wizard's «Guardar como…»). */
  targetPath?: string
  includeStructure: boolean
  includeData: boolean
  /** Add CREATE DATABASE + USE (true) or leave the schema to the importer (false). */
  includeCreateDatabase: boolean
  /** Write .sql.gz instead of .sql. */
  gzip?: boolean
  /** Table/view/routine names to include; empty = every object. */
  objects?: string[]
  label?: string
}

export interface SqlExportResult {
  path: string
  sizeBytes: number
  objects: number
  rows: number
  durationMs: number
}

/** Format of a job backup step and of «Nueva copia». Absent = 'nb3'. */
export type BackupFormat = 'vqb' | 'nb3' | 'sql'
