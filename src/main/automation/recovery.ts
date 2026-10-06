import { statSync } from 'node:fs'
import { INTERRUPTED_MESSAGE, resultLine, stampLine, stepLabel, summaryLines } from '@shared/jobLog'
import type { JobRun } from '@shared/types'
import type { AppContext } from '../context'
import { RunLog } from './runLog'

/**
 * Runs left in `running`/`queued` by a process that no longer exists (crash,
 * force quit, `npm run dev` restarting the main process). They are closed as
 * interrupted so the UI stops showing them as live and the job can run again.
 */

export interface RecoveryOptions {
  /** True when this process is executing the run right now. */
  isActive(runId: string): boolean
  /** Liveness check of another process (tests). */
  isAlive?(pid: number): boolean
  now?: () => Date
}

/** Max runs inspected; the repo keeps fewer than this anyway. */
const SCAN_LIMIT = 100_000

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/** A running run nobody executes any more. Runs of another live process (launchd) are left alone. */
export function isStaleRun(run: JobRun, options: RecoveryOptions): boolean {
  if (run.status !== 'running' && run.status !== 'queued') return false
  if (options.isActive(run.id)) return false
  if (run.pid && run.pid !== process.pid && (options.isAlive ?? isProcessAlive)(run.pid))
    return false
  return true
}

/** Last time the run wrote to its log: the best guess of when it died. */
function lastActivity(run: JobRun): number {
  const started = Date.parse(run.startedAt) || 0
  try {
    return Math.max(started, statSync(run.logPath).mtimeMs)
  } catch {
    return started
  }
}

/** Closes one stale run as interrupted: tasks, final status, log lines, repo and renderer. */
export function markInterrupted(ctx: AppContext, stale: JobRun, now: () => Date): JobRun {
  const run = structuredClone(stale)
  const lastMs = lastActivity(run)
  const job = ctx.jobs.get(run.jobId)
  const log = new RunLog(run.logPath)
  const say = (body: string): void => log.write(stampLine(now(), body))

  let wasRunning = false
  for (const task of run.tasks) {
    if (task.status === 'running') {
      wasRunning = true
      task.status = 'failed'
      task.message = INTERRUPTED_MESSAGE
      task.finishedAt = new Date(lastMs).toISOString()
    } else if (task.status === 'queued') {
      task.status = 'cancelled'
      task.message = INTERRUPTED_MESSAGE
    }
  }
  run.status = 'failed'
  run.finishedAt = new Date(lastMs).toISOString()

  if (wasRunning) say(resultLine('ERROR', [INTERRUPTED_MESSAGE]))
  const lines = summaryLines({
    status: run.status,
    durationMs: lastMs - (Date.parse(run.startedAt) || lastMs),
    interrupted: true,
    steps: run.tasks.map((t, i) => {
      const task = job?.tasks.find((x) => x.id === t.taskId) ?? job?.tasks[i]
      const label = task
        ? stepLabel({
            type: task.type,
            schema: task.schema,
            connectionName: ctx.connections.get(task.connectionId)?.name ?? 'conexión desconocida',
            referenceName: task.referenceName
          })
        : t.referenceName
      return { index: i + 1, label, status: t.status, message: t.message }
    })
  })
  for (const line of lines) say(line)

  ctx.runs.upsert(run)
  try {
    ctx.emit('event:jobRun', structuredClone(run))
  } catch {
    /* no window yet: the renderer reads the runs when it loads */
  }
  return run
}

/** Closes every stale run; returns the recovered ones. */
export function recoverStaleRuns(ctx: AppContext, options: RecoveryOptions): JobRun[] {
  const now = options.now ?? (() => new Date())
  return ctx.runs
    .list(null, SCAN_LIMIT)
    .filter((run) => isStaleRun(run, options))
    .map((run) => markInterrupted(ctx, run, now))
}
