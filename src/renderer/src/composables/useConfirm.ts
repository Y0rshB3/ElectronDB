import { environmentName } from '@shared/typedConfirm'
import type { ConnectionConfig } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore, type ConfirmItem, type ConfirmRequest } from '@renderer/stores/ui'

/**
 * What a destructive operation (DROP, TRUNCATE, DELETE, deleting rows or
 * objects) removes. With `confirmDestructiveEverywhere` on, connections that
 * do not need the typed name show a plain confirmation built from it.
 */
export interface DestructiveDetails {
  /** Question title, e.g. "¿Eliminar la tabla «clientes»?". */
  title: string
  /** Exact objects or statements affected. */
  items: ConfirmItem[]
  /** Red button label: "Eliminar" or "Ejecutar". */
  confirmText: string
  /** Replaces the request message in the plain dialog. */
  message?: string
  /** Full SQL shown under the list (the request `details` are not reused). */
  details?: string
}

export interface DestructiveRequest {
  connectionId: string
  title: string
  message: string
  details?: string
  confirmText?: string
  /** Ask even when the connection does not need the typed name. Defaults to true. */
  alwaysAsk?: boolean
  /** Set when the operation deletes something; see DestructiveDetails. */
  destructive?: DestructiveDetails
}

/**
 * Where a typed-confirmation write lands, for titles and buttons:
 * "producción" for production, «name» for the other guarded environments
 * ("Ejecutar en producción", "Ejecutar en «Pre»").
 */
export function typedTarget(
  connection: Pick<ConnectionConfig, 'name' | 'environment'> | null | undefined
): string {
  if (!connection || connection.environment === 'production') return 'producción'
  return `«${connection.name}»`
}

/** Paragraph appended to the message of a typed confirmation. */
export function typedConfirmNotice(
  connection: Pick<ConnectionConfig, 'name' | 'environment'>
): string {
  if (connection.environment === 'production')
    return 'Esta conexión está marcada como PRODUCCIÓN. Escribe el nombre de la conexión para continuar.'
  return `La conexión «${connection.name}» (entorno ${environmentName(connection.environment)}) requiere confirmación: escribe su nombre para continuar.`
}

export function useConfirm() {
  const ui = useUiStore()
  const connections = useConnectionsStore()
  const settingsStore = useSettingsStore()

  function ask(request: ConfirmRequest): Promise<boolean> {
    return ui.ask(request)
  }

  /**
   * Guard for writes. Shows one dialog at most:
   * - connection that needs the typed name (production, always, and the environments chosen in
   *   Ajustes › Seguridad): the user types the connection name. It replaces the destructive
   *   confirmation, never both;
   * - destructive operation with `confirmDestructiveEverywhere` on: plain confirmation listing
   *   what is removed, with "Cancelar" focused;
   * - otherwise a plain confirmation, unless `alwaysAsk` is false.
   */
  async function confirmDestructive(request: DestructiveRequest): Promise<boolean> {
    const connection = connections.get(request.connectionId)
    if (connection && settingsStore.needsTypedConfirm(connection.environment)) {
      return ui.ask({
        title: request.title,
        message: `${request.message}\n\n${typedConfirmNotice(connection)}`,
        details: request.details,
        items: request.destructive?.items,
        confirmText: request.confirmText ?? `Ejecutar en ${typedTarget(connection)}`,
        color: 'error',
        requireTyped: connection.name,
        production: true,
        typedEnvironment: connection.environment
      })
    }
    const destructive = request.destructive
    if (destructive && settingsStore.settings.confirmDestructiveEverywhere !== false) {
      return ui.ask({
        title: destructive.title,
        message: destructive.message ?? request.message,
        details: destructive.details,
        items: destructive.items,
        connection: connection
          ? { name: connection.name, environment: connection.environment }
          : undefined,
        confirmText: destructive.confirmText,
        color: 'error',
        danger: true
      })
    }
    if (request.alwaysAsk === false) return true
    return ui.ask({
      title: request.title,
      message: request.message,
      details: request.details,
      confirmText: request.confirmText ?? 'Confirmar',
      color: 'warning'
    })
  }

  return { ask, confirmDestructive }
}
