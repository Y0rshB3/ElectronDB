import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  BackupFile,
  DatabaseInfo,
  EventInfo,
  MongoCollectionInfo,
  ObjectSummary,
  RoutineInfo,
  SchemaInfo,
  TableInfo,
  TablePartition,
  ViewInfo
} from '@shared/types'
import { api } from '@renderer/api'
import { errorMessage } from '@renderer/composables/useNotify'
import { descriptorOf, groupsFor } from '@renderer/engines/capabilities'
import { itemLabel, itemName } from '@renderer/utils/objectColumns'
import { schemaRef } from '@renderer/utils/schemaRef'
import { ALL_GROUPS, type GroupKind } from '@renderer/utils/objectTypes'
import type { SavedQuery } from '@renderer/utils/savedQueries'
import { useConnectionsStore } from './connections'
import { useQueriesStore } from './queries'

export type TreeNodeKind = 'connection' | 'database' | 'schema' | 'group' | 'object'

export interface TreeNode {
  id: string
  kind: TreeNodeKind
  label: string
  connectionId: string
  /**
   * PostgreSQL: database that holds `schema` (and the name of a 'database'
   * node). Absent for MySQL, where `schema` is the database.
   */
  database?: string
  schema?: string
  group?: GroupKind
  /** Object name for object nodes (or saved query id / backup path). */
  name?: string
  /** Sub type for routines (FUNCTION / PROCEDURE). */
  subtype?: string
  /** PostgreSQL partitioned table (or partition): its partitions, shown nested under it. */
  partitions?: TablePartition[]
  /** Tooltip text (a partition's bound). */
  detail?: string
  parentId: string | null
}

export interface GroupItems {
  tables: TableInfo[]
  views: ViewInfo[]
  functions: RoutineInfo[]
  events: EventInfo[]
  queries: SavedQuery[]
  backups: BackupFile[]
  materializedViews: ObjectSummary[]
  sequences: ObjectSummary[]
  types: ObjectSummary[]
  indexes: ObjectSummary[]
  triggers: ObjectSummary[]
  collections: MongoCollectionInfo[]
}

/*
 * Node ids are ':'-joined segments, each one percent-encoded, so a database
 * or object name that contains ':' (or '%') round-trips through parse().
 * Names made only of letters, digits and -_.!~*'() keep the same id as before.
 *
 * PostgreSQL adds a database level: `d:<conn>:<db>`, and its schema, group and
 * object ids carry the database as one trailing segment (MySQL ids unchanged).
 */
const seg = encodeURIComponent
const dbTail = (db?: string): string => (db === undefined ? '' : `:${seg(db)}`)

export const nodeIds = {
  connection: (c: string) => `c:${seg(c)}`,
  database: (c: string, db: string) => `d:${seg(c)}:${seg(db)}`,
  schema: (c: string, s: string, db?: string) => `s:${seg(c)}:${seg(s)}${dbTail(db)}`,
  group: (c: string, s: string, g: GroupKind, db?: string) =>
    `g:${seg(c)}:${seg(s)}:${g}${dbTail(db)}`,
  object: (c: string, s: string, g: GroupKind, name: string, db?: string) =>
    `o:${seg(c)}:${seg(s)}:${g}:${seg(name)}${dbTail(db)}`
}

/** Cache key of a group's items (same escaping as node ids). */
export const groupKey = (c: string, s: string, g: GroupKind, db?: string): string =>
  `${seg(c)}:${seg(s)}:${g}${dbTail(db)}`

/** Prefix shared by the group keys of one connection, or of one of its databases. */
const groupKeyPrefix = (c: string, s?: string): string =>
  s === undefined ? `${seg(c)}:` : `${seg(c)}:${seg(s)}:`

/** Cache key of the schemas of one PostgreSQL database. */
const schemasKey = (c: string, db: string): string => `${seg(c)}:${seg(db)}`

/** Splits an id into its decoded segments; null when a segment is not valid encoding. */
function splitId(id: string): string[] | null {
  try {
    return id.split(':').map((part) => decodeURIComponent(part))
  } catch {
    return null
  }
}

export const useTreeStore = defineStore('tree', () => {
  const expanded = ref<Record<string, boolean>>({})
  const loading = ref<Record<string, boolean>>({})
  const errors = ref<Record<string, string>>({})
  const selectedId = ref<string | null>(null)
  const filter = ref('')
  const databases = ref<Record<string, DatabaseInfo[]>>({})
  /** PostgreSQL: schemas per (connection, database). */
  const schemas = ref<Record<string, SchemaInfo[]>>({})
  const groupItems = ref<Record<string, unknown[]>>({})

  const connections = useConnectionsStore()
  const queries = useQueriesStore()

  function parse(id: string): TreeNode | null {
    const parts = splitId(id)
    if (!parts) return null
    const [kind, ...rest] = parts
    if (kind === 'c' && rest.length === 1)
      return {
        id,
        kind: 'connection',
        label: connections.nameOf(rest[0]),
        connectionId: rest[0],
        parentId: null
      }
    if (kind === 'd' && rest.length === 2)
      return {
        id,
        kind: 'database',
        label: rest[1],
        connectionId: rest[0],
        database: rest[1],
        parentId: nodeIds.connection(rest[0])
      }
    // PostgreSQL ids carry one extra trailing segment: the database.
    const db = (n: number): string | undefined => (rest.length === n + 1 ? rest[n] : undefined)
    const withDb = (database: string | undefined) => (database === undefined ? {} : { database })
    if (kind === 's' && (rest.length === 2 || rest.length === 3)) {
      const database = db(2)
      return {
        id,
        kind: 'schema',
        label: rest[1],
        connectionId: rest[0],
        ...withDb(database),
        schema: rest[1],
        parentId:
          database === undefined ? nodeIds.connection(rest[0]) : nodeIds.database(rest[0], database)
      }
    }
    const knownGroup = (g: string): boolean => (ALL_GROUPS as string[]).includes(g)
    if (kind === 'g' && (rest.length === 3 || rest.length === 4) && knownGroup(rest[2])) {
      const group = rest[2] as GroupKind
      const database = db(3)
      return {
        id,
        kind: 'group',
        label: group,
        connectionId: rest[0],
        ...withDb(database),
        schema: rest[1],
        group,
        parentId: nodeIds.schema(rest[0], rest[1], database)
      }
    }
    if (kind === 'o' && (rest.length === 4 || rest.length === 5) && knownGroup(rest[2])) {
      const group = rest[2] as GroupKind
      const name = rest[3]
      const database = db(4)
      return {
        id,
        kind: 'object',
        label: name,
        connectionId: rest[0],
        ...withDb(database),
        schema: rest[1],
        group,
        name,
        parentId: nodeIds.group(rest[0], rest[1], group, database)
      }
    }
    return null
  }

  const selected = computed(() => (selectedId.value ? parse(selectedId.value) : null))

  /** Groups under a database of this connection (engine-driven; GROUPS for MySQL). */
  function groupsOf(connectionId: string): GroupKind[] {
    return groupsFor(connections.get(connectionId))
  }

  function isExpanded(id: string): boolean {
    return !!expanded.value[id]
  }
  function setExpanded(id: string, value: boolean): void {
    expanded.value = { ...expanded.value, [id]: value }
  }
  function select(id: string | null): void {
    selectedId.value = id
  }

  /** True when the connection has a database level above schemas (PostgreSQL). */
  function hasDatabaseLevel(connectionId: string): boolean {
    return descriptorOf(connections.get(connectionId))?.capabilities.hasSchemas === true
  }

  /**
   * Saved queries of a connection; on PostgreSQL only those of `database`
   * (a query saved without one belongs to the initial database).
   */
  function savedQueriesOf(connectionId: string, database?: string): SavedQuery[] {
    const all = queries.list(connectionId)
    if (database === undefined) return all
    const initial = connections.get(connectionId)?.postgres?.initialDatabase
    return all.filter((q) => {
      const own = (q as SavedQuery & { database?: string }).database
      return own === database || (!own && database === initial)
    })
  }

  function itemsOf<G extends GroupKind>(
    connectionId: string,
    schema: string,
    group: G,
    database?: string
  ): GroupItems[G] {
    if (group === 'queries') return savedQueriesOf(connectionId, database) as GroupItems[G]
    return (groupItems.value[groupKey(connectionId, schema, group, database)] ??
      []) as GroupItems[G]
  }

  function hasItems(
    connectionId: string,
    schema: string,
    group: GroupKind,
    database?: string
  ): boolean {
    return (
      group === 'queries' || groupKey(connectionId, schema, group, database) in groupItems.value
    )
  }

  function schemasOf(connectionId: string, database: string): SchemaInfo[] {
    return schemas.value[schemasKey(connectionId, database)] ?? []
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

  /** PostgreSQL: schemas of one database (opening the database's pool in main). */
  async function loadSchemas(
    connectionId: string,
    database: string,
    force = false
  ): Promise<SchemaInfo[]> {
    const key = schemasKey(connectionId, database)
    if (!force && schemas.value[key]) return schemas.value[key]
    const result = await withLoading(nodeIds.database(connectionId, database), async () => {
      const list = await api.db.schemas(connectionId, database)
      schemas.value = { ...schemas.value, [key]: list }
      return list
    })
    return result ?? []
  }

  async function loadGroup(
    connectionId: string,
    schema: string,
    group: GroupKind,
    force = false,
    database?: string
  ): Promise<unknown[]> {
    const key = groupKey(connectionId, schema, group, database)
    if (group === 'queries') return savedQueriesOf(connectionId, database)
    if (!force && groupItems.value[key]) return groupItems.value[key]
    const id = nodeIds.group(connectionId, schema, group, database)
    const ref = schemaRef(schema, database)
    const isMongo = connections.get(connectionId)?.engine === 'mongodb'
    const result = await withLoading(id, async () => {
      let items: unknown[] = []
      if (isMongo && (group === 'collections' || group === 'views')) {
        // One listCollections serves both groups; views are listed apart (read-only).
        const all = await api.mongo.collections(connectionId, schema)
        items = all.filter((c) => (group === 'views') === (c.type === 'view'))
        groupItems.value = { ...groupItems.value, [key]: items }
        return items
      }
      switch (group) {
        case 'tables':
          items = await api.db.tables(connectionId, ref)
          break
        case 'views':
          items = await api.db.views(connectionId, ref)
          break
        case 'functions':
          items = await api.db.routines(connectionId, ref)
          break
        case 'events':
          items = await api.db.events(connectionId, ref)
          break
        case 'backups':
          items = await api.backups.list(connectionId, schema)
          break
        case 'materializedViews':
          items = await api.db.objects(connectionId, ref, 'materialized_view')
          break
        case 'sequences':
          items = await api.db.objects(connectionId, ref, 'sequence')
          break
        case 'types':
          items = await api.db.objects(connectionId, ref, 'type')
          break
        case 'indexes':
          items = await api.db.objects(connectionId, ref, 'index')
          break
        case 'triggers':
          items = await api.db.objects(connectionId, ref, 'trigger')
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
      if (hasDatabaseLevel(c))
        return (databases.value[c] ?? []).map((d) => parse(nodeIds.database(c, d.name))!)
      return (databases.value[c] ?? []).map((d) => parse(nodeIds.schema(c, d.name))!)
    }
    if (node.kind === 'database')
      return schemasOf(c, node.database!).map((s) =>
        parse(nodeIds.schema(c, s.name, node.database))!
      )
    if (node.kind === 'schema')
      return groupsOf(c).map((g) => parse(nodeIds.group(c, node.schema!, g, node.database))!)
    if (node.kind === 'group') {
      const s = node.schema!
      const g = node.group!
      const items = itemsOf(c, s, g, node.database)
      return items.map((item) => {
        const raw = item as {
          name?: string
          fileName?: string
          path?: string
          id?: string
          type?: string
          kind?: string
        }
        const name = g === 'queries' ? raw.id! : itemName(g, item)
        const label = g === 'queries' ? (item as SavedQuery).name : itemLabel(g, item)
        const n = parse(nodeIds.object(c, s, g, name, node.database))!
        n.label = label
        n.subtype = raw.type
        const partitions = g === 'tables' ? (item as TableInfo).partitions : undefined
        if (partitions?.length) n.partitions = partitions
        return n
      })
    }
    if (node.kind === 'object' && node.partitions?.length) return partitionNodes(node)
    return []
  }

  /** PostgreSQL: partitions nested under their partitioned table (tables of their own schema). */
  function partitionNodes(node: TreeNode): TreeNode[] {
    return (node.partitions ?? []).map((p) => {
      const n = parse(nodeIds.object(node.connectionId, p.schema, 'tables', p.name, node.database))!
      n.label = p.schema === node.schema ? p.name : `${p.schema}.${p.name}`
      n.subtype = 'partition'
      n.detail = p.bound
      n.parentId = node.id
      if (p.partitions?.length) n.partitions = p.partitions
      return n
    })
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
    } else if (node.kind === 'database') {
      await loadSchemas(node.connectionId, node.database!)
    } else if (node.kind === 'group') {
      await loadGroup(node.connectionId, node.schema!, node.group!, false, node.database)
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
    else if (node.kind === 'database') await loadSchemas(node.connectionId, node.database!, true)
    else if (node.kind === 'schema') {
      const db = node.database
      const prefix = groupKeyPrefix(node.connectionId, node.schema!)
      const tail = db === undefined ? '' : `:${seg(db)}`
      const next = { ...groupItems.value }
      for (const key of Object.keys(next))
        if (
          key.startsWith(prefix) &&
          (db === undefined ? key.split(':').length === 3 : key.endsWith(tail))
        )
          delete next[key]
      groupItems.value = next
      for (const g of groupsOf(node.connectionId))
        if (isExpanded(nodeIds.group(node.connectionId, node.schema!, g, db)))
          await loadGroup(node.connectionId, node.schema!, g, true, db)
    } else if (node.kind === 'group')
      await loadGroup(node.connectionId, node.schema!, node.group!, true, node.database)
    else if (node.kind === 'object')
      await loadGroup(node.connectionId, node.schema!, node.group!, true, node.database)
  }

  /** Drop cached data for a connection (e.g. when it is closed). */
  /**
   * PostgreSQL «Cerrar base de datos»: closes its pool in main, then drops its
   * schemas, group items and expansion so the node shows closed again.
   */
  async function closeDatabase(connectionId: string, database: string): Promise<void> {
    await api.db.closeDatabase(connectionId, database)
    forgetDatabase(connectionId, database)
  }

  function forgetDatabase(connectionId: string, database: string): void {
    const nextSchemas = { ...schemas.value }
    delete nextSchemas[schemasKey(connectionId, database)]
    schemas.value = nextSchemas
    const tail = `:${seg(database)}`
    const prefix = groupKeyPrefix(connectionId)
    const nextItems = { ...groupItems.value }
    for (const key of Object.keys(nextItems))
      if (key.startsWith(prefix) && key.endsWith(tail)) delete nextItems[key]
    groupItems.value = nextItems
    const nextExpanded = { ...expanded.value }
    for (const key of Object.keys(nextExpanded)) {
      const n = parse(key)
      if (n?.connectionId === connectionId && n.database === database) delete nextExpanded[key]
    }
    expanded.value = nextExpanded
    const selectedNode = selectedId.value ? parse(selectedId.value) : null
    if (
      selectedNode?.connectionId === connectionId &&
      selectedNode.database === database &&
      selectedNode.kind !== 'database'
    )
      selectedId.value = nodeIds.database(connectionId, database)
  }

  function forget(connectionId: string): void {
    const nextDb = { ...databases.value }
    delete nextDb[connectionId]
    databases.value = nextDb
    const nextSchemas = { ...schemas.value }
    for (const key of Object.keys(nextSchemas))
      if (key.startsWith(`${seg(connectionId)}:`)) delete nextSchemas[key]
    schemas.value = nextSchemas
    const nextItems = { ...groupItems.value }
    const prefix = groupKeyPrefix(connectionId)
    for (const key of Object.keys(nextItems)) if (key.startsWith(prefix)) delete nextItems[key]
    groupItems.value = nextItems
    const nextExpanded = { ...expanded.value }
    for (const key of Object.keys(nextExpanded))
      if (parse(key)?.connectionId === connectionId) delete nextExpanded[key]
    expanded.value = nextExpanded
    const selectedNode = selectedId.value ? parse(selectedId.value) : null
    if (selectedNode?.connectionId === connectionId && selectedNode.kind !== 'connection') {
      selectedId.value = nodeIds.connection(connectionId)
    }
  }

  /** Label match; on engines with a schema level also `schema.object` (section 4.1). */
  function matchesFilter(node: TreeNode): boolean {
    const f = filter.value.trim().toLowerCase()
    if (!f) return true
    if (node.label.toLowerCase().includes(f)) return true
    return (
      node.database !== undefined &&
      !!node.schema &&
      `${node.schema}.${node.label}`.toLowerCase().includes(f)
    )
  }

  return {
    expanded,
    loading,
    errors,
    selectedId,
    selected,
    filter,
    databases,
    schemas,
    groupItems,
    parse,
    groupsOf,
    isExpanded,
    setExpanded,
    select,
    itemsOf,
    hasItems,
    hasDatabaseLevel,
    schemasOf,
    loadDatabases,
    loadSchemas,
    loadGroup,
    childrenOf,
    expand,
    collapse,
    toggle,
    refresh,
    forget,
    closeDatabase,
    forgetDatabase,
    matchesFilter
  }
})
