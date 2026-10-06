import { readdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { BackupFile, ConnectionConfig } from '@shared/types'
import type { AppContext } from '../context'
import { backupPathKey, backupRunIndex } from '../automation/backupRuns'
import { isBackupFileName, parseBackupFileName } from './naming'

/**
 * Lists .nb3 files without opening them: only `stat` and the file name are
 * used, so scanning hundreds of multi-GB backups stays instant.
 * Layout: `<dir>/<schema>/<file>.nb3` (files directly in `<dir>` are accepted with schema = null).
 */

export interface ScanTarget {
  dir: string
  source: BackupFile['source']
}

interface DirEntry {
  name: string
  path: string
  isDirectory: boolean
  isFile: boolean
}

async function listDir(dir: string): Promise<DirEntry[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const result: DirEntry[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const path = join(dir, e.name)
    if (e.isSymbolicLink()) {
      try {
        const s = await stat(path)
        result.push({ name: e.name, path, isDirectory: s.isDirectory(), isFile: s.isFile() })
      } catch {
        /* dangling link */
      }
      continue
    }
    result.push({ name: e.name, path, isDirectory: e.isDirectory(), isFile: e.isFile() })
  }
  return result
}

/**
 * Best creation date of a file without a timestamp in its name. A file cannot
 * be modified before it exists, so an mtime older than birthtime means the
 * file was copied with its times preserved (or birthtime is unsupported, 0).
 * macOS moves birthtime back with utimes, Linux does not.
 */
export function fileCreatedAt(s: {
  birthtimeMs: number
  mtimeMs: number
  birthtime: Date
  mtime: Date
}): Date {
  return s.birthtimeMs > 0 && s.birthtimeMs <= s.mtimeMs ? s.birthtime : s.mtime
}

async function describeFile(
  path: string,
  schema: string | null,
  connectionId: string,
  source: BackupFile['source']
): Promise<BackupFile | null> {
  let s
  try {
    s = await stat(path)
  } catch {
    return null
  }
  const fileName = basename(path)
  const parsed = parseBackupFileName(fileName)
  return {
    path,
    fileName,
    connectionId,
    schema,
    sizeBytes: s.size,
    createdAt: parsed.createdAt ?? fileCreatedAt(s).toISOString(),
    modifiedAt: s.mtime.toISOString(),
    source,
    label: parsed.label
  }
}

/** Scans one root directory (files directly inside it and one schema level below). */
export async function scanBackupDir(
  target: ScanTarget,
  connectionId: string,
  schema?: string | null
): Promise<BackupFile[]> {
  const files: BackupFile[] = []
  const root = resolve(target.dir)
  for (const entry of await listDir(root)) {
    if (entry.isFile && isBackupFileName(entry.name)) {
      if (schema) continue
      const f = await describeFile(entry.path, null, connectionId, target.source)
      if (f) files.push(f)
      continue
    }
    if (!entry.isDirectory) continue
    if (schema && entry.name !== schema) continue
    for (const child of await listDir(entry.path)) {
      if (!child.isFile || !isBackupFileName(child.name)) continue
      const f = await describeFile(child.path, entry.name, connectionId, target.source)
      if (f) files.push(f)
    }
  }
  return files
}

export function scanTargetsFor(connection: ConnectionConfig): ScanTarget[] {
  const targets: ScanTarget[] = []
  const seen = new Set<string>()
  const add = (dir: string, source: BackupFile['source']): void => {
    if (!dir) return
    const key = resolve(dir)
    if (seen.has(key)) return
    seen.add(key)
    targets.push({ dir: key, source })
  }
  // Navicat's folders first: when backupDir is also listed as an extra dir its files
  // are Navicat's (read-only), matching the rule backups:delete enforces.
  for (const dir of connection.extraBackupDirs ?? []) add(dir, 'navicat')
  add(connection.backupDir, 'electrondb')
  return targets
}

export async function listBackups(
  ctx: AppContext,
  connectionId: string,
  schema?: string | null
): Promise<BackupFile[]> {
  const connection = ctx.connections.get(connectionId)
  if (!connection) throw new Error('Conexión no encontrada')
  const results = await Promise.all(
    scanTargetsFor(connection).map((t) => scanBackupDir(t, connectionId, schema))
  )
  const extraDirs = (connection.extraBackupDirs ?? []).filter(Boolean).map((d) => resolve(d))
  const underExtra = (path: string): boolean =>
    extraDirs.some((dir) => {
      const rel = relative(dir, resolve(path))
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    })
  // Files written by an automation run carry it (packages in the backups list).
  const runs = backupRunIndex(ctx)
  const byPath = new Map<string, BackupFile>()
  for (const file of results.flat()) {
    if (byPath.has(file.path)) continue
    // An ElectronDB root may contain an extra dir (or vice versa): the file's location decides.
    const located: BackupFile = underExtra(file.path) ? { ...file, source: 'navicat' } : file
    byPath.set(file.path, { ...located, run: runs.get(backupPathKey(file.path)) ?? null })
  }
  // Names carry the time to the second only: the file written last wins a tie.
  return [...byPath.values()].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.modifiedAt.localeCompare(a.modifiedAt) ||
      b.fileName.localeCompare(a.fileName)
  )
}
