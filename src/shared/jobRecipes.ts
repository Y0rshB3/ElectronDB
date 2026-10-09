import { restoreTargetSchema } from './restoreTask'
import { packageSourceLabel } from './restorePackage'
import type { JobTask } from './types'

/**
 * «Copiar y restaurar»: the recipe of the job editor that copies databases of
 * one connection and restores them into another in the same run (e.g. every
 * database of Staging into Local, each night). It only builds ordinary job
 * steps: one backup step per database, then one restore step per database
 * reading «la copia del paso N». The job model, the IPC and the runner are
 * untouched, and the copies of one run are grouped as a package in Historial
 * like those of any other job. Pure and shared: the editor builds the steps
 * with it and the integration suite runs a job built by it.
 */

export interface CopyRestoreDatabase {
  /** Database of the origin connection. */
  name: string
  /** Database it is restored into ('' or the same name = same name). */
  target: string
}

export interface CopyRestoreRecipe {
  sourceConnectionId: string
  targetConnectionId: string
  databases: CopyRestoreDatabase[]
  /** Back up each target database before replacing it («Copia previa del destino»). */
  safetyBackup: boolean
  /** false = «Solo estructura»: structure-only copies restored as empty tables. */
  includeData: boolean
  /**
   * 'package': one «Restaurar paquete» step restoring the copies just made
   * (with the per-database names); 'steps' (default): one restore step per database.
   */
  restoreAs?: 'package' | 'steps'
}

/** Name of a step as the sequence shows it when the user did not name it. */
export type ConnectionName = (connectionId: string) => string

/** «Copia de ventas (Staging)». */
export function backupStepName(schema: string, connectionName: string): string {
  return `Copia de ${schema}${connectionName ? ` (${connectionName})` : ''}`.trim()
}

/** «Restaurar ventas en Local». */
export function restoreStepName(schema: string, connectionName: string): string {
  return `Restaurar ${schema}${connectionName ? ` en ${connectionName}` : ''}`
    .replace(/\s+/g, ' ')
    .trim()
}

/** «Restaurar paquete de esta tarea en Local», «Restaurar paquete de «Copia nocturna» en Local». */
export function packageStepName(
  task: JobTask,
  connectionName: string,
  jobName?: (id: string) => string | undefined
): string {
  return `Restaurar paquete de ${packageSourceLabel(task, jobName)}${connectionName ? ` en ${connectionName}` : ''}`
}

/** Natural name of a backup or restore step (query steps: «Consulta <bd>»). */
export function naturalStepName(
  task: JobTask,
  tasks: JobTask[],
  nameOf: ConnectionName,
  jobName?: (id: string) => string | undefined
): string {
  const connection = task.connectionId ? nameOf(task.connectionId) : ''
  if (task.type === 'backupschema') return backupStepName(task.schema, connection)
  if (task.type === 'restoreschema')
    return restoreStepName(restoreTargetSchema(task, tasks), connection)
  if (task.type === 'restorepackage') return packageStepName(task, connection, jobName)
  return `Consulta ${task.schema}`.trim()
}

/** Target database of an entry: the typed name, or the same name when left empty. */
export const recipeTarget = (db: CopyRestoreDatabase): string => db.target.trim() || db.name

/**
 * Problems of the recipe itself (the steps it builds are checked again with
 * the job's per-step rules). Spanish, shown in the dialog.
 */
export function copyRestoreProblems(recipe: CopyRestoreRecipe): string[] {
  const problems: string[] = []
  if (!recipe.sourceConnectionId) problems.push('Elige la conexión de origen.')
  if (!recipe.databases.length) problems.push('Marca al menos una base de datos para copiar.')
  if (!recipe.targetConnectionId) problems.push('Elige la conexión de destino.')
  const seen = new Set<string>()
  for (const db of recipe.databases) {
    const target = recipeTarget(db)
    if (/[/\\]/.test(target) || target.length > 64)
      problems.push(`«${target}» no es un nombre de base de datos válido.`)
    if (seen.has(target)) problems.push(`Más de una base de datos se restauraría en «${target}».`)
    seen.add(target)
  }
  return [...new Set(problems)]
}

/**
 * The steps of the recipe, in run order: every copy first (so the copies of
 * one run are taken close in time), then every restore, each one reading the
 * copy of its database made earlier in the same run.
 */
export function buildCopyRestoreSteps(
  recipe: CopyRestoreRecipe,
  nameOf: ConnectionName,
  newId: () => string
): JobTask[] {
  const sourceName = nameOf(recipe.sourceConnectionId)
  const targetName = nameOf(recipe.targetConnectionId)
  const backups: JobTask[] = recipe.databases.map((db) => ({
    id: newId(),
    type: 'backupschema',
    connectionId: recipe.sourceConnectionId,
    schema: db.name,
    referenceName: backupStepName(db.name, sourceName),
    includeData: recipe.includeData,
    // Restorable on every engine (.nb3 is MySQL/MariaDB only, .sql is not restorable).
    format: 'vqb'
  }))
  if (recipe.restoreAs === 'package') {
    const renamed = Object.fromEntries(
      recipe.databases.flatMap((db) =>
        recipeTarget(db) !== db.name ? [[db.name, recipeTarget(db)]] : []
      )
    )
    const pkg: JobTask = {
      id: newId(),
      type: 'restorepackage',
      connectionId: recipe.targetConnectionId,
      schema: '',
      referenceName: '',
      packageSource: { kind: 'own' },
      // The databases of this recipe: earlier copies in the job are not restored by it.
      packageDatabases: recipe.databases.map((db) => db.name),
      ...(Object.keys(renamed).length ? { packageTargets: renamed } : {}),
      safetyBackup: recipe.safetyBackup,
      includeData: recipe.includeData
    }
    pkg.referenceName = packageStepName(pkg, targetName)
    return [...backups, pkg]
  }
  const restores: JobTask[] = recipe.databases.map((db, i) => {
    const target = recipeTarget(db)
    return {
      id: newId(),
      type: 'restoreschema',
      connectionId: recipe.targetConnectionId,
      // Empty = the source's name (the default of restore steps).
      schema: target === db.name ? '' : target,
      referenceName: restoreStepName(target, targetName),
      restoreSource: { kind: 'task', taskId: backups[i].id },
      safetyBackup: recipe.safetyBackup,
      includeData: recipe.includeData
    }
  })
  return [...backups, ...restores]
}
