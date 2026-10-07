import { requiresTypedConfirm } from './typedConfirm'
import type { ConnectionConfig, Environment, JobTask } from './types'

/**
 * Pure helpers for the write guard ("production guard"), shared by main
 * (enforcement) and renderer (confirmation dialogs) so both sides agree on
 * what is risky. The guard covers production plus every environment listed
 * in AppSettings.typedConfirmEnvironments (see ./typedConfirm).
 */

type Lookup = (id: string) => ConnectionConfig | null | undefined

/**
 * Distinct connections that need the typed confirmation (production and the
 * environments in `environments`) targeted by tasks that write (runquery).
 * Backup tasks only read from the source, so they never need confirmation.
 */
export function guardedWriteTargets(
  tasks: JobTask[],
  lookup: Lookup,
  environments: readonly Environment[]
): ConnectionConfig[] {
  const seen = new Map<string, ConnectionConfig>()
  for (const task of tasks) {
    if (task.type !== 'runquery' || !task.connectionId || seen.has(task.connectionId)) continue
    const connection = lookup(task.connectionId)
    if (connection && requiresTypedConfirm(connection.environment, environments))
      seen.set(connection.id, connection)
  }
  return [...seen.values()]
}

/** Signature of what makes a job risky; used to re-confirm only when it changes. */
export function guardedRiskSignature(
  tasks: JobTask[],
  schedule: { enabled: boolean; cron: string },
  lookup: Lookup,
  environments: readonly Environment[]
): string {
  const targets = new Set(guardedWriteTargets(tasks, lookup, environments).map((c) => c.id))
  if (!targets.size) return ''
  const risky = tasks
    .filter((t) => t.type === 'runquery' && targets.has(t.connectionId))
    .map((t) => [t.connectionId, t.schema, t.sql ?? ''])
  return JSON.stringify({ schedule: schedule.enabled ? schedule.cron : null, risky })
}

/**
 * Statement classification moved to the MySQL dialect
 * (src/shared/dialects/mysql.ts) in P1a; re-exported here for one phase.
 */
export { isObviousWrite, leadingKeyword } from './dialects/mysql'
