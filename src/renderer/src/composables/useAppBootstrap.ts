import type { StartupNotice } from '@shared/types'
import { api } from '@renderer/api'
import { useAiStore } from '@renderer/stores/ai'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useJobLogsStore } from '@renderer/stores/jobLogs'
import { useJobsStore } from '@renderer/stores/jobs'
import { useLogStore } from '@renderer/stores/log'
import { useProgressStore } from '@renderer/stores/progress'
import { useSettingsStore } from '@renderer/stores/settings'
import { useTreeStore } from '@renderer/stores/tree'
import { useUiStore } from '@renderer/stores/ui'
import { useUpdatesStore } from '@renderer/stores/updates'

let disposers: (() => void)[] = []

/**
 * Subscribes to main-process push events. Idempotent: calling it again
 * (HMR, remounts) replaces the previous subscriptions instead of stacking them.
 */
export function subscribeToMainEvents(): () => void {
  unsubscribeFromMainEvents()
  const connections = useConnectionsStore()
  const tree = useTreeStore()
  disposers = [
    useProgressStore().listen(),
    useJobsStore().listen(),
    // Live automation run logs (event:jobLog).
    useJobLogsStore().listen(),
    useLogStore().listen(),
    // Marks the connection closed and notifies the user.
    connections.listenToClosedEvents(),
    // Drops cached schema data so the tree does not show stale children.
    api.on('event:connectionClosed', ({ connectionId }) => tree.forget(connectionId)),
    // App menu «Buscar actualizaciones…».
    api.on('event:checkUpdates', () => useUpdatesStore().openDialog()),
    // In-app update download progress (event:updateInstall).
    useUpdatesStore().listen(),
    // Streamed AI answers (event:aiDelta / aiStatus / aiDone).
    useAiStore().listen()
  ]
  return unsubscribeFromMainEvents
}

export function unsubscribeFromMainEvents(): void {
  for (const dispose of disposers) dispose()
  disposers = []
}

/**
 * Initial data load. Each source is loaded independently so one failure
 * (already reported through the snackbar by api.invoke) does not block the rest.
 * Nothing opens by itself here: a fresh profile gets the welcome tour (see
 * stores/tour.ts), whose last step offers the Navicat import.
 */
export async function loadInitialData(): Promise<void> {
  const settings = useSettingsStore()
  const connections = useConnectionsStore()
  const jobs = useJobsStore()

  await Promise.allSettled([settings.load(), connections.load(), jobs.load()])
  await showStartupNotices()
}

/**
 * One-off messages from main (e.g. passwords to type again after the
 * ElectronDB/Navidog -> Vortaq migration). Each one is dismissed in main once shown,
 * so it appears a single time. Best effort: failures only skip the notice.
 */
export async function showStartupNotices(): Promise<void> {
  const ui = useUiStore()
  let notices: StartupNotice[]
  try {
    notices = (await api.app.startupNotices()) ?? []
  } catch {
    return
  }
  for (const notice of notices) {
    await ui.ask({
      title: notice.title,
      message: notice.message,
      confirmText: 'Entendido',
      color: notice.level === 'warning' ? 'warning' : undefined,
      notice: true
    })
    await api.app.dismissStartupNotice(notice.id).catch(() => undefined)
  }
}
