import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ObjectType } from '@shared/types'

export type TabKind =
  | 'objects'
  | 'tableData'
  | 'query'
  | 'tableDesigner'
  | 'ddlEditor'
  | 'backups'
  | 'automation'
  | 'users'
  | 'jobEditor'

export interface WorkspaceTab {
  id: string
  kind: TabKind
  title: string
  icon: string
  closable: boolean
  dirty: boolean
  connectionId?: string
  schema?: string
  objectName?: string
  objectType?: ObjectType
  /** Saved query id, job id, initial SQL, etc. */
  payload?: Record<string, unknown>
}

export const OBJECTS_TAB_ID = 'objects'

const ICONS: Record<TabKind, string> = {
  objects: 'mdi-view-list',
  tableData: 'mdi-table',
  query: 'mdi-database-search',
  tableDesigner: 'mdi-table-edit',
  ddlEditor: 'mdi-code-braces',
  backups: 'mdi-archive',
  automation: 'mdi-robot',
  users: 'mdi-account-multiple',
  jobEditor: 'mdi-robot-outline'
}

export interface OpenTabInput {
  kind: TabKind
  /** Optional dedupe key; a tab with the same id is activated instead of created. */
  id?: string
  title: string
  connectionId?: string
  schema?: string
  objectName?: string
  objectType?: ObjectType
  payload?: Record<string, unknown>
}

export const useTabsStore = defineStore('tabs', () => {
  const tabs = ref<WorkspaceTab[]>([
    {
      id: OBJECTS_TAB_ID,
      kind: 'objects',
      title: 'Objetos',
      icon: ICONS.objects,
      closable: false,
      dirty: false
    }
  ])
  const activeId = ref<string>(OBJECTS_TAB_ID)
  let seq = 0

  const active = computed(() => tabs.value.find((t) => t.id === activeId.value) ?? tabs.value[0])

  function activate(id: string): void {
    if (tabs.value.some((t) => t.id === id)) activeId.value = id
  }

  function open(input: OpenTabInput): WorkspaceTab {
    const id = input.id ?? `${input.kind}-${++seq}-${Date.now().toString(36)}`
    const existing = tabs.value.find((t) => t.id === id)
    if (existing) {
      activeId.value = existing.id
      return existing
    }
    const tab: WorkspaceTab = {
      id,
      kind: input.kind,
      title: input.title,
      icon: ICONS[input.kind],
      closable: true,
      dirty: false,
      connectionId: input.connectionId,
      schema: input.schema,
      objectName: input.objectName,
      objectType: input.objectType,
      payload: input.payload
    }
    tabs.value.push(tab)
    activeId.value = id
    return tab
  }

  function setDirty(id: string, dirty: boolean): void {
    const tab = tabs.value.find((t) => t.id === id)
    if (tab) tab.dirty = dirty
  }

  /** Merges `patch` into the tab payload (the view keeps its state; nothing remounts). */
  function setPayload(id: string, patch: Record<string, unknown>): void {
    const tab = tabs.value.find((t) => t.id === id)
    if (tab) tab.payload = { ...tab.payload, ...patch }
  }

  function setTitle(id: string, title: string): void {
    const tab = tabs.value.find((t) => t.id === id)
    if (tab) tab.title = title
  }

  /** Removes the tab without guards; callers must confirm unsaved changes first. */
  function close(id: string): void {
    const idx = tabs.value.findIndex((t) => t.id === id)
    if (idx < 0 || !tabs.value[idx].closable) return
    tabs.value.splice(idx, 1)
    if (activeId.value === id)
      activeId.value = tabs.value[Math.min(idx, tabs.value.length - 1)]?.id ?? OBJECTS_TAB_ID
  }

  function closeForConnection(connectionId: string): string[] {
    const ids = tabs.value
      .filter((t) => t.closable && t.connectionId === connectionId)
      .map((t) => t.id)
    ids.forEach(close)
    return ids
  }

  function closeOthers(id: string): void {
    tabs.value.filter((t) => t.closable && t.id !== id && !t.dirty).forEach((t) => close(t.id))
  }

  return {
    tabs,
    activeId,
    active,
    activate,
    open,
    setDirty,
    setPayload,
    setTitle,
    close,
    closeForConnection,
    closeOthers
  }
})

export function tabTitle(object: string, schema: string, connectionName: string): string {
  return `${object}@${schema} (${connectionName})`
}
