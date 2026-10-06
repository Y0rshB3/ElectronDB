import { readFile } from 'node:fs/promises'
import type { JobInput } from '@shared/types'
import { getAutomationService } from '../automation/index'
import { cronToCalendarIntervals, validateCron } from '../automation/cron'
import type { AppContext } from '../context'
import { assertJobRunAllowed, assertJobSaveAllowed } from './productionGuard'
import { handle } from './typed'

const NO_LOG = 'Sin registro'

/** Boundary validation for jobs:save; throws actionable Spanish messages. */
export function validateJobInput(input: JobInput): void {
  if (!input || typeof input !== 'object') throw new Error('Datos del trabajo no válidos.')
  if (!input.name || !input.name.trim()) throw new Error('El nombre del trabajo es obligatorio.')
  if (!Array.isArray(input.tasks)) throw new Error('El trabajo debe incluir una lista de pasos.')
  input.tasks.forEach((task, i) => {
    const label = task?.referenceName?.trim() || `paso ${i + 1}`
    if (task.type !== 'backupschema' && task.type !== 'runquery') {
      throw new Error(`El ${label} tiene un tipo desconocido.`)
    }
    if (!task.connectionId) throw new Error(`El ${label} necesita una conexión.`)
    if (task.type === 'backupschema' && !task.schema?.trim()) {
      throw new Error(`El ${label} necesita un esquema para la copia de seguridad.`)
    }
    if (task.type === 'runquery' && !task.sql?.trim())
      throw new Error(`El ${label} necesita al menos una sentencia SQL.`)
  })
  const schedule = input.schedule
  if (!schedule)
    throw new Error('El trabajo debe incluir una programación (puede estar desactivada).')
  if (schedule.enabled || schedule.cron?.trim()) {
    const error = validateCron(schedule.cron ?? '')
    if (error) throw new Error(error)
    if (schedule.launchAgent) cronToCalendarIntervals(schedule.cron)
  }
}

export function registerJobsHandlers(ctx: AppContext): void {
  const automation = getAutomationService(ctx)

  handle('jobs:list', () => ctx.jobs.list())
  handle('jobs:get', (id) => ctx.jobs.get(id))
  handle('jobs:save', async (input, options) => {
    validateJobInput(input)
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
    if (job) assertJobRunAllowed(ctx, job, options)
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
  handle('jobs:scheduleStatus', (id) => {
    if (!automation.scheduleStatus) return { inApp: false, launchAgent: false, nextRun: null }
    return automation.scheduleStatus(id)
  })
}
