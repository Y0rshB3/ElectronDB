import { join } from 'node:path'
import { engineOf } from '@shared/engines'
import type {
  ConnectionConfig,
  ConnectionInput,
  Environment,
  Job,
  JobInput,
  JobTask,
  NavicatImportRequest,
  NavicatImportResult,
  NavicatJobPreview
} from '@shared/types'
import type { AppContext } from '../context'
import { newId, nowIso } from '../storage/ids'
import { isJobImportedFromNavicat, readNavicatJobs } from './batchJobs'
import {
  isImportedFromNavicat,
  readNavicatConnections,
  type NavicatConnectionEntry
} from './connPlist'

/** The slice of the app context the importer needs (keeps tests free of Electron). */
export type ImportContext = Pick<AppContext, 'connections' | 'jobs' | 'settings'>

const DEFAULT_SCHEDULE: Job['schedule'] = { enabled: false, cron: '0 3 * * *', launchAgent: false }

/** File-system safe folder name derived from a connection name. */
export function safeDirName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return cleaned || 'connection'
}

/**
 * Environment on (re-)import. A record the user already flagged as production
 * is never downgraded by the name heuristic (it guards write confirmations);
 * otherwise an existing user choice is kept unless Navicat now says production.
 */
function mergeEnvironment(existing: ConnectionConfig | null, inferred: Environment): Environment {
  if (!existing) return inferred
  if (existing.environment === 'production' || inferred === 'production') return 'production'
  return existing.environment
}

/** Keeps directories the user added and appends Navicat's backup folder once. */
function mergeExtraDirs(current: string[], navicatDir: string | null): string[] {
  const dirs = [...current]
  if (navicatDir && !dirs.includes(navicatDir)) dirs.push(navicatDir)
  return dirs
}

function toConnectionInput(
  entry: NavicatConnectionEntry,
  existing: ConnectionConfig | null,
  backupsRootDir: string,
  importedAt: string
): ConnectionInput {
  const { connection, backupSourceDir } = entry
  return {
    id: existing?.id,
    // Navicat's MySQL section: ConnectionsRepo.save refuses to turn a record of
    // another engine into MySQL.
    engine: 'mysql',
    name: existing?.name ?? connection.name,
    color: connection.color,
    environment: mergeEnvironment(existing, connection.environment),
    host: connection.host,
    port: connection.port,
    username: connection.username,
    // Navicat files never say whether a password is needed: keep what the user
    // chose on a re-import, otherwise assume one (it is never stored there).
    authMode: existing?.authMode ?? 'password',
    savePassword: connection.savePassword,
    customDatabases: connection.customDatabases,
    initialQueries: connection.initialQueries,
    ssh: connection.ssh,
    ssl: connection.ssl,
    backupDir: existing?.backupDir ?? join(backupsRootDir, safeDirName(connection.name)),
    extraBackupDirs: mergeExtraDirs(existing?.extraBackupDirs ?? [], backupSourceDir),
    source: { app: 'navicat', name: connection.name, importedAt }
  }
}

function findByNavicatName(connections: ConnectionConfig[], name: string): ConnectionConfig | null {
  return connections.find((c) => isImportedFromNavicat(c, name)) ?? null
}

/**
 * Resolves a batch-job `Server` to a ElectronDB connection: same-request imports first, then Navicat name, then display name.
 * Only connections whose engine has automation (MySQL) are candidates (section 11).
 */
function resolveServer(
  server: string,
  imported: Map<string, ConnectionConfig>,
  connections: ConnectionConfig[]
): ConnectionConfig | null {
  const all = connections.filter((c) => {
    try {
      return engineOf(c).capabilities.supportsAutomation
    } catch {
      return false // a hand-edited, unknown engine is never a job target
    }
  })
  return (
    imported.get(server) ??
    findByNavicatName(all, server) ??
    all.find((c) => c.name === server) ??
    null
  )
}

function buildTasks(
  preview: NavicatJobPreview,
  existing: Job | null,
  imported: Map<string, ConnectionConfig>,
  all: ConnectionConfig[],
  warnings: string[]
): JobTask[] {
  const tasks: JobTask[] = []
  for (const task of preview.tasks) {
    const label = task.referenceName || task.schema
    if (task.type !== 'backupschema') {
      warnings.push(
        `Tarea "${label}" de "${preview.name}" omitida: tipo "${task.type}" no soportado`
      )
      continue
    }
    const connection = resolveServer(task.server, imported, all)
    if (!connection) {
      warnings.push(
        `Tarea "${label}" de "${preview.name}" omitida: la conexión "${task.server}" no existe en ElectronDB (impórtala primero)`
      )
      continue
    }
    const previous = existing?.tasks.find(
      (t) =>
        t.type === 'backupschema' &&
        t.connectionId === connection.id &&
        t.schema === task.schema &&
        t.referenceName === task.referenceName
    )
    tasks.push({
      id: previous?.id ?? newId(),
      type: 'backupschema',
      connectionId: connection.id,
      schema: task.schema,
      referenceName: task.referenceName || `Backup ${task.schema}`,
      includeData: true
    })
  }
  return tasks
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

/**
 * Imports the selected Navicat connections and batch jobs into ElectronDB.
 * Idempotent: a connection already imported (same Navicat name) or a job with
 * the same source file is updated in place, keeping its id and stored secrets.
 */
export async function importFromNavicat(
  ctx: ImportContext,
  request: NavicatImportRequest,
  root?: string | null
): Promise<NavicatImportResult> {
  const rootPath = root?.trim() || ctx.settings.get().navicatRootPath
  const wantedConnections = new Set(stringList(request?.connections))
  const wantedJobs = new Set(stringList(request?.jobs))
  const warnings: string[] = []
  const importedAt = nowIso()
  const result: NavicatImportResult = { connections: [], jobs: [], warnings }

  // Read every Navicat source before writing anything, so a read failure
  // cannot leave the import half done.
  const connectionEntries =
    wantedConnections.size > 0 ? await readNavicatConnections(rootPath, ctx.connections.list()) : []
  const jobPreviews =
    wantedJobs.size > 0 ? await readNavicatJobs(rootPath, ctx.jobs.list(), warnings) : []

  if (wantedConnections.size > 0) {
    const byName = new Map(connectionEntries.map((e) => [e.connection.name, e]))
    for (const name of wantedConnections) {
      const entry = byName.get(name)
      if (!entry) {
        warnings.push(`La conexión "${name}" no existe en conn.plist de Navicat`)
        continue
      }
      const existing = findByNavicatName(ctx.connections.list(), name)
      const saved = ctx.connections.save(
        toConnectionInput(entry, existing, ctx.settings.get().backupsRootDir, importedAt)
      )
      result.connections.push(saved)
    }
  }

  if (wantedJobs.size > 0) {
    const byFile = new Map(jobPreviews.map((p) => [p.fileName, p]))
    const importedConnections = new Map(
      result.connections.map((c) => [c.source?.name ?? c.name, c])
    )
    const allConnections = ctx.connections.list()
    for (const fileName of wantedJobs) {
      const preview = byFile.get(fileName)
      if (!preview) {
        // a profile skipped as unreadable already has its own warning
        if (!warnings.some((w) => w.includes(`"${fileName}"`))) {
          warnings.push(`El perfil "${fileName}" no existe en la carpeta Profiles de Navicat`)
        }
        continue
      }
      const existing = ctx.jobs.list().find((j) => isJobImportedFromNavicat(j, fileName)) ?? null
      const input: JobInput = {
        id: existing?.id,
        name: existing?.name ?? preview.name,
        continueOnError: preview.continueOnError,
        tasks: buildTasks(preview, existing, importedConnections, allConnections, warnings),
        schedule: existing?.schedule ?? { ...DEFAULT_SCHEDULE },
        source: { app: 'navicat', fileName, importedAt }
      }
      result.jobs.push(ctx.jobs.save(input))
    }
  }

  return result
}
