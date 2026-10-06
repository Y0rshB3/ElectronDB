import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Column widths chosen by dragging grid headers, per table (connection +
 * schema + table key) so they survive paging, refresh and reopening the tab.
 * Only names and pixel widths are stored (localStorage, best effort), never data.
 */
const STORAGE_KEY = 'electrondb.grid.columnWidths'
const MAX_TABLES = 200

type Widths = Record<string, Record<string, number>>

function read(): Widths {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown
    return raw && typeof raw === 'object' ? (raw as Widths) : {}
  } catch {
    return {}
  }
}

export const useColumnWidthsStore = defineStore('columnWidths', () => {
  const byKey = ref<Widths>(read())

  function get(key: string): Record<string, number> {
    return byKey.value[key] ?? {}
  }

  function set(key: string, column: string, width: number): void {
    const next = { ...byKey.value }
    delete next[key] // re-insert last: the oldest tables are dropped first
    next[key] = { ...get(key), [column]: width }
    const keys = Object.keys(next)
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TABLES))) delete next[k]
    byKey.value = next
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* private mode / quota: widths still apply for this session */
    }
  }

  return { byKey, get, set }
})
