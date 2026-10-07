import { useUiStore } from '@renderer/stores/ui'

/** How often a queued popup checks again whether the screen is free. */
export const MODAL_RETRY_MS = 700

/**
 * True while any modal is on screen: the guided tour, the global ones tracked in the ui store
 * and, through the DOM, every other active Vuetify dialog (rollback, users,
 * update dialogs...). Menus and tooltips do not count.
 */
export function otherModalOpen(): boolean {
  const ui = useUiStore()
  if (
    ui.tourActive ||
    ui.confirm.open ||
    ui.connectionDialog.open ||
    ui.importDialog ||
    ui.settingsDialog ||
    ui.aboutDialog ||
    ui.newDatabaseDialog.open ||
    ui.backupDialog.open ||
    ui.restoreDialog.open
  )
    return true
  return typeof document !== 'undefined' && !!document.querySelector('.v-overlay--active.v-dialog')
}

/**
 * Runs `show` as soon as no other modal is open. Polls every MODAL_RETRY_MS
 * while `wanted()` stays true. Returns a function that cancels the wait.
 */
export function showWhenFree(show: () => void, wanted: () => boolean): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const attempt = (): void => {
    timer = null
    if (!wanted()) return
    if (otherModalOpen()) timer = setTimeout(attempt, MODAL_RETRY_MS)
    else show()
  }
  attempt()
  return () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
}
