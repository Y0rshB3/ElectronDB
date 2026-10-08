import type {
  BackupFile,
  BackupFileFormat,
  BackupMeta,
  BackupObjectSummary,
  ConnectionConfig,
  Environment
} from '@shared/types'
import { can } from '@renderer/engines/capabilities'

export const SOURCE_CHIPS: Record<BackupFile['source'], { label: string; color: string }> = {
  navicat: { label: 'Navicat', color: 'warning' },
  electrondb: { label: 'Vortaq', color: 'primary' },
  unknown: { label: 'Desconocido', color: 'secondary' }
}

/**
 * Chip for a backup source. Never throws: an unexpected value (for example "navidog" sent
 * by a main process from the Navidog era) is shown as "Desconocido".
 */
export function sourceChip(source: string | null | undefined): { label: string; color: string } {
  return (
    (source && (SOURCE_CHIPS as Record<string, { label: string; color: string }>)[source]) ||
    SOURCE_CHIPS.unknown
  )
}

export const ENVIRONMENTS: { value: Environment; title: string; color: string }[] = [
  { value: 'local', title: 'Local', color: 'success' },
  { value: 'staging', title: 'Staging', color: 'warning' },
  { value: 'production', title: 'Producción', color: 'error' },
  { value: 'other', title: 'Otro', color: 'secondary' }
]

export function environmentLabel(env: Environment): string {
  return ENVIRONMENTS.find((e) => e.value === env)?.title ?? env
}

export function environmentColor(env: Environment): string {
  return ENVIRONMENTS.find((e) => e.value === env)?.color ?? 'secondary'
}

/** True when the connection can make and restore backups (.vqb and/or .nb3). */
export function canBackup(c: ConnectionConfig | null | undefined): boolean {
  return !!c && (can(c, 'supportsBackupsNb3') || can(c, 'supportsBackupsVqb'))
}

/** Connections with backups: MySQL (.vqb and .nb3) and PostgreSQL (.vqb). */
export function backupConnections(list: ConnectionConfig[]): ConnectionConfig[] {
  return list.filter(canBackup)
}

/** Connections a .sql dump can be imported into (MySQL, the engine the importer speaks). */
export function sqlImportConnections(list: ConnectionConfig[]): ConnectionConfig[] {
  return list.filter((c) => can(c, 'supportsBackupsNb3'))
}

/**
 * Connections a backup can be restored into: the same engine only. A .nb3 is
 * MySQL; a .vqb says its engine in the manifest (unknown while it is locked).
 */
export function restoreTargets(
  list: ConnectionConfig[],
  meta: Pick<BackupMeta, 'format' | 'engine' | 'locked'> | null | undefined,
  file?: Pick<BackupFile, 'format'> | null
): ConnectionConfig[] {
  const format = meta?.format ?? file?.format ?? 'nb3'
  const all = backupConnections(list)
  if (format === 'nb3') return all.filter((c) => can(c, 'supportsBackupsNb3'))
  if (!meta || meta.locked || !meta.engine) return all
  return all.filter((c) => vqbEngineOfConnection(c) === meta.engine)
}

/** .vqb engine of a connection: MySQL and MariaDB servers both write 'mysql'. */
export function vqbEngineOfConnection(c: { engine?: ConnectionConfig['engine'] }): string {
  return c.engine === 'postgresql' || c.engine === 'sqlite' || c.engine === 'mongodb'
    ? c.engine
    : 'mysql'
}

/** «.vqb» / «.nb3 (Navicat)». */
export function backupFormatLabel(format: BackupFileFormat | undefined): string {
  return format === 'vqb' ? '.vqb (Vortaq)' : '.nb3 (Navicat)'
}

/** «MySQL», «MariaDB», «PostgreSQL». */
export function engineLabel(engine: string | undefined, flavor?: string): string {
  if (engine === 'postgresql') return 'PostgreSQL'
  if (engine === 'sqlite') return 'SQLite'
  return flavor === 'mariadb' ? 'MariaDB' : 'MySQL'
}

/** Object name as listed: PostgreSQL objects carry their schema. */
export function backupObjectName(o: Pick<BackupObjectSummary, 'name' | 'schema'>): string {
  return o.schema ? `${o.schema}.${o.name}` : o.name
}

/** Connections that automation tasks may target (every MySQL connection). */
export function automationConnections(list: ConnectionConfig[]): ConnectionConfig[] {
  return list.filter((c) => can(c, 'supportsAutomation'))
}

/** First connection flagged as local, used as default rollback target. */
export function findLocalConnection(list: ConnectionConfig[]): ConnectionConfig | undefined {
  return list.find((c) => c.environment === 'local')
}

export function canDeleteBackup(file: BackupFile | null | undefined): boolean {
  return !!file && file.source !== 'navicat'
}

/** Backups Navicat created are read-only for Vortaq; explain why delete is disabled. */
export const NAVICAT_DELETE_TOOLTIP =
  'Las copias creadas por Navicat son de solo lectura en Vortaq. Elimínalas desde Finder si ya no las necesitas.'

/** nd-pill modifier class for an environment (production in red glass). */
export function environmentPillClass(env: Environment): string {
  switch (env) {
    case 'production':
      return 'nd-pill--production'
    case 'staging':
      return 'nd-pill--staging'
    case 'local':
      return 'nd-pill--local'
    default:
      return ''
  }
}

const OBJECT_TYPE_LABELS: Record<string, string> = {
  table: 'Tabla',
  view: 'Vista',
  function: 'Función',
  procedure: 'Procedimiento',
  event: 'Evento',
  trigger: 'Disparador',
  materializedview: 'Vista materializada',
  sequence: 'Secuencia',
  type: 'Tipo',
  extension: 'Extensión'
}

/** Spanish label for a backup object type as stored in meta.json (Table, View...). */
export function backupObjectTypeLabel(type: string): string {
  return OBJECT_TYPE_LABELS[type.toLowerCase()] ?? type
}
