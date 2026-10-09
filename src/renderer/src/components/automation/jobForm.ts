import { backupFamilyOf, jobStepEngineProblem } from '@shared/jobEngines'
import { naturalStepName, type ConnectionName } from '@shared/jobRecipes'
import { restoreSourceOf, restoreTaskProblem } from '@shared/restoreTask'
import { restorePackageProblem } from '@shared/restorePackage'
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
  /** A backup password is stored for this job (the password itself never reaches the renderer). */
  hasBackupPassword: boolean
  /** New password for the encrypted .vqb steps ('' = keep the stored one). */
  backupPassword: string
  backupPasswordAgain: string
}

export const MIN_BACKUP_PASSWORD = 8

/** The job has backup steps that encrypt their .vqb. */
export const encryptsBackups = (tasks: JobTask[]): boolean =>
  tasks.some((t) => t.type === 'backupschema' && t.format === 'vqb' && t.encrypt === true)

export const TASK_TYPES: { value: JobTaskType; title: string }[] = [
  { value: 'backupschema', title: 'Copia de seguridad' },
  { value: 'runquery', title: 'Ejecutar consulta' },
  { value: 'restoreschema', title: 'Restaurar' },
  { value: 'restorepackage', title: 'Restaurar paquete' }
]

export const TASK_ICONS: Record<JobTaskType, string> = {
  backupschema: 'mdi-archive-outline',
  runquery: 'mdi-console-line',
  restoreschema: 'mdi-backup-restore',
  restorepackage: 'mdi-package-variant-closed'
}

/** Id of a new step. */
export function newStepId(): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `t-${Math.random().toString(36).slice(2)}`
}

export function newTask(type: JobTaskType, connectionId = '', schema = ''): JobTask {
  const task: JobTask = { id: newStepId(), type, connectionId, schema, referenceName: '' }
  if (type === 'backupschema') {
    task.includeData = true
    // New steps write .vqb (Vortaq's own format); saved steps without a format stay .nb3.
    task.format = 'vqb'
  } else if (type === 'restoreschema') {
    task.restoreSource = { kind: 'task', taskId: '' }
    task.safetyBackup = true
    task.includeData = true
  } else if (type === 'restorepackage') {
    // Every database of this job's package (also those added later), same names.
    task.packageSource = { kind: 'own' }
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
  // A copy restores into a connection of its own engine (MySQL and MariaDB share one).
  const from = source ? connections.find((c) => c.id === source.connectionId) : undefined
  const family = from ? backupFamilyOf(from.engine) : null
  const candidates = connections.filter(
    (c) =>
      c.environment === 'local' && !blocked(c) && (!family || backupFamilyOf(c.engine) === family)
  )
  // Restoring a copy onto the connection it came from (same name) is refused: prefer another.
  const local = preferredTarget(candidates, source ? [source.connectionId] : [], from?.engine)
  const task = newTask('restoreschema', local?.id ?? '', '')
  task.restoreSource = { kind: 'task', taskId: source?.id ?? '' }
  return task
}

/**
 * Default restore target among `candidates` (already filtered): a connection
 * the copies do not come from, then one of the same engine as the copies
 * (MySQL before MariaDB for a MySQL copy), keeping the list order otherwise.
 */
function preferredTarget(
  candidates: ConnectionConfig[],
  sources: string[],
  engine: ConnectionConfig['engine'] | undefined
): ConnectionConfig | undefined {
  const rank = (c: ConnectionConfig): number =>
    (sources.includes(c.id) ? 2 : 0) + (engine && c.engine !== engine ? 1 : 0)
  return [...candidates].sort((a, b) => rank(a) - rank(b))[0]
}

/**
 * «Restaurar paquete» step of `source` (this job's package or another job's
 * latest one), into the first local connection of `family` that does not need
 * the typed name, preferably not one the copies come from (changed in its
 * settings). `databases` absent = all of them.
 */
export function newPackageTask(
  source: NonNullable<JobTask['packageSource']>,
  connections: ConnectionConfig[],
  blocked: (connection: ConnectionConfig) => boolean,
  family: ReturnType<typeof backupFamilyOf> | null,
  databases?: string[],
  /** Connections the copies come from: another local connection is preferred as target. */
  sources: string[] = []
): JobTask {
  const candidates = connections.filter(
    (c) =>
      c.environment === 'local' && !blocked(c) && (!family || backupFamilyOf(c.engine) === family)
  )
  const engine = connections.find((c) => sources.includes(c.id))?.engine
  const local = preferredTarget(candidates, sources, engine)
  const task = newTask('restorepackage', local?.id ?? '', '')
  task.packageSource = { ...source }
  if (databases) task.packageDatabases = [...databases]
  return task
}

/**
 * Default reference name when the user leaves it empty. With the connection
 * names: «Copia de ventas (Staging)», «Restaurar ventas en Local»; without
 * them, the names of earlier versions («Backup <bd>», «Restaurar <bd>»).
 */
export function defaultReferenceName(
  task: JobTask,
  tasks: JobTask[] = [],
  nameOf?: ConnectionName,
  jobName?: (id: string) => string | undefined
): string {
  if (nameOf && task.type !== 'runquery') return naturalStepName(task, tasks, nameOf, jobName)
  if (task.type === 'restorepackage') return naturalStepName(task, tasks, () => '', jobName)
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
    schedule: defaultScheduleForm(),
    hasBackupPassword: false,
    backupPassword: '',
    backupPasswordAgain: ''
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
    source: job.source,
    hasBackupPassword: job.hasBackupPassword === true,
    backupPassword: '',
    backupPasswordAgain: ''
  }
}

type Lookup = (id: string) => ConnectionConfig | null | undefined

/**
 * The step's name was made by Vortaq (empty, or a default name for its current
 * connection, database and source): it follows the step when they change.
 */
export function hasAutoName(task: JobTask, tasks: JobTask[], nameOf: ConnectionName): boolean {
  const name = task.referenceName.trim()
  return (
    !name ||
    name === defaultReferenceName(task, tasks) ||
    name === defaultReferenceName(task, tasks, nameOf)
  )
}

/**
 * Problems of one step (same messages and order as validateDraft), so the
 * sequence can show them on the step's row. `index` is the step's position.
 */
export function taskProblems(
  task: JobTask,
  index: number,
  tasks: JobTask[],
  lookup: Lookup = () => null,
  typedEnvironments: readonly Environment[] = []
): string[] {
  const errors: string[] = []
  const n = index + 1
  if (!task.connectionId) errors.push(`Paso ${n}: selecciona una conexión.`)
  // Mirrors main's validateJobInput: only backups need a schema (SQL tasks may run without one).
  if (task.type === 'backupschema' && !task.schema)
    errors.push(`Paso ${n}: selecciona la base de datos.`)
  if (task.type === 'runquery' && !task.sql?.trim())
    errors.push(`Paso ${n}: escribe la consulta SQL a ejecutar.`)
  // Same per-engine rules as main (restore steps get them through restoreTaskProblem).
  if (task.type !== 'restoreschema' && task.type !== 'restorepackage') {
    const problem = jobStepEngineProblem(task, tasks, lookup, `paso ${n}`)
    if (problem) errors.push(problem)
  }
  if (task.type === 'restoreschema' && task.connectionId) {
    // Same rules as main (production targets, targets in the typed-confirmation environments
    // and self-restores are refused).
    const named = {
      ...task,
      referenceName: task.referenceName.trim() || defaultReferenceName(task, tasks)
    }
    const problem = restoreTaskProblem(named, tasks, lookup, `paso ${n}`, { typedEnvironments })
    if (problem) errors.push(problem)
  }
  if (task.type === 'restorepackage' && task.connectionId) {
    const named = {
      ...task,
      referenceName: task.referenceName.trim() || defaultReferenceName(task, tasks)
    }
    const problem = restorePackageProblem(named, tasks, lookup, `paso ${n}`, { typedEnvironments })
    if (problem) errors.push(problem)
  }
  return errors
}

/** Problems of every step by step id (steps without problems are left out). */
export function problemsByTask(
  tasks: JobTask[],
  lookup: Lookup = () => null,
  typedEnvironments: readonly Environment[] = []
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  tasks.forEach((task, i) => {
    const problems = taskProblems(task, i, tasks, lookup, typedEnvironments)
    if (problems.length) out[task.id] = problems
  })
  return out
}

/** Problem of the job's backup password, or null. */
export function backupPasswordProblem(draft: JobDraft): string | null {
  if (!encryptsBackups(draft.tasks) && !draft.backupPassword) return null
  const typed = draft.backupPassword ?? ''
  if (!typed && !draft.hasBackupPassword)
    return 'Escribe la contraseña de cifrado de las copias (al menos 8 caracteres).'
  if (typed && typed.length < MIN_BACKUP_PASSWORD)
    return 'La contraseña de cifrado debe tener al menos 8 caracteres.'
  if (typed && typed !== draft.backupPasswordAgain)
    return 'Las contraseñas de cifrado no coinciden.'
  return null
}

/** Client-side checks; the main process validates again and its messages are shown too. */
export function validateDraft(
  draft: JobDraft,
  lookup: Lookup = () => null,
  typedEnvironments: readonly Environment[] = []
): string[] {
  const errors: string[] = []
  if (!draft.name.trim()) errors.push('El nombre de la tarea es obligatorio.')
  if (/[/\\:]/.test(draft.name)) errors.push('El nombre no puede contener "/", "\\" ni ":".')
  if (!draft.tasks.length) errors.push('Añade al menos un paso.')
  draft.tasks.forEach((task, i) =>
    errors.push(...taskProblems(task, i, draft.tasks, lookup, typedEnvironments))
  )
  const password = backupPasswordProblem(draft)
  if (password) errors.push(password)
  const cron = cronFromForm(draft.schedule)
  if (draft.scheduleEnabled && !isValidCron(cron))
    errors.push(`La programación "${cron}" no es una expresión cron válida de 5 campos.`)
  return errors
}

/** `nameOf` (connection names) gives unnamed steps their natural names. */
export function buildJobInput(draft: JobDraft, nameOf?: ConnectionName): JobInput {
  const input: JobInput = {
    name: draft.name.trim(),
    continueOnError: draft.continueOnError,
    tasks: draft.tasks.map((task) => {
      const out: JobTask = {
        id: task.id,
        type: task.type,
        connectionId: task.connectionId,
        schema: task.schema,
        referenceName: task.referenceName.trim() || defaultReferenceName(task, draft.tasks, nameOf)
      }
      if (task.type === 'backupschema') {
        out.includeData = task.includeData !== false
        // .nb3 is never stored (absent = .nb3): jobs with .nb3 steps stay byte-identical.
        if (task.format === 'sql' || task.format === 'vqb') out.format = task.format
        if (task.format === 'vqb' && task.encrypt) out.encrypt = true
      } else if (task.type === 'restoreschema') {
        out.schema = task.schema.trim()
        if (task.restoreSource) out.restoreSource = { ...task.restoreSource }
        out.safetyBackup = task.safetyBackup !== false
        // Absent in jobs saved before 0.1.6: structure and data.
        out.includeData = task.includeData !== false
      } else if (task.type === 'restorepackage') {
        out.schema = ''
        if (task.packageSource) out.packageSource = { ...task.packageSource }
        // Absent = every database of the package, also those it gains later.
        if (Array.isArray(task.packageDatabases)) out.packageDatabases = [...task.packageDatabases]
        const targets = Object.fromEntries(
          Object.entries(task.packageTargets ?? {})
            .map(([k, v]) => [k, (v ?? '').trim()] as const)
            .filter(([, v]) => v)
        )
        if (Object.keys(targets).length) out.packageTargets = targets
        if (task.packageSuffix?.trim()) out.packageSuffix = task.packageSuffix.trim()
        out.safetyBackup = task.safetyBackup !== false
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
  if (draft.backupPassword) input.backupPassword = draft.backupPassword
  return input
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/** Copy of a step with a new id (a restore keeps its source; nothing points at the copy). */
export function duplicateTask(task: JobTask): JobTask {
  const copy: JobTask = { ...task, id: newStepId() }
  if (task.restoreSource) copy.restoreSource = { ...task.restoreSource }
  if (task.packageSource) copy.packageSource = { ...task.packageSource }
  if (task.packageDatabases) copy.packageDatabases = [...task.packageDatabases]
  if (task.packageTargets) copy.packageTargets = { ...task.packageTargets }
  return copy
}
