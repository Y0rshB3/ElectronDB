import type { ConnectionConfig, JobTask } from './types'

/**
 * Pure helpers for the production write guard, shared by main (enforcement)
 * and renderer (confirmation dialogs) so both sides agree on what is risky.
 */

/**
 * Distinct production connections targeted by tasks that write (runquery).
 * Backup tasks only read from the source, so they never need confirmation.
 */
export function productionWriteTargets(
  tasks: JobTask[],
  lookup: (id: string) => ConnectionConfig | null | undefined
): ConnectionConfig[] {
  const seen = new Map<string, ConnectionConfig>()
  for (const task of tasks) {
    if (task.type !== 'runquery' || !task.connectionId || seen.has(task.connectionId)) continue
    const connection = lookup(task.connectionId)
    if (connection?.environment === 'production') seen.set(connection.id, connection)
  }
  return [...seen.values()]
}

/** Signature of what makes a job risky; used to re-confirm only when it changes. */
export function productionRiskSignature(
  tasks: JobTask[],
  schedule: { enabled: boolean; cron: string },
  lookup: (id: string) => ConnectionConfig | null | undefined
): string {
  const targets = new Set(productionWriteTargets(tasks, lookup).map((c) => c.id))
  if (!targets.size) return ''
  const risky = tasks
    .filter((t) => t.type === 'runquery' && targets.has(t.connectionId))
    .map((t) => [t.connectionId, t.schema, t.sql ?? ''])
  return JSON.stringify({ schedule: schedule.enabled ? schedule.cron : null, risky })
}

/**
 * Leading keywords that always change data, structure or privileges. This is
 * deliberately a small denylist: the renderer asks for anything that is not
 * provably read-only, so main must never flag a statement the renderer would
 * let through without asking.
 */
const WRITE_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'DROP',
  'CREATE',
  'ALTER',
  'TRUNCATE',
  'RENAME',
  'GRANT',
  'REVOKE',
  'LOAD',
  'CALL',
  'IMPORT'
])

/** First keyword of a statement, skipping leading comments and whitespace. */
export function leadingKeyword(statement: string): string {
  let s = statement
  for (;;) {
    s = s.replace(/^\s+/, '')
    if (s.startsWith('/*') && !s.startsWith('/*!')) {
      const end = s.indexOf('*/', 2)
      s = end < 0 ? '' : s.slice(end + 2)
    } else if (s.startsWith('#') || /^--(\s|$)/.test(s)) {
      const end = s.indexOf('\n')
      s = end < 0 ? '' : s.slice(end + 1)
    } else break
  }
  const m = /^[A-Za-z]+/.exec(s)
  return m ? m[0].toUpperCase() : ''
}

/** True when the statement obviously writes (see WRITE_KEYWORDS). */
export function isObviousWrite(statement: string): boolean {
  return WRITE_KEYWORDS.has(leadingKeyword(statement))
}
