import { restoreTaskProblem } from '@shared/restoreTask'
import type { ConnectionConfig, JobInput } from '@shared/types'
import { cronToCalendarIntervals, validateCron } from '../automation/cron'

/** jobs:save / jobs:run validation; free of electron so it is unit tested. */

const TASK_TYPES = new Set(['backupschema', 'runquery', 'restoreschema'])

/**
 * Boundary validation for jobs:save; throws actionable Spanish messages.
 * `lookup` resolves connections for the restore rules (a restore step may
 * never target production: nobody confirms scheduled or launchd runs).
 */
export function validateJobInput(
  input: JobInput,
  lookup: (id: string) => ConnectionConfig | null | undefined = () => null
): void {
  if (!input || typeof input !== 'object') throw new Error('Datos del trabajo no válidos.')
  if (!input.name || !input.name.trim()) throw new Error('El nombre del trabajo es obligatorio.')
  if (!Array.isArray(input.tasks)) throw new Error('El trabajo debe incluir una lista de pasos.')
  input.tasks.forEach((task, i) => {
    const label = task?.referenceName?.trim() || `paso ${i + 1}`
    if (!TASK_TYPES.has(task?.type)) {
      throw new Error(`El ${label} tiene un tipo desconocido.`)
    }
    if (!task.connectionId) throw new Error(`El ${label} necesita una conexión.`)
    if (task.type === 'backupschema' && !task.schema?.trim()) {
      throw new Error(`El ${label} necesita un esquema para la copia de seguridad.`)
    }
    if (task.type === 'runquery' && !task.sql?.trim())
      throw new Error(`El ${label} necesita al menos una sentencia SQL.`)
    if (task.type === 'restoreschema') {
      const problem = restoreTaskProblem(task, input.tasks, lookup, label)
      if (problem) throw new Error(problem)
    }
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

/** Restore rules only (the target may have become production after the job was saved). */
export function assertRestoreStepsAllowed(
  job: Pick<JobInput, 'tasks'>,
  lookup: (id: string) => ConnectionConfig | null | undefined
): void {
  job.tasks.forEach((task, i) => {
    if (task.type !== 'restoreschema') return
    const problem = restoreTaskProblem(
      task,
      job.tasks,
      lookup,
      task.referenceName?.trim() || `paso ${i + 1}`
    )
    if (problem) throw new Error(problem)
  })
}
