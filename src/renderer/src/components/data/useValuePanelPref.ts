import { ref, watch, type Ref } from 'vue'

/**
 * Per-user preferences of the "Texto" value panel (open/closed, height, word
 * wrap), shared by every grid. Browser storage is best effort only.
 */
const KEY = 'electrondb.grid.valuePanel'

/** Grid hosts with their own remembered splitter position. */
export type ValuePanelView = 'table' | 'query'

interface Pref {
  open: boolean
  /** Panel share of its host area (0..1) per view; the grid keeps the rest. */
  ratio: Record<ValuePanelView, number>
  wrap: boolean
}

export const DEFAULT_RATIO = 0.35
export const MAX_RATIO = 0.6
export const MIN_PANEL_PX = 120

const DEFAULTS = (): Pref => ({
  open: false,
  ratio: { table: DEFAULT_RATIO, query: DEFAULT_RATIO },
  wrap: true
})

function read(): Pref {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Pref> | null
    const base = DEFAULTS()
    if (!raw || typeof raw !== 'object') return base
    const ratio = { ...base.ratio }
    for (const view of ['table', 'query'] as const) {
      const r = Number(raw.ratio?.[view])
      if (Number.isFinite(r) && r > 0) ratio[view] = Math.min(MAX_RATIO, r)
    }
    return { open: raw.open === true, wrap: raw.wrap !== false, ratio }
  } catch {
    return DEFAULTS()
  }
}

let shared: Ref<Pref> | null = null

export function useValuePanelPref(): Ref<Pref> {
  if (shared) return shared
  const pref = ref<Pref>(read())
  watch(
    pref,
    (value) => {
      try {
        localStorage.setItem(KEY, JSON.stringify(value))
      } catch {
        /* private mode: keep it for this session */
      }
    },
    { deep: true }
  )
  shared = pref
  return pref
}

/** Test hook: forget the shared state (each test starts from storage). */
export function resetValuePanelPref(): void {
  shared = null
}
