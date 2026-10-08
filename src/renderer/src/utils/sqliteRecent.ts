/**
 * Recent SQLite files of «Nueva conexión SQLite» (paths only, newest first).
 * A per-viewer convenience kept in localStorage (`electrondb.*` keys, see
 * CLAUDE.md): a missing or blocked storage just gives an empty list. A path
 * is only offered; opening it never creates a file (the main process checks).
 */
const KEY = 'electrondb.sqlite.recentFiles'
export const MAX_RECENT_SQLITE_FILES = 8

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function recentSqliteFiles(): string[] {
  try {
    const raw = storage()?.getItem(KEY)
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list)
      ? list.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
      : []
  } catch {
    return []
  }
}

/** Puts `path` first (once) and keeps the newest MAX_RECENT_SQLITE_FILES. */
export function rememberSqliteFile(path: string): void {
  const p = path.trim()
  if (!p) return
  const list = [p, ...recentSqliteFiles().filter((x) => x !== p)].slice(
    0,
    MAX_RECENT_SQLITE_FILES
  )
  try {
    storage()?.setItem(KEY, JSON.stringify(list))
  } catch {
    /* storage full or blocked: the list is only a convenience */
  }
}

export function forgetSqliteFile(path: string): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(recentSqliteFiles().filter((x) => x !== path)))
  } catch {
    /* see rememberSqliteFile */
  }
}
