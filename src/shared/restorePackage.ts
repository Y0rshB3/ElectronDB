import { engineOf } from './engines'
import { backupFamilyName, backupFamilyOf, systemDatabaseRefusal } from './jobEngines'
import { isSystemSchema, restoreTypedRefusal, systemSchemaRefusal } from './restoreTask'
import { requiresTypedConfirm } from './typedConfirm'
import type { ConnectionConfig, Environment, JobTask } from './types'

/**
 * Rules of the 'restorepackage' job step («Restaurar paquete»), shared by main
 * (jobs:save and the runner) and the job editor. A package is the set of
 * copies one run of a job made together: the copies made earlier in the same
 * run by this job's backup steps (`own`), or the newest package of another job
 * (`job`). When the step runs it becomes one ordinary restore per database
 * (`packageRestoreTasks`), so each database gets the restore rules, the log,
 * the safety copy and the history entry of a 'restoreschema' step. Keep free
 * of Node/Electron/browser imports.
 */

type Lookup = (id: string) => ConnectionConfig | null | undefined

/** Separator of the ids of the restores a package step becomes (`<step id>#<n>`). */
export const PACKAGE_TASK_SEPARATOR = '#'

/** Longest database name accepted as a target (MySQL's limit; the others are longer). */
const MAX_NAME = 64

/** One copy of a package, as the step restores it. */
export interface PackageEntry {
  /** Database the copy was made from (its name in the package). */
  schema: string
  connectionId: string | null
  structureOnly: boolean
  /** `own` packages: the backup step of this job that makes the copy. */
  taskId?: string
  /** `job` packages: the copy file. */
  path?: string
}

export interface PackageSelection {
  /** Copies the step restores, in package order. */
  selected: PackageEntry[]
  /** Databases listed in `packageDatabases` that the package does not have. */
  missing: string[]
  /**
   * Structure-only copies left out of «todas» because the step restores data
   * (restoring them would leave the target's tables empty).
   */
  skipped: PackageEntry[]
}

/** Target database of a copy: its own name, or the copied name plus the suffix. */
export function packageTargetName(task: JobTask, schema: string): string {
  const own = task.packageTargets?.[schema]
  if (typeof own === 'string' && own.trim()) return own.trim()
  const suffix = typeof task.packageSuffix === 'string' ? task.packageSuffix.trim() : ''
  return `${schema}${suffix}`
}

/** «Todas»: the step restores every database of the package, also those it gains later. */
export const restoresWholePackage = (task: JobTask): boolean =>
  !Array.isArray(task.packageDatabases)

/**
 * Backup steps whose copies make up the step's own package: the restorable
 * (.vqb/.nb3) backup steps placed before it.
 */
export function ownPackageSteps(task: JobTask, tasks: JobTask[]): JobTask[] {
  const index = tasks.findIndex((t) => t.id === task.id)
  const before = index >= 0 ? tasks.slice(0, index) : tasks
  return before.filter((t) => t.type === 'backupschema' && t.format !== 'sql' && !!t.schema)
}

export function ownPackageEntries(task: JobTask, tasks: JobTask[]): PackageEntry[] {
  return ownPackageSteps(task, tasks).map((t) => ({
    schema: t.schema,
    connectionId: t.connectionId || null,
    structureOnly: t.includeData === false,
    taskId: t.id
  }))
}

/** Which copies of `entries` the step restores. */
export function selectPackageEntries(task: JobTask, entries: PackageEntry[]): PackageSelection {
  const withData = task.includeData !== false
  if (restoresWholePackage(task)) {
    const selected = entries.filter((e) => !(withData && e.structureOnly))
    return {
      selected,
      missing: [],
      skipped: entries.filter((e) => withData && e.structureOnly)
    }
  }
  const wanted = (task.packageDatabases ?? []).map((n) => String(n))
  const selected = entries.filter((e) => wanted.includes(e.schema))
  const missing = wanted.filter((n) => !entries.some((e) => e.schema === n))
  return { selected, missing, skipped: [] }
}

/** Why `name` is not a database name a restore may create, or null. */
export function targetNameProblem(name: string): string | null {
  if (!name.trim()) return 'falta el nombre de la base de datos de destino'
  if (/[/\\]/.test(name) || name.length > MAX_NAME)
    return `«${name}» no es un nombre de base de datos válido`
  return null
}

/** Why `target` cannot be replaced on `connection` (system database), or null. */
function systemTargetProblem(connection: ConnectionConfig | null, target: string): string | null {
  const family = connection ? backupFamilyOf(engineOf(connection).id) : 'mysql'
  if (family === 'mysql') return isSystemSchema(target) ? systemSchemaRefusal(target) : null
  return systemDatabaseRefusal(family, target)
}

export interface PackageCheckOptions {
  /** AppSettings.typedConfirmEnvironments: never a target of a job (production always refused). */
  typedEnvironments?: readonly Environment[]
  /** The job the step belongs to: a `job` source never names it (that is the `own` package). */
  jobId?: string
  /** Whether a job exists (main's repo); unchecked when absent. */
  jobExists?: (id: string) => boolean
}

/** «"Copia nocturna Staging"» or «esta tarea», for names and messages. */
export function packageSourceLabel(
  task: JobTask,
  jobName?: (id: string) => string | undefined
): string {
  const source = task.packageSource
  if (!source || source.kind === 'own') return 'esta tarea'
  const name = jobName?.(source.jobId) || source.jobName || 'otra tarea'
  return `«${name}»`
}

/**
 * First problem of a 'restorepackage' step, or null when it can be saved and
 * run. Copies of another job's package are only known when the step runs, so
 * their per-database rules (engine, system databases, same database) are
 * checked then, on each restore the step becomes.
 */
export function restorePackageProblem(
  task: JobTask,
  tasks: JobTask[],
  lookup: Lookup,
  label: string,
  options: PackageCheckOptions = {}
): string | null {
  const source = task.packageSource
  if (!source || typeof source !== 'object')
    return `El ${label} necesita el paquete que restaura (el de esta tarea o el último de otra tarea).`
  if (source.kind === 'job') {
    if (!source.jobId || typeof source.jobId !== 'string')
      return `El ${label} necesita la tarea cuyo último paquete restaura.`
    if (options.jobId && source.jobId === options.jobId)
      return `El ${label} restaura el último paquete de su propia tarea; elige «Paquete de esta tarea», que usa las copias recién hechas en la misma ejecución.`
    if (options.jobExists && !options.jobExists(source.jobId))
      return `El ${label} restaura el último paquete de ${source.jobName ? `«${source.jobName}»` : 'una tarea'}, que ya no existe; elige otro paquete.`
  } else if (source.kind !== 'own') {
    return `El ${label} tiene un origen de paquete desconocido.`
  }
  if (task.packageDatabases !== undefined) {
    if (
      !Array.isArray(task.packageDatabases) ||
      task.packageDatabases.some((n) => typeof n !== 'string')
    )
      return `El ${label} tiene una lista de bases de datos no válida.`
    if (!task.packageDatabases.length)
      return `El ${label} no restaura ninguna base de datos; marca al menos una o elige «Todas».`
  }
  if (
    task.packageTargets !== undefined &&
    (typeof task.packageTargets !== 'object' ||
      task.packageTargets === null ||
      Array.isArray(task.packageTargets) ||
      Object.values(task.packageTargets).some((v) => typeof v !== 'string'))
  )
    return `El ${label} tiene nombres de destino no válidos.`
  if (task.packageSuffix !== undefined && typeof task.packageSuffix !== 'string')
    return `El ${label} tiene un sufijo de destino no válido.`
  if (!task.connectionId) return `El ${label} necesita una conexión de destino.`
  const target = lookup(task.connectionId) ?? null
  if (target && requiresTypedConfirm(target.environment, options.typedEnvironments))
    return restoreTypedRefusal(task.referenceName || label, target.name, target.environment)

  // Names typed by the user are checked whatever the package holds.
  const suffix = task.packageSuffix?.trim() ?? ''
  if (suffix && (/[/\\]/.test(suffix) || suffix.length > MAX_NAME))
    return `El ${label} no es válido: «${suffix}» no sirve como sufijo de un nombre de base de datos.`
  for (const name of Object.values(task.packageTargets ?? {})) {
    if (!name.trim()) continue
    const bad = targetNameProblem(name.trim())
    if (bad) return `El ${label} no es válido: ${bad}.`
    const system = systemTargetProblem(target, name.trim())
    if (system) return `El ${label} no es válido: ${system}`
  }

  const checkTargets = (entries: PackageEntry[]): string | null =>
    packageTargetsProblem(task, entries, target, label)

  if (source.kind === 'job') {
    // Only the explicit databases are known before the run.
    if (!restoresWholePackage(task))
      return checkTargets(
        (task.packageDatabases ?? []).map((schema) => ({
          schema,
          connectionId: null,
          structureOnly: false
        }))
      )
    return null
  }

  const entries = ownPackageEntries(task, tasks)
  if (!entries.length)
    return `El ${label} restaura el paquete de esta tarea, pero no hay ningún paso de copia (.vqb o .nb3) antes de él; pon las copias antes o elige el último paquete de otra tarea.`
  const picked = selectPackageEntries(task, entries)
  const { missing } = picked
  // «Todas» restores the copies of the target's engine; an explicit list must match it.
  const selected = restoresWholePackage(task)
    ? splitByEngine(task, picked.selected, lookup).same
    : picked.selected
  if (restoresWholePackage(task) && picked.selected.length && !selected.length)
    return `El ${label} no tiene nada que restaurar en «${target?.name ?? 'el destino'}»: ninguna copia de esta tarea es de su motor. Elige un destino del mismo motor que las copias.`
  if (missing.length)
    return `El ${label} restaura ${missing.map((n) => `«${n}»`).join(', ')}, ${missing.length === 1 ? 'que no está' : 'que no están'} entre las copias de esta tarea anteriores al paso; quítala${missing.length === 1 ? '' : 's'} de la lista o añade su copia antes.`
  if (!selected.length)
    return `El ${label} no tiene nada que restaurar: todas las copias de esta tarea son solo de estructura. Marca «Solo estructura» en este paso o incluye datos en las copias.`
  if (task.includeData !== false) {
    const bare = selected.find((e) => e.structureOnly)
    if (bare)
      return `El ${label} restaura la copia de «${bare.schema}», que es solo de estructura (sin datos): las tablas de destino quedarían vacías. Quítala de la lista, incluye datos en esa copia o marca «Solo estructura» en este paso.`
  }
  const family = target ? backupFamilyOf(engineOf(target).id) : null
  for (const entry of selected) {
    const from = entry.connectionId ? lookup(entry.connectionId) : null
    if (family && from) {
      const fromFamily = backupFamilyOf(engineOf(from).id)
      if (fromFamily !== family)
        return `El ${label} restauraría la copia de «${entry.schema}» (${backupFamilyName(fromFamily)}, «${from.name}») en «${target!.name}», que es ${backupFamilyName(family)}: una copia solo se restaura en una conexión del mismo motor. Quítala de la lista o elige otro destino.`
    }
    if (
      entry.connectionId === task.connectionId &&
      packageTargetName(task, entry.schema) === entry.schema
    )
      return `El ${label} restauraría «${entry.schema}» sobre sí misma (misma conexión y base de datos de origen); elige otra conexión de destino o un sufijo.`
  }
  return checkTargets(selected)
}

/**
 * Copies of `entries` whose engine matches the step's target (MySQL and
 * MariaDB share one), and the others. Copies of unknown connections count as
 * matching: the restore itself checks the copy's engine.
 */
export function splitByEngine(
  task: JobTask,
  entries: PackageEntry[],
  lookup: Lookup
): { same: PackageEntry[]; other: PackageEntry[] } {
  const target = task.connectionId ? lookup(task.connectionId) : null
  if (!target) return { same: entries, other: [] }
  const family = backupFamilyOf(engineOf(target).id)
  const same: PackageEntry[] = []
  const other: PackageEntry[] = []
  for (const entry of entries) {
    const from = entry.connectionId ? lookup(entry.connectionId) : null
    if (from && backupFamilyOf(engineOf(from).id) !== family) other.push(entry)
    else same.push(entry)
  }
  return { same, other }
}

/**
 * Problem of the target names of `entries` (invalid, system database, two
 * copies landing in one database), or null.
 */
export function packageTargetsProblem(
  task: JobTask,
  entries: PackageEntry[],
  target: ConnectionConfig | null,
  label: string
): string | null {
  const seen = new Map<string, string>()
  for (const entry of entries) {
    const name = packageTargetName(task, entry.schema)
    const bad = targetNameProblem(name)
    if (bad) return `El ${label} no es válido: ${bad}.`
    const system = systemTargetProblem(target, name)
    if (system) return `El ${label} no es válido: ${system}`
    const other = seen.get(name)
    if (other !== undefined)
      return other === entry.schema
        ? `El ${label} tiene dos copias de «${entry.schema}» en el paquete; restáuralas con pasos de restauración separados.`
        : `El ${label} restauraría «${other}» y «${entry.schema}» en la misma base de datos «${name}»; cambia uno de los nombres de destino.`
    seen.set(name, entry.schema)
  }
  return null
}

/**
 * The ordinary restores a package step becomes when it runs, one per copy,
 * in package order. Own copies read «la copia del paso N»; copies of another
 * job's package read their file.
 */
export function packageRestoreTasks(
  task: JobTask,
  entries: PackageEntry[],
  referenceName: (entry: PackageEntry, target: string) => string
): JobTask[] {
  return entries.map((entry, i) => {
    const target = packageTargetName(task, entry.schema)
    return {
      id: `${task.id}${PACKAGE_TASK_SEPARATOR}${i + 1}`,
      type: 'restoreschema' as const,
      connectionId: task.connectionId,
      schema: target,
      referenceName: referenceName(entry, target),
      restoreSource: entry.taskId
        ? { kind: 'task' as const, taskId: entry.taskId }
        : {
            kind: 'file' as const,
            path: entry.path ?? '',
            schema: entry.schema,
            connectionId: entry.connectionId
          },
      safetyBackup: task.safetyBackup !== false,
      // A structure-only copy (kept when the step itself restores structure only) stays empty.
      includeData: task.includeData !== false && !entry.structureOnly
    }
  })
}
