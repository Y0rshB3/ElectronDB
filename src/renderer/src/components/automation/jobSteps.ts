import { engineOf } from '@shared/engines'
import {
  backupFamilyOf,
  jobBackupFormats,
  supportsQuerySteps,
  systemDatabaseRefusal
} from '@shared/jobEngines'
import { isSystemSchema, restoreSourceOf } from '@shared/restoreTask'
import type { ConnectionConfig, JobTask } from '@shared/types'
import type { SavedQuery } from '@renderer/utils/savedQueries'
import { canBackup, automationConnections } from '@renderer/components/backups/backupHelpers'
import { defaultReferenceName, newRestoreTask, newTask } from './jobForm'

/**
 * Pure model of the «Añadir pasos» browser of the job editor: which
 * connections each kind of step can use, the items offered for a selection
 * and the steps they become. Keeps the job model untouched: every item turns
 * into an ordinary JobTask.
 */

/** Kinds offered by the browser (two of them are query steps, two are restores). */
export type StepKind = 'backup' | 'savedQuery' | 'sql' | 'restore'

export interface StepKindMeta {
  value: StepKind
  label: string
  /** Label of narrow editors. */
  short: string
  icon: string
  /** One short line under the browser explaining what the kind adds. */
  hint: string
}

export const STEP_KINDS: StepKindMeta[] = [
  {
    value: 'backup',
    short: 'Copia',
    label: 'Copia de seguridad',
    icon: 'mdi-archive-outline',
    hint: 'Elige las bases de datos que la tarea copiará en cada ejecución.'
  },
  {
    value: 'savedQuery',
    short: 'Consulta',
    label: 'Consulta guardada',
    icon: 'mdi-bookmark-outline',
    hint: 'Las consultas guardadas de la conexión. El paso guarda una copia del SQL: editar la consulta después no cambia la tarea.'
  },
  {
    value: 'sql',
    short: 'SQL',
    label: 'SQL libre',
    icon: 'mdi-console-line',
    hint: 'Un paso con un editor SQL vacío en la base de datos elegida.'
  },
  {
    value: 'restore',
    short: 'Restaurar',
    label: 'Restauración',
    icon: 'mdi-backup-restore',
    hint: 'El paquete de esta tarea en un paso (o copia a copia), el último paquete de otra tarea o la última copia en disco; por defecto en una conexión local con copia previa.'
  }
]

/** Connections the browser lists for a kind (query steps: MySQL/MariaDB only). */
export function connectionsForKind(kind: StepKind, list: ConnectionConfig[]): ConnectionConfig[] {
  const usable = automationConnections(list)
  if (kind === 'backup') return usable.filter((c) => canBackup(c))
  if (kind === 'savedQuery' || kind === 'sql') return usable.filter((c) => supportsQuerySteps(c))
  return usable.filter((c) => canBackup(c))
}

/** System databases are never offered in the browser (copies, queries or restores). */
export function isHiddenDatabase(connection: ConnectionConfig, name: string): boolean {
  const family = backupFamilyOf(engineOf(connection).id)
  if (family === 'mysql') return isSystemSchema(name)
  return systemDatabaseRefusal(family, name) !== null
}

export function visibleDatabases(connection: ConnectionConfig, names: string[]): string[] {
  return names.filter((n) => !isHiddenDatabase(connection, n))
}

/** Saved queries of a connection for the selected database (all of them with no database). */
export function savedQueriesFor(queries: SavedQuery[], schema: string | null): SavedQuery[] {
  const list = schema ? queries.filter((q) => (q.schema ?? '') === schema) : queries
  return [...list].sort((a, b) => a.name.localeCompare(b.name, 'es'))
}

/** Backup step of `schema`, in the connection's default restorable format. */
export function backupStep(connection: ConnectionConfig, schema: string): JobTask {
  const task = newTask('backupschema', connection.id, schema)
  if (!jobBackupFormats(connection).includes(task.format ?? 'nb3')) task.format = 'vqb'
  return task
}

/** Query step carrying a copy of the saved query's SQL. */
export function savedQueryStep(
  connection: ConnectionConfig,
  query: SavedQuery,
  schema: string | null
): JobTask {
  const task = newTask('runquery', connection.id, query.schema ?? schema ?? '')
  task.sql = query.sql
  task.referenceName = query.name
  return task
}

export function sqlStep(connection: ConnectionConfig, schema: string | null): JobTask {
  return newTask('runquery', connection.id, schema ?? '')
}

/**
 * Restore step of an earlier backup step, into the first local connection of
 * the same engine that does not need the typed name (changed in its settings).
 */
export function restoreFromStep(
  source: JobTask,
  connections: ConnectionConfig[],
  blocked: (c: ConnectionConfig) => boolean
): JobTask {
  return newRestoreTask([source], connections, blocked)
}

/** Restore step of the newest job copy of `schema` on `connection` found on disk. */
export function restoreFromLatest(
  connection: ConnectionConfig,
  schema: string,
  connections: ConnectionConfig[],
  blocked: (c: ConnectionConfig) => boolean
): JobTask {
  const family = backupFamilyOf(engineOf(connection).id)
  const local = connections.find(
    (c) => c.environment === 'local' && !blocked(c) && backupFamilyOf(engineOf(c).id) === family
  )
  const task = newTask('restoreschema', local?.id ?? '', '')
  task.restoreSource = { kind: 'latest', connectionId: connection.id, schema }
  return task
}

/**
 * Drops repeated backup steps of the same connection and database in one batch
 * («Todas las bases de datos» checked together with one of them).
 */
export function dedupeSteps(steps: JobTask[]): JobTask[] {
  const seen = new Set<string>()
  return steps.filter((t) => {
    if (t.type !== 'backupschema') return true
    const key = `${t.connectionId}\u0000${t.schema}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Backup steps of the job a restore can read (not .sql copies), with their position. */
export function restorableSteps(tasks: JobTask[]): { task: JobTask; index: number }[] {
  return tasks.flatMap((task, index) =>
    task.type === 'backupschema' && task.format !== 'sql' ? [{ task, index }] : []
  )
}

/** Steps of the job already restoring `source` (to flag the item). */
export function restoresOf(sourceId: string, tasks: JobTask[]): JobTask[] {
  return tasks.filter(
    (t) =>
      t.type === 'restoreschema' &&
      t.restoreSource?.kind === 'task' &&
      t.restoreSource.taskId === sourceId
  )
}

/** Same connection and database already used by a step of this kind. */
export function inJob(
  tasks: JobTask[],
  type: JobTask['type'],
  connectionId: string,
  schema: string
): boolean {
  return tasks.some(
    (t) => t.type === type && t.connectionId === connectionId && t.schema === schema
  )
}

/** Short label of a restore source for rows and lists. */
export function restoreSourceLabel(
  task: JobTask,
  tasks: JobTask[],
  nameOf: (id: string) => string
): string {
  const source = task.restoreSource
  if (!source) return 'sin origen'
  if (source.kind === 'task') {
    const index = tasks.findIndex((t) => t.id === source.taskId)
    if (index < 0) return 'paso eliminado'
    const ref = tasks[index]
    return `copia del paso ${index + 1} (${ref.schema || defaultReferenceName(ref)})`
  }
  if (source.kind === 'latest') {
    const from = restoreSourceOf(task, tasks)
    return from?.schema
      ? `última copia de ${from.schema}${source.connectionId ? ` (${nameOf(source.connectionId)})` : ''}`
      : 'última copia en disco'
  }
  return 'archivo'
}
