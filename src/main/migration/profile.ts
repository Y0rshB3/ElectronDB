import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, sep } from 'node:path'
import { LEGACY_APP_NAME } from '../brand'
import type { Logger } from '../log'

/**
 * One-time copy of the pre-rename profile (<appData>/Navidog) into the
 * ElectronDB profile. Copy, never move: the old folder stays as a backup and
 * the old app keeps working. Pure Node (no electron) so it is unit tested.
 */

/** Written into the new profile once the copy ran; its presence disables the migration. */
export const MIGRATION_MARKER = 'migrated-from-navidog.json'

/** Profile files that are caches keyed by absolute paths: rebuilt, never copied. */
const SKIPPED_FILES = new Set(['backup-index.json', MIGRATION_MARKER])
/** JSON documents whose secrets must not be touched by the path rewrite. */
const OPAQUE_FILES = new Set(['credentials.json'])
/** Folders copied (merged without overwriting) when present. */
const COPIED_DIRS = ['logs', 'Local Storage']
/**
 * Backup folder of the legacy profile: never copied (it can hold many GB of
 * .nb3 files and the copy runs before the first window). The new profile keeps
 * using it where it is, so paths into it are not rewritten.
 */
export const LEGACY_BACKUPS_DIR = 'backups'

export type SecretsMigrationState = 'none' | 'pending' | 'done'

export interface MigrationMarker {
  version: 1
  from: string
  migratedAt: string
  copied: string[]
  skippedExisting: string[]
  /** Entries that could not be copied (logged); the rest of the migration went on. */
  failed?: string[]
  /** The legacy backup folder the new profile keeps using in place, when it exists. */
  backupsDir?: string
  /** Path strings rewritten from the old profile folder to the new one. */
  rewrittenPaths: number
  /** 'pending' while credentials.json still holds values encrypted under the old name. */
  secrets: SecretsMigrationState
  /** Passes of the secret migration so far (it retries while the legacy key is unavailable). */
  secretAttempts?: number
  /** Why the legacy key could not be read on the last pass. */
  legacyKeyProblem?: string
  /** Connections whose password has to be typed again (filled by the secret migration). */
  passwordsToReenter?: string[]
  /** True once the renderer showed the re-entry notice. */
  noticeShown?: boolean
}

/** Folders where the pre-rename app kept its profile, most likely first. */
export function legacyProfileCandidates(appData: string): string[] {
  // Electron derived userData from package.json's name ("navidog") while
  // app.setName said "Navidog": on case-sensitive file systems either can exist.
  return [join(appData, LEGACY_APP_NAME), join(appData, LEGACY_APP_NAME.toLowerCase())]
}

export function findLegacyProfile(appData: string): string | null {
  return legacyProfileCandidates(appData).find((dir) => isDir(dir)) ?? null
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

export interface ProfileMigrationOptions {
  /** The legacy profile folder. */
  from: string
  /** The current profile folder (app.getPath('userData')). */
  to: string
  platform?: NodeJS.Platform
  now?: () => Date
  log?: Pick<Logger, 'info' | 'warn'>
}

export type ProfileMigrationResult =
  { status: 'skipped'; reason: string } | { status: 'migrated'; marker: MigrationMarker }

/** Entries of the legacy profile worth copying, as names relative to it. */
function migratableEntries(from: string, platform: NodeJS.Platform): string[] {
  const names: string[] = []
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json') && !SKIPPED_FILES.has(entry.name))
      names.push(entry.name)
    else if (entry.isDirectory() && COPIED_DIRS.includes(entry.name)) names.push(entry.name)
    // Windows: safeStorage's AES key lives DPAPI-protected (per user, not per
    // app name) in "Local State"; carrying it over keeps old secrets readable.
    else if (platform === 'win32' && entry.isFile() && entry.name === 'Local State')
      names.push(entry.name)
  }
  return names.sort()
}

/**
 * Rewrites every string that points into the old profile folder (backup
 * folders, log paths...) so it points into the new one, which now holds the
 * copies. Case-insensitive on macOS/Windows file systems.
 */
export function rewriteProfilePaths(
  value: unknown,
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
  /** Folders inside `from` whose paths stay as they are (they are not copied). */
  keep: string[] = []
): { value: unknown; count: number } {
  const fold = platform === 'darwin' || platform === 'win32'
  const norm = (s: string): string => (fold ? s.toLowerCase() : s)
  const trim = (s: string): string => (s.endsWith(sep) ? s.slice(0, -1) : s)
  const under = (n: string, dir: string): boolean => n === dir || n.startsWith(dir + sep)
  const prefix = norm(trim(from))
  const kept = keep.map((k) => norm(trim(k)))
  let count = 0
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const n = norm(node)
      if (under(n, prefix) && !kept.some((k) => under(n, k))) {
        count++
        return to + node.slice(prefix.length)
      }
      return node
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object')
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]))
    return node
  }
  return { value: walk(value), count }
}

export function readMigrationMarker(profileDir: string): MigrationMarker | null {
  try {
    const raw = JSON.parse(readFileSync(join(profileDir, MIGRATION_MARKER), 'utf8'))
    return raw && typeof raw === 'object' ? (raw as MigrationMarker) : null
  } catch {
    return null
  }
}

export function writeMigrationMarker(profileDir: string, marker: MigrationMarker): void {
  writeFileSync(join(profileDir, MIGRATION_MARKER), JSON.stringify(marker, null, 2), {
    mode: 0o600
  })
}

/** settings.json without backupsRootDir means the default <profile>/backups: pin the legacy one. */
function keepBackupsRoot(settings: unknown, backupsDir: string): unknown {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return settings
  if (typeof (settings as { backupsRootDir?: unknown }).backupsRootDir === 'string') return settings
  return { ...settings, backupsRootDir: backupsDir }
}

/**
 * Copies the legacy profile into `to` when `to` has no data yet. Never
 * overwrites anything that already exists in `to`, never touches `from`.
 * Synchronous: it runs before app 'ready' so Chromium picks up the copied
 * "Local Storage" (saved queries) and, on Windows, "Local State". The backup
 * folder stays in the legacy profile and settings keep pointing at it.
 */
export function migrateLegacyProfile(options: ProfileMigrationOptions): ProfileMigrationResult {
  const { from, to } = options
  const platform = options.platform ?? process.platform
  const log = options.log
  if (!isDir(from)) return { status: 'skipped', reason: 'no legacy profile' }
  if (samePath(from, to)) return { status: 'skipped', reason: 'legacy and current profile match' }
  if (existsSync(join(to, MIGRATION_MARKER)))
    return { status: 'skipped', reason: 'already migrated' }
  if (existsSync(join(to, 'connections.json')))
    return { status: 'skipped', reason: 'current profile already has connections' }

  const entries = migratableEntries(from, platform)
  if (entries.length === 0) return { status: 'skipped', reason: 'legacy profile is empty' }

  mkdirSync(to, { recursive: true })
  const copied: string[] = []
  const skippedExisting: string[] = []
  const failed: string[] = []
  const legacyBackups = join(from, LEGACY_BACKUPS_DIR)
  const backupsDir = isDir(legacyBackups) ? legacyBackups : undefined
  let rewrittenPaths = 0
  for (const name of entries) {
    const src = join(from, name)
    const dest = join(to, name)
    try {
      if (isDir(src)) {
        // Merge: files already present in the new profile win.
        cpSync(src, dest, { recursive: true, force: false, errorOnExist: false })
        copied.push(`${name}/`)
        continue
      }
      if (existsSync(dest)) {
        skippedExisting.push(name)
        continue
      }
      if (name.endsWith('.json') && !OPAQUE_FILES.has(name)) {
        const text = readFileSync(src, 'utf8')
        let out = text
        try {
          const rewritten = rewriteProfilePaths(JSON.parse(text), from, to, platform, [
            legacyBackups
          ])
          let value = rewritten.value
          if (name === 'settings.json' && backupsDir) value = keepBackupsRoot(value, backupsDir)
          if (rewritten.count > 0 || value !== rewritten.value) {
            rewrittenPaths += rewritten.count
            out = JSON.stringify(value, null, 2)
          }
        } catch {
          /* unparsable: copied verbatim, JsonStore will set it aside on load */
        }
        writeFileSync(dest, out, { mode: 0o600, flag: 'wx' })
      } else {
        cpSync(src, dest, { force: false, errorOnExist: false, preserveTimestamps: true })
      }
      copied.push(name)
    } catch (err) {
      failed.push(name)
      log?.warn(`profile migration: could not copy ${name}`, err)
    }
  }
  // Without a settings.json the default backup folder would be the new,
  // empty <profile>/backups: point it at the legacy one instead.
  if (backupsDir && !entries.includes('settings.json') && !existsSync(join(to, 'settings.json'))) {
    try {
      writeFileSync(
        join(to, 'settings.json'),
        JSON.stringify({ backupsRootDir: backupsDir }, null, 2),
        { mode: 0o600, flag: 'wx' }
      )
    } catch (err) {
      log?.warn('profile migration: could not point settings at the legacy backups', err)
    }
  }

  const marker: MigrationMarker = {
    version: 1,
    from,
    migratedAt: (options.now?.() ?? new Date()).toISOString(),
    copied,
    skippedExisting,
    ...(failed.length ? { failed } : {}),
    ...(backupsDir ? { backupsDir } : {}),
    rewrittenPaths,
    secrets: copied.includes('credentials.json') ? 'pending' : 'none'
  }
  writeMigrationMarker(to, marker)
  log?.info(
    `profile migrated from ${from}: copied ${copied.join(', ') || 'nothing'}` +
      (skippedExisting.length ? `; kept existing ${skippedExisting.join(', ')}` : '') +
      (failed.length ? `; FAILED ${failed.join(', ')}` : '') +
      (backupsDir ? `; backups stay in ${backupsDir}` : '') +
      `; ${rewrittenPaths} path(s) rewritten`
  )
  return { status: 'migrated', marker }
}
