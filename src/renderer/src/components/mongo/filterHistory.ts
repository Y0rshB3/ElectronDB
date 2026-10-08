/**
 * Recent filter / sort / projection texts of a collection (docs/multi-engine-design.md,
 * 9.1): per viewer, local only (localStorage `electrondb.mongoHistory.<conn>.<db>.<coll>`,
 * keeping the stable `electrondb.` prefix of the other renderer keys).
 */
export type HistoryField = 'filter' | 'sort' | 'projection'

const MAX = 15

type History = Record<HistoryField, string[]>

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function keyOf(connectionId: string, database: string, collection: string): string {
  return `electrondb.mongoHistory.${connectionId}.${encodeURIComponent(database)}.${encodeURIComponent(collection)}`
}

export function readHistory(connectionId: string, database: string, collection: string): History {
  const empty: History = { filter: [], sort: [], projection: [] }
  const raw = storage()?.getItem(keyOf(connectionId, database, collection))
  if (!raw) return empty
  try {
    const parsed = JSON.parse(raw) as Partial<History>
    return {
      filter: Array.isArray(parsed.filter) ? parsed.filter.slice(0, MAX) : [],
      sort: Array.isArray(parsed.sort) ? parsed.sort.slice(0, MAX) : [],
      projection: Array.isArray(parsed.projection) ? parsed.projection.slice(0, MAX) : []
    }
  } catch {
    return empty
  }
}

/** Puts the used texts first (empty and `{}` are not remembered). */
export function rememberHistory(
  connectionId: string,
  database: string,
  collection: string,
  used: Partial<Record<HistoryField, string>>
): History {
  const history = readHistory(connectionId, database, collection)
  for (const field of Object.keys(used) as HistoryField[]) {
    const text = used[field]?.trim()
    if (!text || text === '{}') continue
    history[field] = [text, ...history[field].filter((t) => t !== text)].slice(0, MAX)
  }
  try {
    storage()?.setItem(keyOf(connectionId, database, collection), JSON.stringify(history))
  } catch {
    // Storage full or disabled: the history is a convenience.
  }
  return history
}
