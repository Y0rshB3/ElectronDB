import { stat } from 'node:fs/promises'
import { fileNameOf } from '@shared/jobLog'
import type { Job, JobRun, JobTaskRun } from '@shared/types'
import type { AppContext } from '../context'

/**
 * «Última copia en disco» of a restore step: the newest COMPLETE backup of a
 * schema, i.e. the output of a successful backup step (all objects, with
 * data) of a job run on that very connection whose file still exists.
 *
 * The run history is the only reliable record of how a file was made: a
 * folder scan cannot tell a structure-only, partial (object subset), manual
 * or Navicat backup from a full one, nor which connection wrote a file when
 * two connections share a backup folder.
 */

export interface LatestBackup {
  path: string
  fileName: string
  runId: string
  jobName: string
  startedAt: string
}

/** Max runs inspected (the repo keeps fewer). */
const SCAN_LIMIT = 100_000

const exists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Backup step facts of a run task; older runs did not store them, the job fills the gaps. */
function backupFacts(
  task: JobTaskRun,
  job: Job | null
): { connectionId?: string; schema?: string; includeData: boolean } | null {
  const def = job?.tasks.find((t) => t.id === task.taskId)
  const type = task.type ?? def?.type
  if (type !== 'backupschema') return null
  return {
    connectionId: task.connectionId ?? def?.connectionId,
    schema: task.schema ?? def?.schema,
    includeData: (task.includeData ?? def?.includeData) !== false
  }
}

export async function findLatestJobBackup(
  ctx: Pick<AppContext, 'runs' | 'jobs'>,
  connectionId: string,
  schema: string,
  fileExists: (path: string) => Promise<boolean> = exists
): Promise<LatestBackup | null> {
  const runs: JobRun[] = ctx.runs.list(null, SCAN_LIMIT)
  for (const run of runs) {
    if (run.kind === 'rollback') continue
    const job = ctx.jobs.get(run.jobId)
    for (const task of [...run.tasks].reverse()) {
      if (task.status !== 'success' || !task.outputPath) continue
      const facts = backupFacts(task, job)
      if (!facts || !facts.includeData) continue
      if (facts.connectionId !== connectionId || facts.schema !== schema) continue
      if (!(await fileExists(task.outputPath))) continue
      return {
        path: task.outputPath,
        fileName: fileNameOf(task.outputPath),
        runId: run.id,
        jobName: run.jobName,
        startedAt: run.startedAt
      }
    }
  }
  return null
}
