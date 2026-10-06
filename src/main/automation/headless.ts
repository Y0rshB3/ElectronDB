import type { AppContext } from '../context'
import { getLogger } from '../log'
import { getConnectionManager } from '../mysql/manager'
import { getAutomationService } from './index'

export const HEADLESS_EXIT = { success: 0, failure: 1, jobNotFound: 2 } as const

/** Closes MySQL pools/tunnels so the headless process can exit. */
async function closeConnections(ctx: AppContext): Promise<void> {
  try {
    await getConnectionManager(ctx).closeAll()
  } catch (err) {
    getLogger('headless').warn('could not close connections cleanly', err)
  }
}

/**
 * Entry point for `ElectronDB --run-job=<jobId>` (launchd agents). Runs the
 * job to completion and returns the process exit code.
 */
export async function runJobHeadless(ctx: AppContext, jobId: string): Promise<number> {
  const log = getLogger('headless')
  const job = ctx.jobs.get(jobId)
  if (!job) {
    log.error(`job ${jobId} not found`)
    return HEADLESS_EXIT.jobNotFound
  }
  const service = getAutomationService(ctx)
  try {
    const initial = await service.run(jobId, 'cli')
    const final = service.wait ? await service.wait(initial.id) : initial
    log.info(`job "${job.name}" finished with status ${final.status} (run ${final.id})`)
    return final.status === 'success' ? HEADLESS_EXIT.success : HEADLESS_EXIT.failure
  } catch (err) {
    log.error(`job "${job.name}" could not run`, err)
    return HEADLESS_EXIT.failure
  } finally {
    await service.stop()
    await closeConnections(ctx)
  }
}
