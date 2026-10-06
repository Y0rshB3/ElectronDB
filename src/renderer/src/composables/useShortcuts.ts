import { onBeforeUnmount, onMounted } from 'vue'
import { useWorkspace } from './useWorkspace'
import { useTabActions } from './useTabActions'

/**
 * Global keyboard shortcuts of the shell. Cmd+R / Cmd+Enter belong to QueryView.
 * Note: Cmd+W only reaches the renderer when the main-process app menu does not
 * bind it to "Close Window".
 */
export function useShortcuts() {
  const ws = useWorkspace()
  const { requestCloseActive } = useTabActions()

  function onKeydown(event: KeyboardEvent): void {
    const mod = event.metaKey || event.ctrlKey
    if (!mod || event.altKey || event.shiftKey) return
    const key = event.key.toLowerCase()
    if (key === 'n') {
      event.preventDefault()
      ws.openQuery()
    } else if (key === 'w') {
      event.preventDefault()
      void requestCloseActive()
    }
  }

  onMounted(() => window.addEventListener('keydown', onKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

  return { onKeydown }
}
