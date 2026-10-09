import { engineOf } from './engines'
import { backupFamilyOf, jobStepEngineProblem, systemDatabaseRefusal } from './jobEngines'
import { environmentName, requiresTypedConfirm } from './typedConfirm'
import type { ConnectionConfig, Environment, JobTask } from './types'

/**
 * Rules of the 'restoreschema' job step, shared by main (jobs:save and the
 * runner) and the job editor so both refuse the same things with the same
 * Spanish messages. Keep free of Node/Electron/browser imports.
 */

/** Label of the safety backups taken before a database is replaced. */
export const SAFETY_BACKUP_LABEL = 'previo-rollback'

/** Server schemas that are never dropped or replaced (grant tables, metadata...). */
export const SYSTEM_SCHEMAS: ReadonlySet<string> = new Set([
  'mysql',
  'information_schema',
  'performance_schema',
  'sys'
])

export const isSystemSchema = (name: string | null | undefined): boolean =>
  !!name && SYSTEM_SCHEMAS.has(name.trim().toLowerCase())

/** Why a database cannot be replaced because it belongs to the server itself. */
export function systemSchemaRefusal(schema: string): string {
  return `«${schema.trim()}» es una base de datos del sistema de MySQL y nunca se reemplaza (borrarla dejaría el servidor sin usuarios ni permisos). Elige otra base de datos de destino.`
}

type Lookup = (id: string) => ConnectionConfig | null | undefined

/**
 * A .sql copy (backup step with «Formato: .sql») is for other managers: restore
 * steps and «Restaurar todo» only read .vqb and .nb3 copies.
 */
export const SQL_COPY_NOT_RESTORABLE =
  'Es una copia en formato .sql: las restauraciones automáticas y «Restaurar todo» solo usan copias .vqb o .nb3. Para llevarla a una base de datos usa «Importar…» › Archivo .sql.'

/** Why a restore step cannot use the backup step `ref` (format .sql), or null. */
export function sqlCopyRefusal(label: string, ref: JobTask): string | null {
  if (ref.type !== 'backupschema' || ref.format !== 'sql') return null
  return `El ${label} restaura «${ref.referenceName || ref.schema}», una copia .sql; las restauraciones automáticas necesitan una copia .vqb o .nb3. Cambia el formato del paso de copia a .vqb o .nb3.`
}

export function restoreProductionRefusal(stepName: string, connectionName: string): string {
  return (
    `El paso «${stepName}» restaura sobre «${connectionName}», una conexión de producción. ` +
    'Los pasos de restauración de una tarea se ejecutan sin nadie que los confirme (al ejecutarla, ' +
    'programada o con launchd), así que no pueden escribir en producción. Para restaurar en ' +
    'producción usa «Restaurar todo» desde el historial de ejecuciones, que pide confirmación.'
  )
}

/**
 * Refusal of a restore step whose target needs the typed confirmation: the
 * production text for production, and one naming the environment otherwise.
 */
export function restoreTypedRefusal(
  stepName: string,
  connectionName: string,
  environment: Environment
): string {
  if (environment === 'production') return restoreProductionRefusal(stepName, connectionName)
  const env = environmentName(environment)
  return (
    `El paso «${stepName}» restaura sobre «${connectionName}», una conexión de entorno ${env} ` +
    'que pide escribir su nombre antes de cualquier escritura (Ajustes › Seguridad). Los pasos de ' +
    'restauración de una tarea se ejecutan sin nadie que escriba ese nombre (al ejecutarla, ' +
    `programada o con launchd), así que no pueden escribir en ella. Quita ${env} de la lista en ` +
    'Ajustes › Seguridad o usa «Restaurar todo» desde el historial de ejecuciones, que pide confirmación.'
  )
}

export interface RestoreSourceRef {
  connectionId: string | null
  schema: string
}

/**
 * Connection and schema the restore step reads from, as far as the job
 * definition tells (null when the source is incomplete).
 */
export function restoreSourceOf(task: JobTask, tasks: JobTask[]): RestoreSourceRef | null {
  const source = task.restoreSource
  if (!source) return null
  if (source.kind === 'task') {
    const ref = tasks.find((t) => t.id === source.taskId)
    return ref ? { connectionId: ref.connectionId || null, schema: ref.schema } : null
  }
  if (source.kind === 'latest')
    return { connectionId: source.connectionId || null, schema: source.schema }
  return { connectionId: source.connectionId, schema: source.schema }
}

/** Target schema of a restore step: its own schema, or the source schema when left empty. */
export function restoreTargetSchema(task: JobTask, tasks: JobTask[]): string {
  return task.schema?.trim() || restoreSourceOf(task, tasks)?.schema?.trim() || ''
}

export interface RestoreCheckOptions {
  /** «Restaurar todo» after a typed confirmation: guarded targets and `file` sources are fine. */
  rollback?: boolean
  /**
   * AppSettings.typedConfirmEnvironments: restore steps never target these
   * (nobody types the name in a job run). Production is always refused.
   */
  typedEnvironments?: readonly Environment[]
  /**
   * The restore is one database of a «Restaurar paquete» step that read
   * another job's package: its `file` source was resolved by the runner (never
   * saved in a job). Guarded targets stay refused.
   */
  packageFile?: boolean
}

/**
 * First problem of a restore step, or null when it can run. `label` names
 * the step in the message ("paso 3", "Restaurar auth"...).
 */
export function restoreTaskProblem(
  task: JobTask,
  tasks: JobTask[],
  lookup: Lookup,
  label: string,
  options: RestoreCheckOptions = {}
): string | null {
  const source = task.restoreSource
  if (!source) return `El ${label} necesita una copia de origen.`
  if (source.kind === 'task') {
    const index = tasks.findIndex((t) => t.id === task.id)
    const refIndex = tasks.findIndex((t) => t.id === source.taskId)
    if (!source.taskId || refIndex < 0)
      return `El ${label} restaura la copia de un paso que no existe; elige un paso de copia de seguridad anterior.`
    if (tasks[refIndex].type !== 'backupschema')
      return `El ${label} solo puede restaurar la copia de un paso de tipo «Copia de seguridad».`
    const sqlProblem = sqlCopyRefusal(label, tasks[refIndex])
    if (sqlProblem) return sqlProblem
    if (index >= 0 && refIndex >= index)
      return `El ${label} debe ir después del paso de copia que restaura («${tasks[refIndex].referenceName || `paso ${refIndex + 1}`}»).`
    // A structure-only copy is fine when the step itself restores only the structure.
    if (tasks[refIndex].includeData === false && task.includeData !== false)
      return `El ${label} restaura la copia de «${tasks[refIndex].referenceName || tasks[refIndex].schema}», que es solo de estructura (sin datos): las tablas de destino quedarían vacías. Activa «Incluir datos» en ese paso de copia, elige otro origen o marca «Solo estructura» en este paso.`
  } else if (source.kind === 'latest') {
    if (!source.connectionId) return `El ${label} necesita la conexión de origen de la copia.`
    if (!source.schema?.trim()) return `El ${label} necesita el esquema de origen de la copia.`
  } else if (source.kind === 'file') {
    if (!options.rollback && !options.packageFile)
      return `El ${label} usa un archivo concreto como origen; elige un paso de copia o «Última copia en disco».`
    if (!source.path) return `El ${label} no indica el archivo de la copia.`
  } else {
    return `El ${label} tiene un origen de copia desconocido.`
  }
  if (!task.connectionId) return `El ${label} necesita una conexión de destino.`
  const target = lookup(task.connectionId)
  if (
    target &&
    requiresTypedConfirm(target.environment, options.typedEnvironments) &&
    !options.rollback
  )
    return restoreTypedRefusal(task.referenceName || label, target.name, target.environment)
  const targetSchema = restoreTargetSchema(task, tasks)
  if (!targetSchema) return `El ${label} necesita la base de datos de destino.`
  const family = target ? backupFamilyOf(engineOf(target).id) : 'mysql'
  if (family === 'mysql' && isSystemSchema(targetSchema))
    return `El ${label} no es válido: ${systemSchemaRefusal(targetSchema)}`
  const systemDb = family === 'mysql' ? null : systemDatabaseRefusal(family, targetSchema)
  if (systemDb) return `El ${label} no es válido: ${systemDb}`
  const engineProblem = jobStepEngineProblem(task, tasks, lookup, label)
  if (engineProblem) return engineProblem
  const from = restoreSourceOf(task, tasks)
  if (
    !options.rollback &&
    from &&
    from.connectionId === task.connectionId &&
    from.schema.trim() === targetSchema
  )
    return `El ${label} restauraría «${targetSchema}» sobre sí misma (misma conexión y base de datos de origen); elige otra conexión o base de datos de destino.`
  return null
}
