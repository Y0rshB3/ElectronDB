import { useTabsStore } from '@renderer/stores/tabs'
import { useUiStore } from '@renderer/stores/ui'

/** Tab closing with an unsaved-changes guard, shared by the tab strip and keyboard shortcuts. */
export function useTabActions() {
  const tabs = useTabsStore()
  const ui = useUiStore()

  /** Closes a tab, asking first when it has unsaved changes. Resolves true when closed. */
  async function requestClose(id: string): Promise<boolean> {
    const tab = tabs.tabs.find((t) => t.id === id)
    if (!tab || !tab.closable) return false
    if (tab.dirty) {
      const ok = await ui.ask({
        title: 'Cambios sin guardar',
        message: `"${tab.title}" tiene cambios sin guardar. Si cierras la pestaña se perderán.`,
        confirmText: 'Cerrar sin guardar',
        color: 'warning'
      })
      if (!ok) return false
    }
    tabs.close(id)
    return true
  }

  function requestCloseActive(): Promise<boolean> {
    return requestClose(tabs.activeId)
  }

  /** Closes every other closable tab; dirty ones are kept (tabs.closeOthers semantics). */
  function closeOthers(id: string): void {
    tabs.closeOthers(id)
  }

  return { requestClose, requestCloseActive, closeOthers }
}
