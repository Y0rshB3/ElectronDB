import type { ObjectType } from '@shared/types'
import { api } from '@renderer/api'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useQueriesStore } from '@renderer/stores/queries'
import { useTabsStore } from '@renderer/stores/tabs'
import { useTreeStore, type TreeNode } from '@renderer/stores/tree'
import { useUiStore } from '@renderer/stores/ui'
import { OBJECT_TYPE_LABELS, OBJECT_TYPE_WITH_ARTICLE } from '@renderer/utils/objectTypes'
import { qualified } from '@renderer/utils/sql'
import { useConfirm } from './useConfirm'
import { useNotify } from './useNotify'
import { useWorkspace } from './useWorkspace'

export interface MenuAction {
  key: string
  label: string
  icon?: string
  disabled?: boolean
  danger?: boolean
  divider?: boolean
  action?: () => void | Promise<void>
}

export function objectTypeOf(node: TreeNode): ObjectType | null {
  switch (node.group) {
    case 'tables':
      return 'table'
    case 'views':
      return 'view'
    case 'functions':
      return node.subtype === 'PROCEDURE' ? 'procedure' : 'function'
    case 'events':
      return 'event'
    default:
      return null
  }
}

export function useObjectActions() {
  const tree = useTreeStore()
  const tabs = useTabsStore()
  const connections = useConnectionsStore()
  const queries = useQueriesStore()
  const ui = useUiStore()
  const ws = useWorkspace()
  const notify = useNotify()
  const { confirmDestructive, ask } = useConfirm()

  async function copyText(text: string, what = 'Texto'): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      notify.success(`${what} copiado al portapapeles`)
    } catch {
      notify.error('No se pudo copiar al portapapeles')
    }
  }

  async function dropObject(node: TreeNode): Promise<void> {
    const type = objectTypeOf(node)
    if (!type || !node.schema || !node.name) return
    const ok = await confirmDestructive({
      connectionId: node.connectionId,
      title: `Eliminar ${OBJECT_TYPE_LABELS[type]}`,
      message: `Se eliminará ${OBJECT_TYPE_LABELS[type]} ${qualified(node.schema, node.name)} de forma permanente.`,
      confirmText: 'Eliminar',
      destructive: {
        title: `¿Eliminar ${OBJECT_TYPE_WITH_ARTICLE[type]} «${node.name}»?`,
        message: 'Se eliminará de forma permanente. Esta acción no se puede deshacer.',
        items: [{ tag: `DROP ${type.toUpperCase()}`, text: qualified(node.schema, node.name) }],
        confirmText: 'Eliminar'
      }
    })
    if (!ok) return
    await api.db.dropObject(node.connectionId, node.schema, type, node.name, {
      confirmProduction: true
    })
    notify.success(`${node.name} eliminado`)
    await tree.loadGroup(node.connectionId, node.schema, node.group!, true)
  }

  async function truncateTable(node: TreeNode): Promise<void> {
    if (!node.schema || !node.name) return
    const sql = `TRUNCATE TABLE ${qualified(node.schema, node.name)}`
    const ok = await confirmDestructive({
      connectionId: node.connectionId,
      title: 'Truncar tabla',
      message: `Se borrarán todas las filas de ${qualified(node.schema, node.name)}. Esta acción no se puede deshacer.`,
      details: sql,
      confirmText: 'Truncar',
      destructive: {
        title: `¿Vaciar la tabla «${node.name}»?`,
        message: 'Se borrarán todas sus filas. Esta acción no se puede deshacer.',
        items: [{ tag: 'TRUNCATE TABLE', text: qualified(node.schema, node.name) }],
        confirmText: 'Eliminar'
      }
    })
    if (!ok) return
    const [result] = await api.db.execute(node.connectionId, sql, { confirmProduction: true })
    if (result?.error) notify.error(result.error)
    else {
      notify.success(`Tabla ${node.name} truncada`)
      await tree.loadGroup(node.connectionId, node.schema, 'tables', true)
    }
  }

  async function exportDdl(node: TreeNode): Promise<void> {
    const type = objectTypeOf(node)
    if (!type || !node.schema || !node.name) return
    const ddl = await api.db.showCreate(node.connectionId, node.schema, type, node.name)
    await copyText(ddl, 'DDL')
  }

  async function deleteSavedQuery(node: TreeNode): Promise<void> {
    if (!node.name) return
    const ok = await ask({
      title: 'Eliminar consulta',
      message: `Se eliminará la consulta guardada "${node.label}".`,
      confirmText: 'Eliminar',
      color: 'warning'
    })
    if (!ok) return
    queries.remove(node.connectionId, node.name)
    tabs.close(`query:${node.connectionId}:${node.name}`)
  }

  async function closeConnection(connectionId: string): Promise<void> {
    const dirty = tabs.tabs.filter((t) => t.connectionId === connectionId && t.dirty)
    if (dirty.length) {
      const ok = await ask({
        title: 'Cerrar conexión',
        message: `Hay ${dirty.length} pestaña(s) con cambios sin guardar. ¿Cerrar de todos modos?`,
        confirmText: 'Cerrar',
        color: 'warning'
      })
      if (!ok) return
    }
    await connections.close(connectionId)
    tabs.closeForConnection(connectionId)
    tree.forget(connectionId)
  }

  async function deleteConnection(connectionId: string): Promise<void> {
    const dirty = tabs.tabs.filter((t) => t.connectionId === connectionId && t.dirty).length
    const unsaved = dirty
      ? `\n\nHay ${dirty} pestaña(s) de esta conexión con cambios sin guardar que se perderán.`
      : ''
    const ok = await ask({
      title: 'Eliminar conexión',
      message: `Se eliminará la conexión "${connections.nameOf(connectionId)}" y su contraseña guardada.${unsaved}`,
      confirmText: 'Eliminar',
      color: 'error'
    })
    if (!ok) return
    tabs.closeForConnection(connectionId)
    tree.forget(connectionId)
    await connections.remove(connectionId)
    if (tree.selectedId === `c:${connectionId}`) tree.select(null)
    notify.success('Conexión eliminada')
  }

  async function dropDatabase(node: TreeNode): Promise<void> {
    if (!node.schema) return
    const ok = await confirmDestructive({
      connectionId: node.connectionId,
      title: 'Eliminar base de datos',
      message: `Se eliminará la base de datos ${node.schema} con todos sus objetos y datos.`,
      details: `DROP DATABASE \`${node.schema}\``,
      confirmText: 'Eliminar base de datos',
      destructive: {
        title: `¿Eliminar la base de datos «${node.schema}»?`,
        message:
          'Se eliminarán todas sus tablas, vistas, rutinas, eventos y datos. Esta acción no se puede deshacer.',
        items: [{ tag: 'DROP DATABASE', text: qualified(null, node.schema) }],
        confirmText: 'Eliminar'
      }
    })
    if (!ok) return
    await api.db.dropDatabase(node.connectionId, node.schema, { confirmProduction: true })
    notify.success(`Base de datos ${node.schema} eliminada`)
    tree.forget(node.connectionId)
    await tree.loadDatabases(node.connectionId, true)
  }

  function newObjectFor(node: TreeNode): MenuAction[] {
    const c = node.connectionId
    const s = node.schema!
    switch (node.group) {
      case 'tables':
        return [
          {
            key: 'new',
            label: 'Nueva tabla',
            icon: 'mdi-table-plus',
            action: () => ws.openTableDesigner(c, s, null)
          }
        ]
      case 'views':
        return [
          {
            key: 'new',
            label: 'Nueva vista',
            icon: 'mdi-plus',
            action: () => ws.openDdlEditor(c, s, 'view', null)
          }
        ]
      case 'functions':
        return [
          {
            key: 'newf',
            label: 'Nueva función',
            icon: 'mdi-plus',
            action: () => ws.openDdlEditor(c, s, 'function', null)
          },
          {
            key: 'newp',
            label: 'Nuevo procedimiento',
            icon: 'mdi-plus',
            action: () => ws.openDdlEditor(c, s, 'procedure', null)
          }
        ]
      case 'events':
        return [
          {
            key: 'new',
            label: 'Nuevo evento',
            icon: 'mdi-plus',
            action: () => ws.openDdlEditor(c, s, 'event', null)
          }
        ]
      case 'queries':
        return [
          {
            key: 'new',
            label: 'Nueva consulta',
            icon: 'mdi-plus',
            action: () => ws.openQuery(c, s)
          }
        ]
      case 'backups':
        return [
          {
            key: 'new',
            label: 'Nueva copia de seguridad…',
            icon: 'mdi-plus',
            action: () => ui.openBackupDialog(c, s)
          }
        ]
      default:
        return []
    }
  }

  function actionsFor(node: TreeNode): MenuAction[] {
    const c = node.connectionId
    const refresh: MenuAction = {
      key: 'refresh',
      label: 'Actualizar',
      icon: 'mdi-refresh',
      action: () => tree.refresh(node)
    }
    if (node.kind === 'connection') {
      const open = connections.isOpen(c)
      return [
        open
          ? {
              key: 'close',
              label: 'Cerrar conexión',
              icon: 'mdi-lan-disconnect',
              action: () => closeConnection(c)
            }
          : {
              key: 'open',
              label: 'Abrir conexión',
              icon: 'mdi-lan-connect',
              action: () => ws.ensureOpen(c)
            },
        {
          key: 'edit',
          label: 'Editar conexión…',
          icon: 'mdi-pencil-outline',
          action: () => ui.openConnectionDialog(connections.get(c) ?? null)
        },
        { key: 'd1', label: '', divider: true },
        {
          key: 'query',
          label: 'Nueva consulta',
          icon: 'mdi-database-search-outline',
          disabled: !open,
          action: () => ws.openQuery(c, null)
        },
        {
          key: 'newdb',
          label: 'Nueva base de datos…',
          icon: 'mdi-database-plus',
          disabled: !open,
          action: () => ui.openNewDatabaseDialog(c)
        },
        {
          key: 'backups',
          label: 'Copias de seguridad',
          icon: 'mdi-archive-outline',
          action: () => ws.openBackups(c, null)
        },
        {
          key: 'users',
          label: 'Usuarios',
          icon: 'mdi-account-multiple-outline',
          disabled: !open,
          action: () => ws.openUsers(c)
        },
        { key: 'd2', label: '', divider: true },
        { ...refresh, disabled: !open },
        {
          key: 'delete',
          label: 'Eliminar conexión',
          icon: 'mdi-delete-outline',
          danger: true,
          action: () => deleteConnection(c)
        }
      ]
    }
    if (node.kind === 'schema') {
      const s = node.schema!
      return [
        {
          key: 'query',
          label: 'Nueva consulta',
          icon: 'mdi-database-search-outline',
          action: () => ws.openQuery(c, s)
        },
        {
          key: 'table',
          label: 'Nueva tabla',
          icon: 'mdi-table-plus',
          action: () => ws.openTableDesigner(c, s, null)
        },
        {
          key: 'backup',
          label: 'Nueva copia de seguridad…',
          icon: 'mdi-archive-plus-outline',
          action: () => ui.openBackupDialog(c, s)
        },
        {
          key: 'backups',
          label: 'Copias de seguridad',
          icon: 'mdi-archive-outline',
          action: () => ws.openBackups(c, s)
        },
        { key: 'd1', label: '', divider: true },
        refresh,
        {
          key: 'drop',
          label: 'Eliminar base de datos',
          icon: 'mdi-delete-outline',
          danger: true,
          action: () => dropDatabase(node)
        }
      ]
    }
    if (node.kind === 'group')
      return [...newObjectFor(node), { key: 'd1', label: '', divider: true }, refresh]

    const isTable = node.group === 'tables'
    const isQuery = node.group === 'queries'
    const isBackup = node.group === 'backups'
    const items: MenuAction[] = [
      {
        key: 'open',
        label: isBackup ? 'Ver copias de seguridad' : 'Abrir',
        icon: 'mdi-open-in-app',
        action: () => ws.openNode(node)
      }
    ]
    if (isTable)
      items.push({
        key: 'design',
        label: 'Diseñar tabla',
        icon: 'mdi-table-edit',
        action: () => ws.designNode(node)
      })
    items.push(...newObjectFor({ ...node, kind: 'group' }))
    items.push({ key: 'd1', label: '', divider: true })
    if (isBackup) {
      items.push({
        key: 'restore',
        label: 'Restaurar…',
        icon: 'mdi-backup-restore',
        action: () => openRestore(node)
      })
      items.push({
        key: 'finder',
        label: 'Mostrar en Finder',
        icon: 'mdi-folder-open-outline',
        action: () => api.app.showInFolder(node.name!)
      })
    } else {
      items.push({
        key: 'copy',
        label: 'Copiar nombre',
        icon: 'mdi-content-copy',
        action: () => copyText(node.label, 'Nombre')
      })
      if (!isQuery)
        items.push({
          key: 'ddl',
          label: 'Exportar DDL (copiar)',
          icon: 'mdi-code-tags',
          action: () => exportDdl(node)
        })
      if (isTable)
        items.push({
          key: 'truncate',
          label: 'Truncar tabla',
          icon: 'mdi-eraser',
          danger: true,
          action: () => truncateTable(node)
        })
      items.push({
        key: 'delete',
        label: 'Eliminar',
        icon: 'mdi-delete-outline',
        danger: true,
        action: () => (isQuery ? deleteSavedQuery(node) : dropObject(node))
      })
    }
    items.push({ key: 'd2', label: '', divider: true }, refresh)
    return items
  }

  function openRestore(node: TreeNode): void {
    const file = tree
      .itemsOf(node.connectionId, node.schema!, 'backups')
      .find((b) => b.path === node.name)
    if (file) ui.openRestoreDialog(file, node.connectionId)
  }

  return {
    actionsFor,
    copyText,
    dropObject,
    truncateTable,
    exportDdl,
    deleteSavedQuery,
    closeConnection,
    deleteConnection,
    dropDatabase
  }
}
