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
  assertProductionWriteConfirmed,
  typedConfirmEnvironments
} from './productionGuard'
import { assertJobPassword, assertRestoreStepsAllowed, validateJobInput } from './jobValidation'
import { handle } from './typed'
import { BACKUP_KEY, hasJobBackupPassword, setJobBackupPassword } from '../automation/backupKeys'
import { checkBackupPassword } from '../backup/create'
import type { Job } from '@shared/types'

export { assertRestoreStepsAllowed, validateJobInput } from './jobValidation'

const NO_LOG = 'Sin registro'

export function registerJobsHandlers(ctx: AppContext): void {
  const automation = getAutomationService(ctx)
  const lookup = (id: string) => ctx.connections.get(id)
  // The connection manager is loaded lazily so registering handlers stays cheap.
  const inspector = () =>
    createRollbackInspector(ctx, async () => (await import('../db/manager')).getSessionFactory(ctx))

  // Whether a backup password is stored: the password itself never leaves main.
  const withKeyFlag = (job: Job): Job => ({
    ...job,
    hasBackupPassword: hasJobBackupPassword(ctx, job.id)
  })

  handle('jobs:list', () => ctx.jobs.list().map(withKeyFlag))
  handle('jobs:get', (id) => {
    const job = ctx.jobs.get(id)
    return job ? withKeyFlag(job) : null
  })
  handle('jobs:save', async (input, options) => {
    validateJobInput(input, lookup, typedConfirmEnvironments(ctx))
    assertJobSaveAllowed(ctx, input, input.id ? ctx.jobs.get(input.id) : null, options)
    assertJobPassword(input, !!input.id && hasJobBackupPassword(ctx, input.id))
    const password = input.backupPassword
    if (typeof password === 'string' && password !== '') checkBackupPassword(password)
    // Neither the password nor the flag is ever stored in jobs.json.
    const { backupPassword: _password, ...rest } = input
    void _password
    delete (rest as { hasBackupPassword?: boolean }).hasBackupPassword
    const job = ctx.jobs.save({ ...rest, name: input.name.trim() })
    if (typeof password === 'string' && password !== '') setJobBackupPassword(ctx, job.id, password)
    else if (password === null) ctx.credentials.set(BACKUP_KEY, job.id, null)
    await automation.resync?.(job.id)
    return withKeyFlag(job)
  })
  handle('jobs:delete', async (id) => {
    ctx.jobs.delete(id)
    ctx.credentials.set(BACKUP_KEY, id, null)
    // resync of a missing job drops its timer and removes its launch agent
    await automation.resync?.(id)
  })
  handle('jobs:run', (id, options) => {
    const job = ctx.jobs.get(id)
    if (job) {
      assertJobRunAllowed(ctx, job, options)
      // Restore steps stay refused on production (and on the environments that need the typed
      // name) even when the user runs the job by hand; the runner refuses them again for
      // scheduled and launchd runs.
      assertRestoreStepsAllowed(job, lookup, typedConfirmEnvironments(ctx))
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
  handle('jobs:rollbackPlan', (source, targetConnectionId, password) =>
    buildAnyRollbackPlan(ctx, source, targetConnectionId, inspector(), password ?? null)
  )
  handle('jobs:rollback', async (request, options) => {
    if (!request || typeof request !== 'object') throw new Error('Restauración no válida.')
    const target = ctx.connections.get(request.targetConnectionId)
    if (!target) throw new Error('Selecciona la conexión de destino.')
    // Replacing databases is a write: guarded connections need the typed confirmation.
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
      inspector(),
      request.password ?? null
    )
    const prepared = prepareRollback(
      ctx,
      plan,
      request,
      target,
      options?.confirmProduction === true
    )
    return automation.runPrepared(prepared.job, 'manual', prepared.options)
  })
  handle('jobs:scheduleStatus', (id) => {
    if (!automation.scheduleStatus) return { inApp: false, launchAgent: false, nextRun: null }
    return automation.scheduleStatus(id)
  })
}
