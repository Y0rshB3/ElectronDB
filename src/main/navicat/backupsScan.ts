import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const BACKUP_EXTENSION = '.nb3'
const MAX_DEPTH = 6

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Counts `.nb3` files below `dir` (Navicat keeps one sub-folder per schema).
 * Missing or unreadable directories count as zero; symlinks are not followed.
 */
export async function countNb3Files(dir: string, depth = 0): Promise<number> {
  if (depth > MAX_DEPTH) return 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let count = 0
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(BACKUP_EXTENSION)) count++
    else if (entry.isDirectory()) count += await countNb3Files(join(dir, entry.name), depth + 1)
  }
  return count
}

/**
 * Directory holding a connection's Navicat backups: the `savepath` stored in
 * conn.plist when it exists, otherwise `fallbackDir` (the default folder under
 * the scanned root, which covers roots copied from another machine).
 * Null when neither exists.
 */
export async function resolveBackupSourceDir(
  savePath: string | null,
  fallbackDir: string
): Promise<string | null> {
  if (savePath && (await isDirectory(savePath))) return savePath
  return (await isDirectory(fallbackDir)) ? fallbackDir : null
}
