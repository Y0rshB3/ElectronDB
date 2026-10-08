import { engineOf, isMysqlFamilyEngine } from './engines'
import type { BackupFormat } from './importers'
import type { ConnectionConfig, EngineId, JobTask } from './types'

/**
 * Per-engine rules of job steps, shared by main (jobs:save and the runner) and
 * the job editor. MySQL and MariaDB have every step and format; PostgreSQL,
 * SQLite and MongoDB have backup steps in .vqb (optionally encrypted) and
 * restore steps from .vqb copies of the same engine. Keep free of
 * Node/Electron/browser imports.
 */

type Lookup = (id: string) => ConnectionConfig | null | undefined

/** Engine group whose backups restore into each other (MySQL and MariaDB share one). */
export type BackupFamily = 'mysql' | 'postgresql' | 'sqlite' | 'mongodb'

export function backupFamilyOf(engine: EngineId | null | undefined): BackupFamily {
  if (isMysqlFamilyEngine(engine)) return 'mysql'
  return engine as Exclude<BackupFamily, 'mysql'>
}

const FAMILY_NAME: Record<BackupFamily, string> = {
  mysql: 'MySQL/MariaDB',
  postgresql: 'PostgreSQL',
  sqlite: 'SQLite',
  mongodb: 'MongoDB'
}

/** «MySQL/MariaDB», «PostgreSQL»… for messages. */
export const backupFamilyName = (family: BackupFamily): string => FAMILY_NAME[family]

/** Backup formats a step of this connection may write (.nb3 and .sql are MySQL/MariaDB only). */
export function jobBackupFormats(connection: { engine?: EngineId | null }): BackupFormat[] {
  return isMysqlFamilyEngine(engineOf(connection).id) ? ['vqb', 'nb3', 'sql'] : ['vqb']
}

/** Query steps run SQL through the MySQL/MariaDB sessions only. */
export function supportsQuerySteps(connection: { engine?: EngineId | null }): boolean {
  return isMysqlFamilyEngine(engineOf(connection).id)
}

/** What the database field of a step is called for this connection. */
export function jobDatabaseLabel(connection: { engine?: EngineId | null } | null): string {
  const id = connection ? engineOf(connection).id : 'mysql'
  if (id === 'sqlite') return 'Base de datos (main o adjunta)'
  return isMysqlFamilyEngine(id) ? 'Esquema' : 'Base de datos'
}

/** Databases a restore step never replaces, per engine (beyond MySQL's system schemas). */
const SYSTEM_DATABASES: Partial<Record<BackupFamily, ReadonlySet<string>>> = {
  postgresql: new Set(['template0', 'template1']),
  mongodb: new Set(['admin', 'local', 'config']),
  sqlite: new Set(['temp'])
}

/** Why `name` cannot be replaced on a connection of `family` (system database), or null. */
export function systemDatabaseRefusal(family: BackupFamily, name: string): string | null {
  const set = SYSTEM_DATABASES[family]
  return set?.has(name.trim())
    ? `«${name.trim()}» es una base de datos del sistema de ${FAMILY_NAME[family]} y nunca se reemplaza. Elige otra base de datos de destino.`
    : null
}

/**
 * Connection whose backups a restore step reads: the backup step's connection
 * (source `task`) or the chosen one (`latest`/`file`); null when unknown.
 */
function restoreSourceConnection(task: JobTask, tasks: JobTask[]): string | null {
  const source = task.restoreSource
  if (!source) return null
  if (source.kind === 'task') return tasks.find((t) => t.id === source.taskId)?.connectionId || null
  return source.connectionId || null
}

/**
 * First per-engine problem of a step, or null. `label` names the step
 * ("paso 2", "Backup tienda"…). Missing connections are left to the other checks.
 */
export function jobStepEngineProblem(
  task: JobTask,
  tasks: JobTask[],
  lookup: Lookup,
  label: string
): string | null {
  const connection = task.connectionId ? lookup(task.connectionId) : null
  if (!connection) return null
  const family = backupFamilyOf(engineOf(connection).id)
  if (task.type === 'runquery' && !supportsQuerySteps(connection))
    return `El ${label} es una consulta sobre «${connection.name}» (${FAMILY_NAME[family]}): los pasos de consulta solo están disponibles en conexiones MySQL y MariaDB.`
  if (task.type === 'backupschema' && !jobBackupFormats(connection).includes(task.format ?? 'nb3'))
    return `El ${label} copia «${connection.name}» (${FAMILY_NAME[family]}): sus copias solo pueden ser .vqb.`
  // A file of «Restaurar todo» was checked against its own manifest by the plan: the
  // connection owning its folder may be of another engine.
  if (task.type === 'restoreschema' && task.restoreSource?.kind !== 'file') {
    const sourceId = restoreSourceConnection(task, tasks)
    const source = sourceId ? lookup(sourceId) : null
    if (source) {
      const from = backupFamilyOf(engineOf(source).id)
      if (from !== family)
        return `El ${label} restauraría una copia de ${FAMILY_NAME[from]} («${source.name}») en «${connection.name}», que es ${FAMILY_NAME[family]}: una copia solo se restaura en una conexión del mismo motor.`
    }
  }
  return null
}
