import { ApiError } from '@renderer/api'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'

/** Whether the error was already surfaced to the user by `api.invoke`. */
export function wasNotified(err: unknown): boolean {
  return err instanceof ApiError && err.notified
}

/** Shows an unexpected error in the global snackbar unless it was already shown. */
export function reportError(err: unknown): void {
  if (!wasNotified(err)) useNotify().error(errorMessage(err))
}

/**
 * Runs a fire-and-forget UI action (menu item, toolbar button) so a failure is
 * reported once to the user instead of becoming an unhandled rejection.
 */
export async function runSafely(action: (() => unknown) | undefined): Promise<void> {
  try {
    await action?.()
  } catch (err) {
    reportError(err)
  }
}
