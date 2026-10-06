import type { ObjectType } from '@shared/types'

export type GroupKind = 'tables' | 'views' | 'functions' | 'events' | 'queries' | 'backups'

export const GROUPS: GroupKind[] = ['tables', 'views', 'functions', 'events', 'queries', 'backups']

export const GROUP_LABELS: Record<GroupKind, string> = {
  tables: 'Tablas',
  views: 'Vistas',
  functions: 'Funciones',
  events: 'Eventos',
  queries: 'Consultas',
  backups: 'Copias de seguridad'
}

export const GROUP_ICONS: Record<GroupKind, string> = {
  tables: 'mdi-table',
  views: 'mdi-table-eye',
  functions: 'mdi-function-variant',
  events: 'mdi-calendar-clock',
  queries: 'mdi-database-search',
  backups: 'mdi-archive'
}

export const OBJECT_TYPE_LABELS: Record<ObjectType, string> = {
  table: 'tabla',
  view: 'vista',
  function: 'función',
  procedure: 'procedimiento',
  event: 'evento',
  trigger: 'trigger'
}

/** Label with its article, for questions such as "¿Eliminar la tabla «x»?". */
export const OBJECT_TYPE_WITH_ARTICLE: Record<ObjectType, string> = {
  table: 'la tabla',
  view: 'la vista',
  function: 'la función',
  procedure: 'el procedimiento',
  event: 'el evento',
  trigger: 'el trigger'
}

export const OBJECT_ICONS: Record<ObjectType, string> = {
  table: 'mdi-table',
  view: 'mdi-table-eye',
  function: 'mdi-function-variant',
  procedure: 'mdi-script-text-outline',
  event: 'mdi-calendar-clock',
  trigger: 'mdi-flash-outline'
}

export const ENVIRONMENT_LABELS: Record<string, string> = {
  local: 'Local',
  staging: 'Staging',
  production: 'Producción',
  other: 'Otro'
}

export const ENVIRONMENT_COLORS: Record<string, string> = {
  local: 'success',
  staging: 'warning',
  production: 'error',
  other: 'secondary'
}

export const CONNECTION_COLOR_PRESETS: { label: string; value: string | null }[] = [
  { label: 'Ninguno', value: null },
  { label: 'Verde', value: '#69f0ae' },
  { label: 'Amarillo', value: '#ffc107' },
  { label: 'Rojo', value: '#ff5252' },
  { label: 'Azul', value: '#448aff' },
  { label: 'Naranja', value: '#ff9100' },
  { label: 'Violeta', value: '#b388ff' },
  { label: 'Rosa', value: '#ff80ab' },
  { label: 'Gris', value: '#90a4ae' }
]
