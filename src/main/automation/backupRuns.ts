import { resolve } from 'node:path'
import type { BackupRunRef, Job, JobRun, JobTaskRun, JobTaskType } from '@shared/types'
import type { AppContext } from '../context'
import { isBackupFileName } from '../backup/naming'

/**
 * Which automation run wrote each backup file, from the run history alone
 * (no archive is opened). Used to group the backups list into packages and
 * to attach file-based restores to the job that made the files.
 */

/** Max runs inspected (the repo keeps fewer). */
const SCAN_LIMIT = 100_000

/** Step type of a run task; older runs did not store it, so the job (or the file) decides. */
function typeOf(task: JobTaskRun, job: Job | null): JobTaskType | undefined {
  if (task.type) return task.type
  const def = job?.tasks.find((t) => t.id === task.taskId)
  if (def) return def.type
  return task.outputPath && isBackupFileName(task.outputPath) ? 'backupschema' : undefined
}

/** Backup steps of a run that produced a file (what a rollback can restore). */
export function restorableTasks(run: JobRun, job: Job | null): JobTaskRun[] {
  return run.tasks.filter(
    (t) => t.status === 'success' && !!t.outputPath && typeOf(t, job) === 'backupschema'
  )
}

/** Normalised key of a backup path (scan and run history may spell it differently). */
export const backupPathKey = (path: string): string => resolve(path)

/**
 * Run reference of every backup file in the history, keyed by backupPathKey.
 * Rollback runs are skipped (their outputs are safety copies, not job backups);
 * when two runs claim a path the newest wins.
 */
export function backupRunIndex(ctx: Pick<AppContext, 'runs' | 'jobs'>): Map<string, BackupRunRef> {
  const index = new Map<string, BackupRunRef>()
  if (!ctx.runs) return index
  const jobs = new Map<string, Job | null>()
  const jobOf = (id: string): Job | null => {
    if (!jobs.has(id)) jobs.set(id, ctx.jobs?.get(id) ?? null)
    return jobs.get(id)!
  }
  for (const run of ctx.runs.list(null, SCAN_LIMIT)) {
    if (run.kind === 'rollback') continue
    const job = jobOf(run.jobId)
    for (const task of restorableTasks(run, job)) {
      const key = backupPathKey(task.outputPath!)
      if (index.has(key)) continue
      const def = job?.tasks.find((t) => t.id === task.taskId)
      index.set(key, {
        runId: run.id,
        jobId: run.jobId,
        jobName: job?.name ?? run.jobName,
        startedAt: run.startedAt,
        taskId: task.taskId,
        includeData: (task.includeData ?? def?.includeData) !== false
      })
    }
  }
  return index
}
