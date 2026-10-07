import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ExistingConnectionMode,
  ImportConnectionItem,
  ImportConnectionsPreview,
  ImportConnectionsRequest,
  ImportConnectionsResult,
  ImportSourceId
} from '@shared/importers'
import { engineAvailabilityError } from '@shared/connectionValidation'
import { engineOf } from '@shared/engines'
import type { ConnectionConfig, ConnectionInput, EngineId, Environment } from '@shared/types'
import type { AppContext } from '../../context'
import type { ConnectionSecretKind } from '../../credentials/store'
import { safeDirName } from '../../navicat/importer'
import { nowIso } from '../../storage/ids'
import { parseDbeaverDataSources } from './dbeaver'
import { parseNcx } from './ncx'
import type { ConnectionSecrets, ParsedConnection, ParsedConnectionFile } from './types'
import { previewEngineReason } from './util'
import { parseWorkbenchConnections } from './workbench'

/** The slice of the app context connection imports need (keeps tests free of Electron). */
export type ConnectionImportContext = Pick<AppContext, 'connections' | 'credentials' | 'settings'>

type SourceApp = NonNullable<ConnectionConfig['source']>['app']

interface ConnectionFileSource {
  app: SourceApp
  format: 'ncx' | 'json' | 'xml'
  parse(text: string, platform: NodeJS.Platform): ParsedConnectionFile
}

const SOURCES: Partial<Record<ImportSourceId, ConnectionFileSource>> = {
  'navicat-ncx': { app: 'navicat', format: 'ncx', parse: parseNcx },
  dbeaver: { app: 'dbeaver', format: 'json', parse: parseDbeaverDataSources },
  workbench: { app: 'workbench', format: 'xml', parse: parseWorkbenchConnections }
}

/** Connection files are small; anything bigger is not one. */
const MAX_FILE_BYTES = 20 * 1024 * 1024

function sourceOf(id: ImportSourceId): ConnectionFileSource {
  const source = SOURCES[id]
  if (!source) throw new Error('Ese origen no contiene conexiones.')
  return source
}

async function readConnectionFile(
  source: ConnectionFileSource,
  path: string,
  platform: NodeJS.Platform
): Promise<ParsedConnectionFile> {
  let text: string
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`La ruta no es un archivo: ${path}`)
    if (info.size > MAX_FILE_BYTES)
      throw new Error(`El archivo es demasiado grande para ser un archivo de conexiones: ${path}`)
    text = await readFile(path, 'utf8')
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') throw new Error(`No se encontró el archivo: ${path}`)
    if (code === 'EACCES' || code === 'EPERM')
      throw new Error(`Sin permisos para leer el archivo: ${path}`)
    throw err
  }
  return source.parse(text, platform)
}

/**
 * The Vortaq connection imported earlier from the same manager and name.
 * Navicat identity also includes the type (plist section or .ncx ConnType;
 * records without one are MySQL), so an .ncx merges into plist imports.
 */
export function findImported(
  connections: ConnectionConfig[],
  app: SourceApp,
  item: Pick<ParsedConnection, 'name' | 'navicatType'>
): ConnectionConfig | null {
  return (
    connections.find(
      (c) =>
        c.source?.app === app &&
        c.source.name === item.name &&
        (app !== 'navicat' || (c.source.navicatType ?? 'MySQL') === (item.navicatType ?? 'MySQL'))
    ) ?? null
  )
}

/**
 * Why a parsed connection cannot be imported here: unsupported engine, an engine without a
 * driver in this build, or a preview engine while «Motores en vista previa» is off. null = ok.
 */
export function importBlockReason(
  parsed: Pick<ParsedConnection, 'engine' | 'unsupportedReason'>,
  previewEngines: boolean
): string | null {
  if (!parsed.engine) return parsed.unsupportedReason ?? 'Motor no soportado'
  if (parsed.unsupportedReason) return parsed.unsupportedReason
  const unavailable = engineAvailabilityError({ engine: parsed.engine })
  if (unavailable) return unavailable
  const engine = engineOf({ engine: parsed.engine })
  return engine.capabilities.preview && !previewEngines ? previewEngineReason(engine.label) : null
}

const previewOn = (ctx: Pick<AppContext, 'settings'>): boolean =>
  ctx.settings.get().previewEngines === true

function toItem(
  parsed: ParsedConnection,
  existing: ConnectionConfig | null,
  previewEngines: boolean
): ImportConnectionItem {
  return {
    key: parsed.key,
    name: parsed.name,
    engine: parsed.engine,
    engineLabel: parsed.engineLabel,
    host: parsed.host,
    port: parsed.port,
    username: parsed.username,
    database: parsed.database,
    ssh: parsed.ssh.enabled,
    ssl: parsed.ssl.enabled,
    color: parsed.color,
    environment: parsed.environment,
    hasPassword: parsed.secrets.mysql !== undefined,
    existingConnectionId: existing?.id ?? null,
    unsupportedReason: parsed.engine
      ? importBlockReason(parsed, previewEngines)
      : parsed.unsupportedReason,
    warnings: [...parsed.warnings]
  }
}

/** Preview of the connections in `path` (a file of `source`). Secrets never leave main. */
export async function previewConnectionFile(
  ctx: Pick<AppContext, 'connections' | 'settings'>,
  sourceId: ImportSourceId,
  path: string,
  platform: NodeJS.Platform = process.platform
): Promise<ImportConnectionsPreview> {
  const source = sourceOf(sourceId)
  const file = await readConnectionFile(source, path, platform)
  const existing = ctx.connections.list()
  const preview = previewOn(ctx)
  const items = file.connections.map((c) =>
    toItem(c, findImported(existing, source.app, c), preview)
  )
  return {
    source: sourceId,
    path,
    items,
    notes: [...file.notes],
    containsPasswords: file.connections.some((c) => Object.keys(c.secrets).length > 0)
  }
}

/** A user-chosen environment is kept, but production always wins (it guards writes). */
function mergeEnvironment(existing: ConnectionConfig | null, inferred: Environment): Environment {
  if (!existing) return inferred
  if (existing.environment === 'production' || inferred === 'production') return 'production'
  return existing.environment
}

/** PostgreSQL block: the file's database is the initial one; other options stay as they were. */
function postgresBlock(
  parsed: ParsedConnection,
  existing: ConnectionConfig | null
): Pick<ConnectionInput, 'postgres'> {
  return {
    postgres: {
      showSystemSchemas: false,
      timeZone: '',
      searchPath: '',
      ...existing?.postgres,
      initialDatabase: parsed.database || existing?.postgres?.initialDatabase || 'postgres'
    }
  }
}

function toInput(
  parsed: ParsedConnection,
  source: ConnectionFileSource,
  existing: ConnectionConfig | null,
  backupsRootDir: string,
  importedAt: string
): ConnectionInput {
  const engine: EngineId = parsed.engine ?? 'mysql'
  return {
    id: existing?.id,
    engine,
    ...(engine === 'postgresql' ? postgresBlock(parsed, existing) : {}),
    name: existing?.name ?? parsed.name,
    color: parsed.color ?? existing?.color ?? null,
    environment: mergeEnvironment(existing, parsed.environment),
    host: parsed.host,
    port: parsed.port,
    username: parsed.username,
    authMode: existing?.authMode ?? 'password',
    savePassword: parsed.secrets.mysql !== undefined || (existing?.savePassword ?? false),
    customDatabases: existing?.customDatabases ?? [],
    initialQueries: existing?.initialQueries ?? '',
    ssh: {
      ...parsed.ssh,
      savePassword: parsed.secrets.ssh !== undefined || (existing?.ssh.savePassword ?? false)
    },
    ssl: parsed.ssl,
    backupDir: existing?.backupDir ?? join(backupsRootDir, safeDirName(parsed.name)),
    extraBackupDirs: existing?.extraBackupDirs ?? [],
    source: {
      app: source.app,
      name: parsed.name,
      importedAt,
      format: source.format,
      ...(parsed.navicatType ? { navicatType: parsed.navicatType } : {})
    }
  }
}

const SECRET_SLOTS: [keyof ConnectionSecrets, ConnectionSecretKind][] = [
  ['mysql', 'mysql'],
  ['ssh', 'ssh'],
  ['sslKey', 'sslKey']
]

/** Stores the secrets the file carried; true when at least one was saved. */
function saveSecrets(
  ctx: ConnectionImportContext,
  id: string,
  secrets: ConnectionSecrets
): boolean {
  let saved = false
  for (const [field, kind] of SECRET_SLOTS) {
    const value = secrets[field]
    if (value === undefined) continue
    ctx.credentials.set(kind, id, value)
    saved = true
  }
  return saved
}

function validateRequest(request: ImportConnectionsRequest): {
  keys: string[]
  mode: ExistingConnectionMode
} {
  if (!request || typeof request !== 'object') throw new Error('Petición no válida.')
  const keys = Array.isArray(request.keys)
    ? request.keys.filter((k): k is string => typeof k === 'string' && k !== '')
    : []
  if (!keys.length) throw new Error('Elige al menos una conexión para importar.')
  const mode = request.existingMode ?? 'passwords'
  if (mode !== 'passwords' && mode !== 'replace')
    throw new Error('Modo no válido para las conexiones ya importadas.')
  return { keys, mode }
}

/**
 * Imports the selected connections of a file. The file is read and parsed
 * again here: nothing the renderer sends besides keys and mode is trusted.
 */
export async function importConnectionFile(
  ctx: ConnectionImportContext,
  request: ImportConnectionsRequest,
  platform: NodeJS.Platform = process.platform
): Promise<ImportConnectionsResult> {
  const { keys, mode } = validateRequest(request)
  const source = sourceOf(request.source)
  const file = await readConnectionFile(source, request.path, platform)
  const byKey = new Map(file.connections.map((c) => [c.key, c]))
  const result: ImportConnectionsResult = {
    created: [],
    updated: [],
    passwordsSaved: 0,
    warnings: []
  }
  const importedAt = nowIso()
  const backupsRootDir = ctx.settings.get().backupsRootDir
  const preview = previewOn(ctx)

  for (const key of new Set(keys)) {
    const parsed = byKey.get(key)
    if (!parsed) {
      result.warnings.push(`La conexión «${key}» ya no está en el archivo`)
      continue
    }
    // Main enforces the same rules as the preview (unsupported, unavailable, preview engine off).
    const blocked = importBlockReason(parsed, preview)
    if (!parsed.engine || blocked) {
      result.warnings.push(
        `«${parsed.name}» no se ha importado: ${blocked ?? 'motor no soportado'}`
      )
      continue
    }
    const existing = findImported(ctx.connections.list(), source.app, parsed)
    try {
      if (existing && mode === 'passwords') {
        if (!Object.keys(parsed.secrets).length) {
          result.warnings.push(
            `«${existing.name}» ya estaba importada y el archivo no trae contraseñas: no se ha cambiado`
          )
          continue
        }
        const patched: ConnectionInput = {
          ...existing,
          savePassword: existing.savePassword || parsed.secrets.mysql !== undefined,
          ssh: {
            ...existing.ssh,
            savePassword: existing.ssh.savePassword || parsed.secrets.ssh !== undefined
          }
        }
        const saved = ctx.connections.save(patched)
        if (saveSecrets(ctx, saved.id, parsed.secrets)) result.passwordsSaved++
        result.updated.push(saved)
        continue
      }
      const saved = ctx.connections.save(
        toInput(parsed, source, existing, backupsRootDir, importedAt)
      )
      if (saveSecrets(ctx, saved.id, parsed.secrets)) result.passwordsSaved++
      if (existing) result.updated.push(saved)
      else result.created.push(saved)
    } catch (err) {
      result.warnings.push(
        `«${parsed.name}» no se ha importado: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  return result
}
