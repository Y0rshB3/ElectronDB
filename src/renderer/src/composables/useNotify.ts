import { reactive, readonly } from 'vue'

export type NotifyLevel = 'success' | 'info' | 'warning' | 'error'

/** Optional button shown next to "Cerrar"; the notification closes after the handler runs. */
export interface NotifyAction {
  label: string
  handler: () => void
}

export interface Notification {
  id: number
  level: NotifyLevel
  message: string
  timeout: number
  action?: NotifyAction
}

/**
 * Module-level notification queue so that non-component code (api.ts, stores)
 * can push messages without depending on Pinia.
 */
const state = reactive<{ queue: Notification[] }>({ queue: [] })
let seq = 0

function push(level: NotifyLevel, message: string, action?: NotifyAction): void {
  const last = state.queue[state.queue.length - 1]
  if (last && last.message === message && last.level === level) return
  state.queue.push({
    id: ++seq,
    level,
    message,
    // a button needs time to be reached
    timeout: level === 'error' || action ? 8000 : 4000,
    ...(action ? { action } : {})
  })
  if (state.queue.length > 5) state.queue.shift()
}

export function useNotify() {
  return {
    queue: readonly(state).queue,
    success: (message: string, action?: NotifyAction) => push('success', message, action),
    info: (message: string, action?: NotifyAction) => push('info', message, action),
    warning: (message: string, action?: NotifyAction) => push('warning', message, action),
    error: (message: string, action?: NotifyAction) => push('error', message, action),
    dismiss: (id: number) => {
      const idx = state.queue.findIndex((n) => n.id === id)
      if (idx >= 0) state.queue.splice(idx, 1)
    }
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error)
    return err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  if (typeof err === 'string') return err
  return 'Error desconocido'
}
