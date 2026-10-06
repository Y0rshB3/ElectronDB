import { readFile } from 'node:fs/promises'
import { getAutomationService } from '../automation/index'
import {
  buildAnyRollbackPlan,
  createRollbackInspector,
  isFilesRequest,
  prepareRollback
} from '../automation/rollback'
import type { AppContext } from '../context'
import {
  assertJobRunAllowed,
  assertJobSaveAllowed,
  assertProductionWriteConfirmed
} from './productionGuard'
import { assertRestoreStepsAllowed, validateJobInput } from './jobValidation'
import { handle } from './typed'

export { assertRestoreStepsAllowed, validateJobInput } from './jobValidation'

const NO_LOG = 'Sin registro'

export function registerJobsHandlers(ctx: AppContext): void {
  const automation = getAutomationService(ctx)
  const lookup = (id: string) => ctx.connections.get(id)
  // The mysql manager is loaded lazily so registering handlers stays cheap.
  const inspector = () =>
    createRollbackInspector(ctx, async () =>
      (await import('../mysql/manager')).getSessionFactory(ctx)
    )

  handle('jobs:list', () => ctx.jobs.list())
  handle('jobs:get', (id) => ctx.jobs.get(id))
  handle('jobs:save', async (input, options) => {
    validateJobInput(input, lookup)
    assertJobSaveAllowed(ctx, input, input.id ? ctx.jobs.get(input.id) : null, options)
    const job = ctx.jobs.save({ ...input, name: input.name.trim() })
    await automation.resync?.(job.id)
    return job
  })
  handle('jobs:delete', async (id) => {
    ctx.jobs.delete(id)
    // resync of a missing job drops its timer and removes its launch agent
    await automation.resync?.(id)
  })
  handle('jobs:run', (id, options) => {
    const job = ctx.jobs.get(id)
    if (job) {
      assertJobRunAllowed(ctx, job, options)
      // Restore steps stay refused on production even when the user runs the job by hand
      // (the runner refuses them again for scheduled and launchd runs).
      assertRestoreStepsAllowed(job, lookup)
    }
    return automation.run(id, 'manual')
  })
  handle('jobs:cancel', (runId) => automation.cancel(runId))
  handle('jobs:runs', (jobId, limit) => ctx.runs.list(jobId, limit))
  handle('jobs:runLog', async (runId) => {
    const run = ctx.runs.get(runId)
    if (!run) return NO_LOG
    try {
      return await readFile(run.logPath, 'utf8')
    } catch {
      return NO_LOG
    }
  })
  handle('jobs:rollbackPlan', (source, targetConnectionId) =>
    buildAnyRollbackPlan(ctx, source, targetConnectionId, inspector())
  )
  handle('jobs:rollback', async (request, options) => {
    if (!request || typeof request !== 'object') throw new Error('Restauración no válida.')
    const target = ctx.connections.get(request.targetConnectionId)
    if (!target) throw new Error('Selecciona la conexión de destino.')
    // Replacing databases is a write: production needs the typed confirmation.
    assertProductionWriteConfirmed(
      ctx,
      target.id,
      options,
      'Reemplazar bases de datos con copias de seguridad'
    )
    if (!automation.runPrepared) throw new Error('La restauración no está disponible.')
    // The plan is rebuilt here from the request: paths are validated again and
    // every file re-read, whatever the renderer showed.
    const plan = await buildAnyRollbackPlan(
      ctx,
      isFilesRequest(request)
        ? {
            source: 'files',
            backupPaths: request.backupPaths,
            sourceConnectionId: request.sourceConnectionId,
            title: request.title
          }
        : request.runId,
      target.id,
      inspector()
    )
    const prepared = prepareRollback(
      ctx,
      plan,
      request,
      target,
      options?.confirmProduction === true || ctx.settings.get().confirmProductionWrites === false
    )
    return automation.runPrepared(prepared.job, 'manual', prepared.options)
  })
  handle('jobs:scheduleStatus', (id) => {
    if (!automation.scheduleStatus) return { inApp: false, launchAgent: false, nextRun: null }
    return automation.scheduleStatus(id)
  })
}
