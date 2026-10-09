import type { Job, JobPackageCopy, JobPackageSummary, JobRun } from '@shared/types'
import type { AppContext } from '../context'
import { isBackupFileName } from '../backup/naming'
import { restorableTasks } from './backupRuns'

/**
 * Packages of the job editor's «Restaurar paquete» steps: the copies one run
 * of a job made together, read from the run history alone (no archive is
 * opened). The latest package of a job is its newest successful run (never a
 * rollback) with at least one restorable copy (.vqb/.nb3); only a job that
 * never finished a run well falls back to its newest partial package.
 */

/** Max runs inspected (the repo keeps fewer). */
const SCAN_LIMIT = 100_000

const isLive = (run: JobRun): boolean => run.status === 'running' || run.status === 'queued'

/** Restorable copies a run made, in step order. */
export function packageCopies(run: JobRun, job: Job | null): JobPackageCopy[] {
  return restorableTasks(run, job)
    .filter((t) => t.format !== 'sql' && isBackupFileName(t.outputPath!))
    .map((t) => {
      const def = job?.tasks.find((x) => x.id === t.taskId)
      return {
        schema: t.schema ?? def?.schema ?? '',
        connectionId: t.connectionId ?? def?.connectionId ?? null,
        taskId: t.taskId,
        path: t.outputPath!,
        structureOnly: (t.includeData ?? def?.includeData) === false,
        encrypted: t.encrypted === true || (def?.format === 'vqb' && def.encrypt === true)
      }
    })
    .filter((c) => !!c.schema)
}

export interface LatestJobPackage {
  run: JobRun
  copies: JobPackageCopy[]
}

/** Newest package of `jobId`, or null when none of its finished runs made a restorable copy. */
export function latestJobPackage(
  ctx: Pick<AppContext, 'runs' | 'jobs'>,
  jobId: string
): LatestJobPackage | null {
  const job = ctx.jobs.get(jobId)
  // A complete package (a run that ended well) wins over a newer partial one; a
  // partial package is used only when the job never finished a run.
  let partial: LatestJobPackage | null = null
  for (const run of ctx.runs.list(jobId, SCAN_LIMIT)) {
    if (run.kind === 'rollback' || isLive(run)) continue
    const copies = packageCopies(run, job)
    if (!copies.length) continue
    if (run.status === 'success') return { run, copies }
    partial ??= { run, copies }
  }
  return partial
}

/** Every job with restorable backup steps or packages (jobs:packages), sorted by name. */
export function jobPackageSummaries(ctx: Pick<AppContext, 'runs' | 'jobs'>): JobPackageSummary[] {
  const out: JobPackageSummary[] = []
  for (const job of ctx.jobs.list()) {
    const steps = job.tasks
      .filter((t) => t.type === 'backupschema' && t.format !== 'sql' && !!t.schema)
      .map((t) => ({
        schema: t.schema,
        connectionId: t.connectionId,
        includeData: t.includeData !== false
      }))
    const latest = latestJobPackage(ctx, job.id)
    if (!steps.length && !latest) continue
    out.push({
      jobId: job.id,
      jobName: job.name,
      steps,
      latest: latest
        ? {
            runId: latest.run.id,
            startedAt: latest.run.startedAt,
            status: latest.run.status,
            copies: latest.copies
          }
        : null
    })
  }
  return out.sort((a, b) => a.jobName.localeCompare(b.jobName, 'es'))
}
