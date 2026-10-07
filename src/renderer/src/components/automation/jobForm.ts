import { restoreSourceOf, restoreTaskProblem } from '@shared/restoreTask'
import type {
  ConnectionConfig,
  Environment,
  Job,
  JobInput,
  JobTask,
  JobTaskType
} from '@shared/types'
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
  { value: 'runquery', title: 'Ejecutar consulta' },
  { value: 'restoreschema', title: 'Restaurar' }
]

export const TASK_ICONS: Record<JobTaskType, string> = {
  backupschema: 'mdi-archive-outline',
  runquery: 'mdi-console-line',
  restoreschema: 'mdi-backup-restore'
}

function randomId(): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `t-${Math.random().toString(36).slice(2)}`
}

export function newTask(type: JobTaskType, connectionId = '', schema = ''): JobTask {
  const task: JobTask = { id: randomId(), type, connectionId, schema, referenceName: '' }
  if (type === 'backupschema') task.includeData = true
  else if (type === 'restoreschema') {
    task.restoreSource = { kind: 'task', taskId: '' }
    task.safetyBackup = true
    task.includeData = true
  } else task.sql = ''
  return task
}

/**
 * New restore step placed after `tasks`: restores the last backup step that no
 * restore uses yet, into the first local connection (never a production one).
 */
export function newRestoreTask(
  tasks: JobTask[],
  connections: ConnectionConfig[],
  /** Targets a restore step may not use (connections that need the typed name). */
  blocked: (connection: ConnectionConfig) => boolean = () => false
): JobTask {
  const used = new Set(
    tasks.flatMap((t) =>
      t.type === 'restoreschema' && t.restoreSource?.kind === 'task' ? [t.restoreSource.taskId] : []
    )
  )
  const backups = tasks.filter((t) => t.type === 'backupschema')
  const source = [...backups].reverse().find((t) => !used.has(t.id)) ?? backups[backups.length - 1]
  const local = connections.find((c) => c.environment === 'local' && !blocked(c))
  const task = newTask('restoreschema', local?.id ?? '', '')
  task.restoreSource = { kind: 'task', taskId: source?.id ?? '' }
  return task
}

/** Default reference name («Backup <schema>», «Restaurar <schema>») when the user leaves it empty. */
export function defaultReferenceName(task: JobTask, tasks: JobTask[] = []): string {
  if (task.type === 'backupschema') return `Backup ${task.schema}`.trim()
  if (task.type === 'restoreschema')
    return `Restaurar ${task.schema || restoreSourceOf(task, tasks)?.schema || ''}`.trim()
  return `Consulta ${task.schema}`.trim()
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
export function validateDraft(
  draft: JobDraft,
  lookup: (id: string) => ConnectionConfig | null | undefined = () => null,
  typedEnvironments: readonly Environment[] = []
): string[] {
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
    if (task.type === 'restoreschema' && task.connectionId) {
      // Same rules as main (production targets, targets in the typed-confirmation environments
      // and self-restores are refused).
      const named = {
        ...task,
        referenceName: task.referenceName.trim() || defaultReferenceName(task, draft.tasks)
      }
      const problem = restoreTaskProblem(named, draft.tasks, lookup, `paso ${n}`, {
        typedEnvironments
      })
      if (problem) errors.push(problem)
    }
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
        referenceName: task.referenceName.trim() || defaultReferenceName(task, draft.tasks)
      }
      if (task.type === 'backupschema') out.includeData = task.includeData !== false
      else if (task.type === 'restoreschema') {
        out.schema = task.schema.trim()
        if (task.restoreSource) out.restoreSource = { ...task.restoreSource }
        out.safetyBackup = task.safetyBackup !== false
        // Absent in jobs saved before 0.1.6: structure and data.
        out.includeData = task.includeData !== false
      } else out.sql = task.sql ?? ''
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
