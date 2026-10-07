import type { ObjectType } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { OBJECTS_TAB_ID, objectTabId, useTabsStore, tabTitle } from '@renderer/stores/tabs'
import { nodeIds, useTreeStore, type TreeNode } from '@renderer/stores/tree'
import type { GroupKind } from '@renderer/utils/objectTypes'
import { useUiStore } from '@renderer/stores/ui'
import { useNotify } from './useNotify'
import { runSafely } from '@renderer/utils/errors'

/** High-level actions shared by the toolbar, the tree and the objects list. */
export function useWorkspace() {
  const tabs = useTabsStore()
  const tree = useTreeStore()
  const connections = useConnectionsStore()
  const ui = useUiStore()
  const notify = useNotify()

  /**
   * Connection the toolbar acts on: the tree selection, then the active tab.
   * Without either, only an unambiguous single connection is used: acting on an
   * arbitrary one (maybe production) the user never chose would be surprising.
   */
  function currentConnectionId(): string | null {
    return (
      tree.selected?.connectionId ??
      tabs.active.connectionId ??
      (connections.items.length === 1 ? connections.items[0].id : null)
    )
  }

  /** Schema in context, never mixing the tree selection with another connection's tab. */
  function currentSchema(): string | null {
    if (tree.selected?.schema) return tree.selected.schema
    const cid = currentConnectionId()
    return cid && tabs.active.connectionId === cid ? (tabs.active.schema ?? null) : null
  }

  async function ensureOpen(connectionId: string): Promise<boolean> {
    if (connections.isOpen(connectionId)) return true
    try {
      await connections.open(connectionId)
      tree.setExpanded(nodeIds.connection(connectionId), true)
      await tree.loadDatabases(connectionId)
      return true
    } catch {
      return false
    }
  }

  /*
   * `database` is only for engines with a database level above schemas
   * (PostgreSQL); MySQL callers omit it and get the v0.1.0 ids and titles.
   */
  function openTableData(
    connectionId: string,
    schema: string,
    table: string,
    database?: string
  ): void {
    tabs.open({
      kind: 'tableData',
      id: objectTabId('tableData', connectionId, database, schema, table),
      title: tabTitle(table, schema, connections.nameOf(connectionId), database),
      connectionId,
      database,
      schema,
      objectName: table,
      objectType: 'table'
    })
  }

  function openTableDesigner(
    connectionId: string,
    schema: string,
    table: string | null,
    database?: string
  ): void {
    tabs.open({
      kind: 'tableDesigner',
      id: table ? objectTabId('tableDesigner', connectionId, database, schema, table) : undefined,
      title: table
        ? tabTitle(table, schema, connections.nameOf(connectionId), database)
        : tabTitle('Nueva tabla', schema, connections.nameOf(connectionId), database),
      connectionId,
      database,
      schema,
      objectName: table ?? undefined,
      objectType: 'table'
    })
  }

  function openDdlEditor(
    connectionId: string,
    schema: string,
    type: ObjectType,
    name: string | null,
    database?: string
  ): void {
    tabs.open({
      kind: 'ddlEditor',
      id: name ? objectTabId('ddl', connectionId, database, schema, type, name) : undefined,
      title: name
        ? tabTitle(name, schema, connections.nameOf(connectionId), database)
        : tabTitle(`Nuevo ${type}`, schema, connections.nameOf(connectionId), database),
      connectionId,
      database,
      schema,
      objectName: name ?? undefined,
      objectType: type
    })
  }

  function openQuery(
    connectionId?: string | null,
    schema?: string | null,
    payload?: { savedQueryId?: string; sql?: string; name?: string }
  ): void {
    const cid = connectionId ?? currentConnectionId()
    if (!cid) {
      notify.warning('Selecciona una conexión antes de crear una consulta')
      return
    }
    // A query first saved with "Guardar como" lives in a tab with an anonymous id: reuse it.
    const savedId = payload?.savedQueryId
    const existing = savedId
      ? tabs.tabs.find(
          (t) => t.kind === 'query' && t.connectionId === cid && t.payload?.savedQueryId === savedId
        )
      : undefined
    if (existing) {
      tabs.activate(existing.id)
      return
    }
    const s = schema ?? (tree.selected?.connectionId === cid ? currentSchema() : null)
    const name = payload?.name ?? 'Consulta sin título'
    // A tab with this id may since have been switched to another connection: open a new one.
    const queryTabId = savedId ? `query:${cid}:${savedId}` : undefined
    const idTaken = !!queryTabId && tabs.tabs.some((t) => t.id === queryTabId)
    tabs.open({
      kind: 'query',
      id: idTaken ? undefined : queryTabId,
      title: `${name}${s ? `@${s}` : ''} (${connections.nameOf(cid)})`,
      connectionId: cid,
      schema: s ?? undefined,
      payload
    })
  }

  function openBackups(connectionId?: string | null, schema?: string | null): void {
    const cid = connectionId ?? currentConnectionId()
    if (!cid) return notify.warning('Selecciona una conexión')
    tabs.open({
      kind: 'backups',
      id: `backups:${cid}:${schema ?? '*'}`,
      title: `Copias de seguridad${schema ? `@${schema}` : ''} (${connections.nameOf(cid)})`,
      connectionId: cid,
      schema: schema ?? undefined
    })
  }

  function openUsers(connectionId?: string | null): void {
    const cid = connectionId ?? currentConnectionId()
    if (!cid) return notify.warning('Selecciona una conexión')
    tabs.open({
      kind: 'users',
      id: `users:${cid}`,
      title: `Usuarios (${connections.nameOf(cid)})`,
      connectionId: cid
    })
  }

  function openAutomation(): void {
    tabs.open({ kind: 'automation', id: 'automation', title: 'Automatización' })
  }

  function openJobEditor(jobId: string | null, name?: string): void {
    tabs.open({
      kind: 'jobEditor',
      id: jobId ? `job:${jobId}` : undefined,
      title: jobId ? `${name ?? 'Tarea'} (Automatización)` : 'Nueva tarea (Automatización)',
      payload: { jobId }
    })
  }

  /** Activates the fixed "Objetos" tab. */
  function showObjects(): void {
    tabs.activate(OBJECTS_TAB_ID)
  }

  /**
   * Selects a group (Tablas, Vistas...) of the current schema in the tree and
   * shows it in the Objects tab (the toolbar's Objetos menu).
   */
  async function showGroup(group: GroupKind): Promise<boolean> {
    const cid = currentConnectionId()
    const schema = currentSchema()
    if (!cid || !schema) {
      notify.warning('Selecciona una base de datos en el árbol de conexiones')
      return false
    }
    if (!(await ensureOpen(cid))) return false
    tree.setExpanded(nodeIds.connection(cid), true)
    tree.setExpanded(nodeIds.schema(cid, schema), true)
    const node = tree.parse(nodeIds.group(cid, schema, group))
    if (!node) return false
    tree.select(node.id)
    showObjects()
    await tree.expand(node)
    return true
  }

  /** Default action for double-clicking a tree/object node. */
  async function openNode(node: TreeNode): Promise<void> {
    if (node.kind === 'connection') {
      await ensureOpen(node.connectionId)
      return
    }
    if (node.kind !== 'object' || !node.schema || !node.name) return
    const { connectionId, schema, name, group } = node
    switch (group) {
      case 'tables':
        return openTableData(connectionId, schema, name)
      case 'views':
        return openDdlEditor(connectionId, schema, 'view', name)
      case 'functions':
        return openDdlEditor(
          connectionId,
          schema,
          node.subtype === 'PROCEDURE' ? 'procedure' : 'function',
          name
        )
      case 'events':
        return openDdlEditor(connectionId, schema, 'event', name)
      case 'queries':
        return openQuery(connectionId, schema, { savedQueryId: name })
      case 'backups':
        return openBackups(connectionId, schema)
    }
  }

  function designNode(node: TreeNode): void {
    if (node.kind !== 'object' || !node.schema || !node.name) return
    if (node.group === 'tables') openTableDesigner(node.connectionId, node.schema, node.name)
    else void runSafely(() => openNode(node))
  }

  return {
    currentConnectionId,
    currentSchema,
    ensureOpen,
    openTableData,
    openTableDesigner,
    openDdlEditor,
    openQuery,
    openBackups,
    openUsers,
    openAutomation,
    openJobEditor,
    openNode,
    designNode,
    showObjects,
    showGroup,
    ui
  }
}
