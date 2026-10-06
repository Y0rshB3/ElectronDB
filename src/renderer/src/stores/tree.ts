import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  BackupFile,
  DatabaseInfo,
  EventInfo,
  RoutineInfo,
  TableInfo,
  ViewInfo
} from '@shared/types'
import { api } from '@renderer/api'
import { errorMessage } from '@renderer/composables/useNotify'
import { GROUPS, type GroupKind } from '@renderer/utils/objectTypes'
import type { SavedQuery } from '@renderer/utils/savedQueries'
import { useConnectionsStore } from './connections'
import { useQueriesStore } from './queries'

export type TreeNodeKind = 'connection' | 'schema' | 'group' | 'object'

export interface TreeNode {
  id: string
  kind: TreeNodeKind
  label: string
  connectionId: string
  schema?: string
  group?: GroupKind
  /** Object name for object nodes (or saved query id / backup path). */
  name?: string
  /** Sub type for routines (FUNCTION / PROCEDURE). */
  subtype?: string
  parentId: string | null
}

export interface GroupItems {
  tables: TableInfo[]
  views: ViewInfo[]
  functions: RoutineInfo[]
  events: EventInfo[]
  queries: SavedQuery[]
  backups: BackupFile[]
}

export const nodeIds = {
  connection: (c: string) => `c:${c}`,
  schema: (c: string, s: string) => `s:${c}:${s}`,
  group: (c: string, s: string, g: GroupKind) => `g:${c}:${s}:${g}`,
  object: (c: string, s: string, g: GroupKind, name: string) => `o:${c}:${s}:${g}:${name}`
}

export const groupKey = (c: string, s: string, g: GroupKind): string => `${c}:${s}:${g}`

export const useTreeStore = defineStore('tree', () => {
  const expanded = ref<Record<string, boolean>>({})
  const loading = ref<Record<string, boolean>>({})
  const errors = ref<Record<string, string>>({})
  const selectedId = ref<string | null>(null)
  const filter = ref('')
  const databases = ref<Record<string, DatabaseInfo[]>>({})
  const groupItems = ref<Record<string, unknown[]>>({})

  const connections = useConnectionsStore()
  const queries = useQueriesStore()

  function parse(id: string): TreeNode | null {
    const [kind, ...rest] = id.split(':')
    if (kind === 'c')
      return {
        id,
        kind: 'connection',
        label: connections.nameOf(rest[0]),
        connectionId: rest[0],
        parentId: null
      }
    if (kind === 's')
      return {
        id,
        kind: 'schema',
        label: rest[1],
        connectionId: rest[0],
        schema: rest[1],
        parentId: nodeIds.connection(rest[0])
      }
    if (kind === 'g') {
      const group = rest[2] as GroupKind
      return {
        id,
        kind: 'group',
        label: group,
        connectionId: rest[0],
        schema: rest[1],
        group,
        parentId: nodeIds.schema(rest[0], rest[1])
      }
    }
    if (kind === 'o') {
      const group = rest[2] as GroupKind
      const name = rest.slice(3).join(':')
      return {
        id,
        kind: 'object',
        label: name,
        connectionId: rest[0],
        schema: rest[1],
        group,
        name,
        parentId: nodeIds.group(rest[0], rest[1], group)
      }
    }
    return null
  }

  const selected = computed(() => (selectedId.value ? parse(selectedId.value) : null))

  function isExpanded(id: string): boolean {
    return !!expanded.value[id]
  }
  function setExpanded(id: string, value: boolean): void {
    expanded.value = { ...expanded.value, [id]: value }
  }
  function select(id: string | null): void {
    selectedId.value = id
  }

  function itemsOf<G extends GroupKind>(
    connectionId: string,
    schema: string,
    group: G
  ): GroupItems[G] {
    if (group === 'queries') return queries.list(connectionId) as GroupItems[G]
    return (groupItems.value[groupKey(connectionId, schema, group)] ?? []) as GroupItems[G]
  }

  function hasItems(connectionId: string, schema: string, group: GroupKind): boolean {
    return group === 'queries' || groupKey(connectionId, schema, group) in groupItems.value
  }

  async function withLoading<T>(id: string, fn: () => Promise<T>): Promise<T | undefined> {
    loading.value = { ...loading.value, [id]: true }
    const nextErrors = { ...errors.value }
    delete nextErrors[id]
    errors.value = nextErrors
    try {
      return await fn()
    } catch (err) {
      errors.value = { ...errors.value, [id]: errorMessage(err) }
      return undefined
    } finally {
      const next = { ...loading.value }
      delete next[id]
      loading.value = next
    }
  }

  async function loadDatabases(connectionId: string, force = false): Promise<DatabaseInfo[]> {
    if (!force && databases.value[connectionId]) return databases.value[connectionId]
    const id = nodeIds.connection(connectionId)
    const result = await withLoading(id, async () => {
      const list = await api.db.databases(connectionId)
      const custom = connections.get(connectionId)?.customDatabases ?? []
      const filtered = custom.length ? list.filter((d) => custom.includes(d.name)) : list
      databases.value = { ...databases.value, [connectionId]: filtered }
      return filtered
    })
    return result ?? []
  }

  async function loadGroup(
    connectionId: string,
    schema: string,
    group: GroupKind,
    force = false
  ): Promise<unknown[]> {
    const key = groupKey(connectionId, schema, group)
    if (group === 'queries') return queries.list(connectionId)
    if (!force && groupItems.value[key]) return groupItems.value[key]
    const id = nodeIds.group(connectionId, schema, group)
    const result = await withLoading(id, async () => {
      let items: unknown[]
      switch (group) {
        case 'tables':
          items = await api.db.tables(connectionId, schema)
          break
        case 'views':
          items = await api.db.views(connectionId, schema)
          break
        case 'functions':
          items = await api.db.routines(connectionId, schema)
          break
        case 'events':
          items = await api.db.events(connectionId, schema)
          break
        case 'backups':
          items = await api.backups.list(connectionId, schema)
          break
      }
      groupItems.value = { ...groupItems.value, [key]: items }
      return items
    })
    return result ?? []
  }

  /** Children ids for a node; lazily triggers loading. */
  function childrenOf(node: TreeNode): TreeNode[] {
    const c = node.connectionId
    if (node.kind === 'connection') {
      if (!connections.isOpen(c)) return []
      return (databases.value[c] ?? []).map((d) => parse(nodeIds.schema(c, d.name))!)
    }
    if (node.kind === 'schema') return GROUPS.map((g) => parse(nodeIds.group(c, node.schema!, g))!)
    if (node.kind === 'group') {
      const s = node.schema!
      const g = node.group!
      const items = itemsOf(c, s, g)
      return items.map((item) => {
        const raw = item as {
          name?: string
          fileName?: string
          path?: string
          id?: string
          type?: string
        }
        const name = g === 'queries' ? raw.id! : g === 'backups' ? raw.path! : raw.name!
        const label =
          g === 'queries' ? (item as SavedQuery).name : g === 'backups' ? raw.fileName! : raw.name!
        const n = parse(nodeIds.object(c, s, g, name))!
        n.label = label
        n.subtype = raw.type
        return n
      })
    }
    return []
  }

  async function expand(node: TreeNode): Promise<void> {
    setExpanded(node.id, true)
    if (node.kind === 'connection') {
      if (!connections.isOpen(node.connectionId)) {
        try {
          await connections.open(node.connectionId)
        } catch {
          setExpanded(node.id, false)
          return
        }
      }
      await loadDatabases(node.connectionId)
    } else if (node.kind === 'group') {
      await loadGroup(node.connectionId, node.schema!, node.group!)
    }
  }

  function collapse(id: string): void {
    setExpanded(id, false)
  }

  async function toggle(node: TreeNode): Promise<void> {
    if (isExpanded(node.id)) collapse(node.id)
    else await expand(node)
  }

  async function refresh(node: TreeNode): Promise<void> {
    if (node.kind === 'connection') await loadDatabases(node.connectionId, true)
    else if (node.kind === 'schema') {
      const prefix = `${node.connectionId}:${node.schema}:`
      const next = { ...groupItems.value }
      for (const key of Object.keys(next)) if (key.startsWith(prefix)) delete next[key]
      groupItems.value = next
      for (const g of GROUPS)
        if (isExpanded(nodeIds.group(node.connectionId, node.schema!, g)))
          await loadGroup(node.connectionId, node.schema!, g, true)
    } else if (node.kind === 'group')
      await loadGroup(node.connectionId, node.schema!, node.group!, true)
    else if (node.kind === 'object')
      await loadGroup(node.connectionId, node.schema!, node.group!, true)
  }

  /** Drop cached data for a connection (e.g. when it is closed). */
  function forget(connectionId: string): void {
    const nextDb = { ...databases.value }
    delete nextDb[connectionId]
    databases.value = nextDb
    const nextItems = { ...groupItems.value }
    for (const key of Object.keys(nextItems))
      if (key.startsWith(`${connectionId}:`)) delete nextItems[key]
    groupItems.value = nextItems
    const nextExpanded = { ...expanded.value }
    for (const key of Object.keys(nextExpanded))
      if (key.includes(`:${connectionId}`)) delete nextExpanded[key]
    expanded.value = nextExpanded
    if (
      selectedId.value &&
      selectedId.value !== nodeIds.connection(connectionId) &&
      selectedId.value.includes(`:${connectionId}:`)
    ) {
      selectedId.value = nodeIds.connection(connectionId)
    }
  }

  function matchesFilter(node: TreeNode): boolean {
    const f = filter.value.trim().toLowerCase()
    return !f || node.label.toLowerCase().includes(f)
  }

  return {
    expanded,
    loading,
    errors,
    selectedId,
    selected,
    filter,
    databases,
    groupItems,
    parse,
    isExpanded,
    setExpanded,
    select,
    itemsOf,
    hasItems,
    loadDatabases,
    loadGroup,
    childrenOf,
    expand,
    collapse,
    toggle,
    refresh,
    forget,
    matchesFilter
  }
})
