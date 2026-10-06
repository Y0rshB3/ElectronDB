import { defineStore } from 'pinia'
import { ref } from 'vue'
import { readSavedQueries, writeSavedQueries, type SavedQuery } from '@renderer/utils/savedQueries'

/** Saved SQL queries kept in localStorage, keyed per connection. */
export const useQueriesStore = defineStore('queries', () => {
  const byConnection = ref<Record<string, SavedQuery[]>>({})

  function list(connectionId: string): SavedQuery[] {
    if (!byConnection.value[connectionId])
      byConnection.value[connectionId] = readSavedQueries(connectionId)
    return byConnection.value[connectionId]
  }

  function persist(connectionId: string, queries: SavedQuery[]): void {
    byConnection.value = { ...byConnection.value, [connectionId]: queries }
    writeSavedQueries(connectionId, queries)
  }

  function save(
    connectionId: string,
    query: Omit<SavedQuery, 'updatedAt' | 'id'> & { id?: string }
  ): SavedQuery {
    const existing = list(connectionId)
    const saved: SavedQuery = {
      id: query.id ?? `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: query.name,
      sql: query.sql,
      schema: query.schema,
      updatedAt: new Date().toISOString()
    }
    const idx = existing.findIndex((q) => q.id === saved.id || q.name === saved.name)
    const next = [...existing]
    if (idx >= 0) next.splice(idx, 1, { ...saved, id: existing[idx].id })
    else next.push(saved)
    persist(connectionId, next)
    return idx >= 0 ? next[idx] : saved
  }

  function remove(connectionId: string, id: string): void {
    persist(
      connectionId,
      list(connectionId).filter((q) => q.id !== id)
    )
  }

  function get(connectionId: string, id: string): SavedQuery | undefined {
    return list(connectionId).find((q) => q.id === id)
  }

  return { byConnection, list, save, remove, get }
})
