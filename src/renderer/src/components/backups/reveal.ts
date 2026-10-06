import { api } from '@renderer/api'

/**
 * Reveals a file in Finder. Failures are already reported by api.invoke's snackbar,
 * so the rejection is swallowed here instead of reaching the Vue error handler.
 */
export function revealInFinder(path: string | null | undefined): void {
  if (!path) return
  api.app.showInFolder(path).catch(() => undefined)
}
