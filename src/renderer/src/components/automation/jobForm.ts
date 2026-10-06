import type { Job, JobInput, JobTask, JobTaskType } from '@shared/types'
import {
  cronFromForm,
  defaultScheduleForm,
  formFromCron,
  isValidCron,
  type ScheduleForm
} from './schedule'

export interface JobDraft {
  id?: string
  name: string
  continueOnError: boolean
  tasks: JobTask[]
  scheduleEnabled: boolean
  launchAgent: boolean
  schedule: ScheduleForm
  source?: Job['source']
}

export const TASK_TYPES: { value: JobTaskType; title: string }[] = [
  { value: 'backupschema', title: 'Copia de seguridad' },
  { value: 'runquery', title: 'Ejecutar consulta' }
]

function randomId(): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `t-${Math.random().toString(36).slice(2)}`
}

export function newTask(type: JobTaskType, connectionId = '', schema = ''): JobTask {
  const task: JobTask = { id: randomId(), type, connectionId, schema, referenceName: '' }
  if (type === 'backupschema') task.includeData = true
  else task.sql = ''
  return task
}

/** Default reference name in Navicat style when the user leaves it empty. */
export function defaultReferenceName(task: JobTask): string {
  return task.type === 'backupschema'
    ? `Backup ${task.schema}`.trim()
    : `Consulta ${task.schema}`.trim()
}

export function emptyDraft(): JobDraft {
  return {
    name: '',
    continueOnError: true,
    tasks: [],
    scheduleEnabled: false,
    launchAgent: false,
    schedule: defaultScheduleForm()
  }
}

export function draftFromJob(job: Job): JobDraft {
  return {
    id: job.id,
    name: job.name,
    continueOnError: job.continueOnError,
    tasks: job.tasks.map((t) => ({ ...t })),
    scheduleEnabled: job.schedule.enabled,
    launchAgent: job.schedule.launchAgent,
    schedule: job.schedule.cron ? formFromCron(job.schedule.cron) : defaultScheduleForm(),
    source: job.source
  }
}

/** Client-side checks; the main process validates again and its messages are shown too. */
export function validateDraft(draft: JobDraft): string[] {
  const errors: string[] = []
  if (!draft.name.trim()) errors.push('El nombre de la tarea es obligatorio.')
  if (/[/\\:]/.test(draft.name)) errors.push('El nombre no puede contener "/", "\\" ni ":".')
  if (!draft.tasks.length) errors.push('Añade al menos una tarea.')
  draft.tasks.forEach((task, i) => {
    const n = i + 1
    if (!task.connectionId) errors.push(`Tarea ${n}: selecciona una conexión.`)
    // Mirrors main's validateJobInput: only backups need a schema (SQL tasks may run without one).
    if (task.type === 'backupschema' && !task.schema)
      errors.push(`Tarea ${n}: selecciona un esquema.`)
    if (task.type === 'runquery' && !task.sql?.trim())
      errors.push(`Tarea ${n}: escribe la consulta SQL a ejecutar.`)
  })
  const cron = cronFromForm(draft.schedule)
  if (draft.scheduleEnabled && !isValidCron(cron))
    errors.push(`La programación "${cron}" no es una expresión cron válida de 5 campos.`)
  return errors
}

export function buildJobInput(draft: JobDraft): JobInput {
  const input: JobInput = {
    name: draft.name.trim(),
    continueOnError: draft.continueOnError,
    tasks: draft.tasks.map((task) => {
      const out: JobTask = {
        id: task.id,
        type: task.type,
        connectionId: task.connectionId,
        schema: task.schema,
        referenceName: task.referenceName.trim() || defaultReferenceName(task)
      }
      if (task.type === 'backupschema') out.includeData = task.includeData !== false
      else out.sql = task.sql ?? ''
      return out
    }),
    schedule: {
      enabled: draft.scheduleEnabled,
      cron: cronFromForm(draft.schedule),
      launchAgent: draft.scheduleEnabled && draft.launchAgent
    }
  }
  if (draft.id) input.id = draft.id
  if (draft.source) input.source = draft.source
  return input
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}
