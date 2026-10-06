import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StartupNotice } from '@shared/types'

/**
 * Notices raised by main modules while the app starts (no keyring, legacy
 * launch agents left behind...), next to the migration ones. Each id is shown
 * until the user dismisses it once; dismissed ids are remembered in
 * <profile>/notices.json, so an id must change when the situation does.
 * Pure Node (no electron) so it is unit tested.
 */

export const NOTICES_FILE = 'notices.json'

const raised = new Map<string, StartupNotice>()

export function raiseNotice(notice: StartupNotice): void {
  raised.set(notice.id, notice)
}

/** Test helper: forgets every raised notice. */
export function clearRaisedNotices(): void {
  raised.clear()
}

function dismissedIds(userDataPath: string): string[] {
  try {
    const doc = JSON.parse(readFileSync(join(userDataPath, NOTICES_FILE), 'utf8')) as {
      dismissed?: unknown
    }
    return Array.isArray(doc.dismissed)
      ? doc.dismissed.filter((id): id is string => typeof id === 'string')
      : []
  } catch {
    return []
  }
}

export function raisedNotices(userDataPath: string): StartupNotice[] {
  const dismissed = new Set(dismissedIds(userDataPath))
  return [...raised.values()].filter((n) => !dismissed.has(n.id))
}

export function dismissRaisedNotice(userDataPath: string, id: string): void {
  if (!raised.has(id)) return
  raised.delete(id)
  const dismissed = dismissedIds(userDataPath)
  if (dismissed.includes(id)) return
  try {
    writeFileSync(
      join(userDataPath, NOTICES_FILE),
      JSON.stringify({ dismissed: [...dismissed, id] }, null, 2),
      { mode: 0o600 }
    )
  } catch {
    /* best effort: the notice shows again on the next start */
  }
}
