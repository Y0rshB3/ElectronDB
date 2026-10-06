import type { BackupFile, ConnectionConfig, Environment } from '@shared/types'

export const SOURCE_CHIPS: Record<BackupFile['source'], { label: string; color: string }> = {
  navicat: { label: 'Navicat', color: 'warning' },
  electrondb: { label: 'ElectronDB', color: 'primary' },
  unknown: { label: 'Desconocido', color: 'secondary' }
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

/** First connection flagged as local, used as default rollback target. */
export function findLocalConnection(list: ConnectionConfig[]): ConnectionConfig | undefined {
  return list.find((c) => c.environment === 'local')
}

export function canDeleteBackup(file: BackupFile | null | undefined): boolean {
  return !!file && file.source !== 'navicat'
}

/** Backups Navicat created are read-only for ElectronDB; explain why delete is disabled. */
export const NAVICAT_DELETE_TOOLTIP =
  'Las copias creadas por Navicat son de solo lectura en ElectronDB. Elimínalas desde Finder si ya no las necesitas.'

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
  trigger: 'Disparador'
}

/** Spanish label for a backup object type as stored in meta.json (Table, View...). */
export function backupObjectTypeLabel(type: string): string {
  return OBJECT_TYPE_LABELS[type.toLowerCase()] ?? type
}
