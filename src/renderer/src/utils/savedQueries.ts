export interface SavedQuery {
  id: string
  name: string
  sql: string
  schema: string | null
  /**
   * Database the query runs in, for engines with a database level above
   * schemas (PostgreSQL, MongoDB). Absent means the connection's initial
   * database; MySQL records never have it.
   */
  database?: string
  updatedAt: string
}

const PREFIX = 'electrondb.queries.'
/**
 * Key prefix used by Navidog; read once and moved to PREFIX. PREFIX itself keeps
 * the ElectronDB-era spelling on purpose: it is an internal storage key, and
 * renaming it would hide every saved query copied from an ElectronDB profile.
 */
const LEGACY_PREFIX = 'navidog.queries.'

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** Moves a pre-rename entry to the current key (never overwriting a current one). */
function adoptLegacy(store: Storage, connectionId: string): string | null {
  const legacy = store.getItem(LEGACY_PREFIX + connectionId)
  if (legacy === null) return null
  try {
    store.setItem(PREFIX + connectionId, legacy)
    store.removeItem(LEGACY_PREFIX + connectionId)
  } catch {
    /* storage full or unavailable: still serve the old value */
  }
  return legacy
}

export function readSavedQueries(connectionId: string): SavedQuery[] {
  const store = storage()
  const raw = store
    ? (store.getItem(PREFIX + connectionId) ?? adoptLegacy(store, connectionId))
    : null
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as SavedQuery[]) : []
  } catch {
    return []
  }
}

export function writeSavedQueries(connectionId: string, queries: SavedQuery[]): void {
  storage()?.setItem(PREFIX + connectionId, JSON.stringify(queries))
}
