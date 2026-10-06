import { join } from 'node:path'
import type { BackupMeta } from '@shared/types'
import { JsonStore } from '../storage/jsonStore'

/**
 * Persistent cache of parsed manifests keyed by `path|size|mtimeMs`, so a
 * backup's metadata is read from the archive once and served from disk after.
 */

export interface FileIdentity {
  size: number
  mtimeMs: number
}

interface CacheEntry {
  meta: BackupMeta
  cachedAt: string
}

interface CacheDoc {
  version: number
  entries: Record<string, CacheEntry>
}

export const INDEX_CACHE_FILE = 'backup-index.json'
const MAX_ENTRIES = 2000

export const cacheKey = (path: string, identity: FileIdentity): string =>
  `${path}|${identity.size}|${Math.floor(identity.mtimeMs)}`

const emptyDoc = (): CacheDoc => ({ version: 1, entries: {} })

export class BackupIndexCache {
  private store: JsonStore<CacheDoc> | null = null

  constructor(private readonly userDataPath: string) {}

  get filePath(): string {
    return join(this.userDataPath, INDEX_CACHE_FILE)
  }

  private doc(): JsonStore<CacheDoc> {
    if (!this.store) {
      this.store = new JsonStore<CacheDoc>(this.filePath, emptyDoc, (raw) => {
        const r = raw as Partial<CacheDoc> | null
        return r && r.version === 1 && r.entries && typeof r.entries === 'object'
          ? (r as CacheDoc)
          : emptyDoc()
      })
    }
    return this.store
  }

  get(path: string, identity: FileIdentity): BackupMeta | null {
    return this.doc().get().entries[cacheKey(path, identity)]?.meta ?? null
  }

  set(path: string, identity: FileIdentity, meta: BackupMeta): void {
    const key = cacheKey(path, identity)
    this.doc().update((d) => {
      d.entries[key] = { meta, cachedAt: new Date().toISOString() }
      const keys = Object.keys(d.entries)
      if (keys.length > MAX_ENTRIES) {
        keys
          .sort((a, b) => d.entries[a].cachedAt.localeCompare(d.entries[b].cachedAt))
          .slice(0, keys.length - MAX_ENTRIES)
          .forEach((k) => delete d.entries[k])
      }
    })
  }

  /** Drops every entry of a path (any size/mtime), e.g. after deleting the file. */
  forget(path: string): void {
    const prefix = `${path}|`
    this.doc().update((d) => {
      for (const k of Object.keys(d.entries)) if (k.startsWith(prefix)) delete d.entries[k]
    })
  }
}

const shared = new Map<string, BackupIndexCache>()

/** One cache instance per userData directory, shared by the service and the IPC handlers. */
export function getIndexCache(userDataPath: string): BackupIndexCache {
  let cache = shared.get(userDataPath)
  if (!cache) {
    cache = new BackupIndexCache(userDataPath)
    shared.set(userDataPath, cache)
  }
  return cache
}
