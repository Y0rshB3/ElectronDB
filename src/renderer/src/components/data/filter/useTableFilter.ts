import { computed, ref, watch, type Ref } from 'vue'
import type { QueryColumn, TableFilter, TableFilterProfile } from '@shared/types'
import { useTabsStore, type WorkspaceTab } from '@renderer/stores/tabs'
import {
  activeConditions,
  cloneFilterState,
  emptyFilterState,
  filterProblem,
  fromTableFilter,
  insertCondition,
  insertGroup,
  locate,
  newGroup,
  removeNode,
  restoreFilterState,
  toTableFilter,
  unwrapGroup,
  wrapInGroup,
  type FilterConditionPatch,
  type FilterPanelState
} from './filterModel'

/** What the data request carries: the raw WHERE (text mode) or the structured filter. */
export interface AppliedFilter {
  where: string | null
  filter: TableFilter | null
}

export const NO_FILTER: AppliedFilter = { where: null, filter: null }

/** Edits of the builder tree, emitted by the panel lines and its context menu. */
export type FilterAction =
  | { type: 'select'; id: string | null }
  | { type: 'patch'; id: string; patch: FilterConditionPatch }
  | { type: 'toggle-enabled'; id: string }
  | { type: 'toggle-connector'; id: string }
  | { type: 'insert'; target: string | null }
  | { type: 'insert-group'; target: string | null }
  | { type: 'wrap'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'unwrap'; id: string }
  | { type: 'clear-all' }

export interface FilterProfilesApi {
  list: () => Promise<TableFilterProfile[]>
  save: (name: string, filter: TableFilter) => Promise<TableFilterProfile[]>
  remove: (name: string) => Promise<TableFilterProfile[]>
}

export interface TableFilterOptions {
  columns: Readonly<Ref<QueryColumn[]>>
  /** WHERE text main would run for the builder (IPC db:tableFilterSql). */
  generateWhere: (filter: TableFilter) => Promise<string>
  /** Asks the user; resolves true to continue. */
  confirm: (message: string, confirmText: string) => Promise<boolean>
  profiles: FilterProfilesApi
}

/**
 * State and actions of the filter panel of one table data tab. The tree, the
 * applied filter and the panel visibility are kept in the tab payload, so they
 * survive while the tab is open (the view may remount) and go away with it.
 */
export function useTableFilter(tab: WorkspaceTab, options: TableFilterOptions) {
  const tabs = useTabsStore()
  const payload = tab.payload ?? {}

  const state = ref<FilterPanelState>(restoreFilterState(payload.filter))
  const applied = ref<AppliedFilter>(restoreApplied(payload.appliedFilter))
  const open = ref<boolean>(payload.filterOpen === true)
  /** Set after a refused "Aplicar": incomplete conditions are then highlighted. */
  const showProblems = ref(false)
  const switching = ref(false)
  const profiles = ref<TableFilterProfile[]>([])

  watch(
    state,
    (value) => {
      tabs.setPayload(tab.id, { filter: cloneFilterState(value) })
      if (showProblems.value && !filterProblem(value.root)) showProblems.value = false
    },
    { deep: true }
  )
  watch(applied, (value) => tabs.setPayload(tab.id, { appliedFilter: { ...value } }))
  watch(open, (value) => tabs.setPayload(tab.id, { filterOpen: value }))

  const isApplied = computed(() => !!(applied.value.where || applied.value.filter))
  /** Conditions of the applied filter (badge of the "Filtro" button); 1 for a raw WHERE. */
  const appliedCount = computed(() => {
    if (applied.value.where) return 1
    return applied.value.filter ? activeConditions(fromTableFilter(applied.value.filter)).length : 0
  })
  const activeCount = computed(() => activeConditions(state.value.root).length)
  const problem = computed(() =>
    state.value.mode === 'builder' ? filterProblem(state.value.root) : null
  )

  /** True when the panel differs from what the grid shows. */
  const pendingApply = computed(() => {
    const next = state.value.mode === 'text' ? fromText() : fromBuilder()
    return JSON.stringify(next) !== JSON.stringify(applied.value)
  })

  function firstColumn(): string {
    return options.columns.value[0]?.name ?? ''
  }

  function dispatch(action: FilterAction): void {
    const root = state.value.root
    switch (action.type) {
      case 'select':
        state.value.selectedId = action.id
        return
      case 'patch': {
        const found = locate(root, action.id)
        if (found?.node.kind === 'condition') Object.assign(found.node, action.patch)
        return
      }
      case 'toggle-enabled': {
        const found = locate(root, action.id)
        if (found) found.node.enabled = !found.node.enabled
        return
      }
      case 'toggle-connector': {
        const found = locate(root, action.id)
        if (found) found.node.connector = found.node.connector === 'AND' ? 'OR' : 'AND'
        return
      }
      case 'insert':
        state.value.selectedId = insertCondition(root, action.target, firstColumn()).id
        return
      case 'insert-group':
        state.value.selectedId = insertGroup(root, action.target, firstColumn()).id
        return
      case 'wrap': {
        const group = wrapInGroup(root, action.id)
        if (group) state.value.selectedId = group.id
        return
      }
      case 'remove':
        removeNode(root, action.id)
        if (state.value.selectedId && !locate(root, state.value.selectedId))
          state.value.selectedId = null
        return
      case 'unwrap':
        unwrapGroup(root, action.id)
        if (state.value.selectedId === action.id) state.value.selectedId = null
        return
      case 'clear-all':
        state.value.root = newGroup()
        state.value.selectedId = null
        showProblems.value = false
        return
    }
  }

  function setText(text: string): void {
    state.value.text = text
  }

  function fromBuilder(): AppliedFilter {
    return activeConditions(state.value.root).length > 0
      ? { where: null, filter: toTableFilter(state.value.root) }
      : NO_FILTER
  }

  function fromText(): AppliedFilter {
    const where = state.value.text.trim()
    return where ? { where, filter: null } : NO_FILTER
  }

  /**
   * The filter "Aplicar filtro" would load, or null when a condition is
   * incomplete (it is then highlighted and selected). Does not change `applied`.
   */
  function prepareApply(): AppliedFilter | null {
    if (state.value.mode === 'text') return fromText()
    const issue = filterProblem(state.value.root)
    if (issue) {
      showProblems.value = true
      state.value.selectedId = issue.id
      return null
    }
    showProblems.value = false
    return fromBuilder()
  }

  /** Toolbar "Limpiar": empties the panel (both modes); the caller reloads unfiltered. */
  function reset(): void {
    const { mode, profile } = state.value
    state.value = { ...emptyFilterState(), mode, profile }
    showProblems.value = false
  }

  /**
   * Builder -> text: main renders the WHERE it would run (identifiers checked,
   * values escaped) so the user can tweak it; from then on it is the user's SQL.
   */
  async function switchToText(): Promise<boolean> {
    if (state.value.mode === 'text' || switching.value) return false
    switching.value = true
    try {
      const generated =
        activeConditions(state.value.root).length > 0 && !filterProblem(state.value.root)
          ? await options.generateWhere(toTableFilter(state.value.root))
          : ''
      state.value.text = generated || state.value.text
      state.value.generatedText = generated || null
      state.value.mode = 'text'
      return true
    } finally {
      switching.value = false
    }
  }

  /** Text -> builder: edited SQL cannot become conditions again, so ask before dropping it. */
  async function switchToBuilder(): Promise<boolean> {
    if (state.value.mode === 'builder') return false
    const text = state.value.text.trim()
    const edited = text !== '' && text !== (state.value.generatedText ?? '').trim()
    if (
      edited &&
      !(await options.confirm(
        'El texto WHERE editado no se puede convertir en condiciones. Se volverá a las condiciones del filtro y se descartará el texto.',
        'Volver a las condiciones'
      ))
    )
      return false
    state.value.mode = 'builder'
    state.value.text = ''
    state.value.generatedText = null
    return true
  }

  /* ---------- profiles (saved through main, per connection + schema + table) ---------- */

  async function refreshProfiles(): Promise<void> {
    try {
      profiles.value = await options.profiles.list()
    } catch {
      profiles.value = []
    }
  }

  function loadProfile(name: string): boolean {
    const profile = profiles.value.find((p) => p.name === name)
    if (!profile) return false
    state.value = {
      ...emptyFilterState(),
      root: fromTableFilter(profile.filter),
      profile: profile.name
    }
    showProblems.value = false
    return true
  }

  async function saveProfile(name: string): Promise<void> {
    profiles.value = await options.profiles.save(name.trim(), toTableFilter(state.value.root))
    state.value.profile = name.trim()
  }

  async function deleteProfile(name: string): Promise<boolean> {
    if (!(await options.confirm(`Se eliminará el perfil de filtro «${name}».`, 'Eliminar perfil')))
      return false
    profiles.value = await options.profiles.remove(name)
    if (state.value.profile === name) state.value.profile = null
    return true
  }

  return {
    state,
    applied,
    open,
    showProblems,
    switching,
    profiles,
    isApplied,
    appliedCount,
    activeCount,
    problem,
    pendingApply,
    dispatch,
    setText,
    prepareApply,
    reset,
    switchToText,
    switchToBuilder,
    refreshProfiles,
    loadProfile,
    saveProfile,
    deleteProfile
  }
}

export type TableFilterController = ReturnType<typeof useTableFilter>

function restoreApplied(value: unknown): AppliedFilter {
  const v = value as Partial<AppliedFilter> | null | undefined
  if (!v || typeof v !== 'object') return NO_FILTER
  return {
    where: typeof v.where === 'string' && v.where.trim() ? v.where : null,
    filter: v.filter && typeof v.filter === 'object' ? v.filter : null
  }
}
