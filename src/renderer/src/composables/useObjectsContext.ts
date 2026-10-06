import { computed } from 'vue'
import type { DatabaseInfo } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useTreeStore, type TreeNode } from '@renderer/stores/tree'
import { GROUP_LABELS, type GroupKind } from '@renderer/utils/objectTypes'
import { pluralize } from '@renderer/utils/format'

export interface ObjectsContext {
  connectionId: string
  /** null when the connection node itself is selected (databases list). */
  schema: string | null
  group: GroupKind | null
  /** Highlighted object (node name) inside the group. */
  objectName: string | null
}

/** Maps the tree selection to what the Objects tab should list. */
export function resolveObjectsContext(node: TreeNode | null): ObjectsContext | null {
  if (!node) return null
  switch (node.kind) {
    case 'connection':
      return { connectionId: node.connectionId, schema: null, group: null, objectName: null }
    case 'schema':
      return {
        connectionId: node.connectionId,
        schema: node.schema ?? null,
        group: 'tables',
        objectName: null
      }
    case 'group':
      return {
        connectionId: node.connectionId,
        schema: node.schema ?? null,
        group: node.group ?? null,
        objectName: null
      }
    case 'object':
      return {
        connectionId: node.connectionId,
        schema: node.schema ?? null,
        group: node.group ?? null,
        objectName: node.name ?? null
      }
  }
}

/** Reactive view of the current Objects context plus its loaded items. */
export function useObjectsContext() {
  const tree = useTreeStore()
  const connections = useConnectionsStore()

  const context = computed(() => resolveObjectsContext(tree.selected))
  const connectionOpen = computed(() =>
    context.value ? connections.isOpen(context.value.connectionId) : false
  )

  const databases = computed<DatabaseInfo[]>(() =>
    context.value ? (tree.databases[context.value.connectionId] ?? []) : []
  )

  const items = computed<unknown[]>(() => {
    const ctx = context.value
    if (!ctx || !ctx.schema || !ctx.group) return []
    return tree.itemsOf(ctx.connectionId, ctx.schema, ctx.group) as unknown[]
  })

  /** Status-bar style summary like "12 Tablas" or "3 bases de datos". */
  const summary = computed(() => {
    const ctx = context.value
    if (!ctx || !connectionOpen.value) return ''
    if (!ctx.group)
      return tree.databases[ctx.connectionId]
        ? pluralize(databases.value.length, 'base de datos', 'bases de datos')
        : ''
    if (!ctx.schema || !tree.hasItems(ctx.connectionId, ctx.schema, ctx.group)) return ''
    return `${items.value.length} ${GROUP_LABELS[ctx.group]}`
  })

  return { context, connectionOpen, databases, items, summary }
}
