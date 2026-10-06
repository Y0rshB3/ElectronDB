import { useConnectionsStore } from '@renderer/stores/connections'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore, type ConfirmRequest } from '@renderer/stores/ui'

export interface DestructiveRequest {
  connectionId: string
  title: string
  message: string
  details?: string
  confirmText?: string
  /** Ask even when the connection is not production. Defaults to true. */
  alwaysAsk?: boolean
}

export function useConfirm() {
  const ui = useUiStore()
  const connections = useConnectionsStore()
  const settingsStore = useSettingsStore()

  function ask(request: ConfirmRequest): Promise<boolean> {
    return ui.ask(request)
  }

  /**
   * Guard for writes: on production connections (when enabled in settings) the
   * user must type the connection name; otherwise a plain confirmation is shown.
   */
  async function confirmDestructive(request: DestructiveRequest): Promise<boolean> {
    const connection = connections.get(request.connectionId)
    const production =
      connection?.environment === 'production' && settingsStore.settings.confirmProductionWrites
    if (production) {
      return ui.ask({
        title: request.title,
        message: `${request.message}\n\nEsta conexión está marcada como PRODUCCIÓN. Escribe el nombre de la conexión para continuar.`,
        details: request.details,
        confirmText: request.confirmText ?? 'Ejecutar en producción',
        color: 'error',
        requireTyped: connection!.name,
        production: true
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
