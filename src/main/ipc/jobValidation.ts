import { restoreTaskProblem } from '@shared/restoreTask'
import type { ConnectionConfig, Environment, JobInput } from '@shared/types'
import { cronToCalendarIntervals, validateCron } from '../automation/cron'
import { CAPABILITY_MESSAGES, requireConnectionCapability } from '../db/errors'

/** jobs:save / jobs:run validation; free of electron so it is unit tested. */

const TASK_TYPES = new Set(['backupschema', 'runquery', 'restoreschema'])

/**
 * Boundary validation for jobs:save; throws actionable Spanish messages.
 * `lookup` resolves connections for the restore rules (a restore step may
 * never target production, nor an environment in `typedEnvironments`: nobody
 * types the connection name in scheduled or launchd runs). A step whose
 * connection exists but whose engine has no automation (anything but MySQL,
 * docs/multi-engine-design.md section 11) is refused; a missing connection is
 * left to the run, as before.
 */
export function validateJobInput(
  input: JobInput,
  lookup: (id: string) => ConnectionConfig | null | undefined = () => null,
  typedEnvironments: readonly Environment[] = []
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
    if (
      task.format !== undefined &&
      task.format !== 'vqb' &&
      task.format !== 'nb3' &&
      task.format !== 'sql'
    )
      throw new Error(`El ${label} tiene un formato de copia desconocido (usa .vqb, .nb3 o .sql).`)
    if (task.encrypt && (task.type !== 'backupschema' || task.format !== 'vqb'))
      throw new Error(`El ${label} solo puede cifrarse si es una copia en formato .vqb.`)
    if (task.type === 'runquery' && !task.sql?.trim())
      throw new Error(`El ${label} necesita al menos una sentencia SQL.`)
    const connection = lookup(task.connectionId)
    if (connection)
      requireConnectionCapability(connection, 'supportsAutomation', CAPABILITY_MESSAGES.automation)
    if (task.type === 'restoreschema') {
      const problem = restoreTaskProblem(task, input.tasks, lookup, label, { typedEnvironments })
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

export const JOB_PASSWORD_REQUIRED =
  'La tarea cifra sus copias .vqb: escribe la contraseña de cifrado (al menos 8 caracteres).'

/**
 * A job with encrypted steps needs a backup password: the one sent with the
 * input, or the one already stored (`hasStored`) when the input keeps it.
 */
export function assertJobPassword(input: JobInput, hasStored: boolean): void {
  const encrypts = (input.tasks ?? []).some((t) => t?.type === 'backupschema' && t.encrypt)
  if (!encrypts) return
  const given = typeof input.backupPassword === 'string' && input.backupPassword !== ''
  const kept = input.backupPassword === undefined && hasStored
  if (!given && !kept) throw new Error(JOB_PASSWORD_REQUIRED)
}

/**
 * Restore rules only (the target may have become production, or its
 * environment may have been added to the typed list, after the job was saved).
 */
export function assertRestoreStepsAllowed(
  job: Pick<JobInput, 'tasks'>,
  lookup: (id: string) => ConnectionConfig | null | undefined,
  typedEnvironments: readonly Environment[] = []
): void {
  job.tasks.forEach((task, i) => {
    if (task.type !== 'restoreschema') return
    const problem = restoreTaskProblem(
      task,
      job.tasks,
      lookup,
      task.referenceName?.trim() || `paso ${i + 1}`,
      { typedEnvironments }
    )
    if (problem) throw new Error(problem)
  })
}
