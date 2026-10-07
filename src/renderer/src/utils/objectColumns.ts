import type {
  BackupFile,
  DatabaseInfo,
  EventInfo,
  RoutineInfo,
  TableInfo,
  ViewInfo
} from '@shared/types'
import type { SavedQuery } from './savedQueries'
import { formatBytes, formatDate, formatNumber } from './format'
import type { GroupKind } from './objectTypes'

/**
 * Column definitions and detail rows for the Objects list and the Info panel.
 * Pure functions only: no store access, so they are trivially testable.
 */

export type ObjectItem = TableInfo | ViewInfo | RoutineInfo | EventInfo | SavedQuery | BackupFile

export interface ObjectColumn<T = unknown> {
  key: string
  title: string
  align?: 'start' | 'end'
  /** Raw value used for sorting. */
  value: (item: T) => string | number | null
  /** Text shown in the cell; defaults to String(value). */
  display?: (item: T) => string
}

export interface DetailRow {
  label: string
  value: string
}

const text = (v: string | null | undefined): string =>
  v === null || v === undefined || v === '' ? '' : v
const dateValue = (v: string | null | undefined): string => text(v)

function col<T>(column: ObjectColumn<T>): ObjectColumn<unknown> {
  return column as ObjectColumn<unknown>
}

export const DATABASE_COLUMNS: ObjectColumn<unknown>[] = [
  col<DatabaseInfo>({ key: 'name', title: 'Nombre', value: (d) => d.name }),
  col<DatabaseInfo>({ key: 'charset', title: 'Juego de caracteres', value: (d) => d.characterSet }),
  col<DatabaseInfo>({ key: 'collation', title: 'Intercalación', value: (d) => d.collation })
]

export const GROUP_COLUMNS: Record<GroupKind, ObjectColumn<unknown>[]> = {
  tables: [
    col<TableInfo>({ key: 'name', title: 'Nombre', value: (t) => t.name }),
    col<TableInfo>({
      key: 'rows',
      title: 'Filas',
      align: 'end',
      value: (t) => t.rows,
      display: (t) => formatNumber(t.rows)
    }),
    col<TableInfo>({
      key: 'dataLength',
      title: 'Longitud de datos',
      align: 'end',
      value: (t) => t.dataLength,
      display: (t) => formatBytes(t.dataLength)
    }),
    col<TableInfo>({ key: 'engine', title: 'Motor', value: (t) => t.engine }),
    col<TableInfo>({
      key: 'createTime',
      title: 'Fecha de creación',
      value: (t) => dateValue(t.createTime),
      display: (t) => formatDate(t.createTime)
    }),
    col<TableInfo>({
      key: 'updateTime',
      title: 'Fecha de modificación',
      value: (t) => dateValue(t.updateTime),
      display: (t) => formatDate(t.updateTime)
    }),
    col<TableInfo>({ key: 'collation', title: 'Intercalación', value: (t) => t.collation }),
    col<TableInfo>({ key: 'comment', title: 'Comentario', value: (t) => t.comment })
  ],
  views: [
    col<ViewInfo>({ key: 'name', title: 'Nombre', value: (v) => v.name }),
    col<ViewInfo>({ key: 'definer', title: 'Definidor', value: (v) => v.definer }),
    col<ViewInfo>({ key: 'security', title: 'Seguridad', value: (v) => v.security }),
    col<ViewInfo>({
      key: 'updatable',
      title: 'Actualizable',
      value: (v) => (v.updatable ? 1 : 0),
      display: (v) => (v.updatable ? 'Sí' : 'No')
    }),
    col<ViewInfo>({
      key: 'createTime',
      title: 'Fecha de creación',
      value: (v) => dateValue(v.createTime),
      display: (v) => formatDate(v.createTime)
    })
  ],
  functions: [
    col<RoutineInfo>({ key: 'name', title: 'Nombre', value: (r) => r.name }),
    col<RoutineInfo>({
      key: 'type',
      title: 'Tipo',
      value: (r) => r.type,
      display: (r) => (r.type === 'PROCEDURE' ? 'Procedimiento' : 'Función')
    }),
    col<RoutineInfo>({ key: 'returns', title: 'Devuelve', value: (r) => r.returns }),
    col<RoutineInfo>({ key: 'definer', title: 'Definidor', value: (r) => r.definer }),
    col<RoutineInfo>({
      key: 'created',
      title: 'Fecha de creación',
      value: (r) => dateValue(r.created),
      display: (r) => formatDate(r.created)
    }),
    col<RoutineInfo>({
      key: 'modified',
      title: 'Fecha de modificación',
      value: (r) => dateValue(r.modified),
      display: (r) => formatDate(r.modified)
    }),
    col<RoutineInfo>({ key: 'comment', title: 'Comentario', value: (r) => r.comment })
  ],
  events: [
    col<EventInfo>({ key: 'name', title: 'Nombre', value: (e) => e.name }),
    col<EventInfo>({ key: 'status', title: 'Estado', value: (e) => e.status }),
    col<EventInfo>({ key: 'type', title: 'Tipo', value: (e) => e.type }),
    col<EventInfo>({ key: 'schedule', title: 'Programación', value: (e) => eventSchedule(e) }),
    col<EventInfo>({ key: 'definer', title: 'Definidor', value: (e) => e.definer }),
    col<EventInfo>({
      key: 'modified',
      title: 'Fecha de modificación',
      value: (e) => dateValue(e.modified),
      display: (e) => formatDate(e.modified)
    }),
    col<EventInfo>({ key: 'comment', title: 'Comentario', value: (e) => e.comment })
  ],
  queries: [
    col<SavedQuery>({ key: 'name', title: 'Nombre', value: (q) => q.name }),
    col<SavedQuery>({ key: 'schema', title: 'Base de datos', value: (q) => q.schema }),
    col<SavedQuery>({
      key: 'updatedAt',
      title: 'Fecha de modificación',
      value: (q) => q.updatedAt,
      display: (q) => formatDate(q.updatedAt)
    })
  ],
  backups: [
    col<BackupFile>({ key: 'name', title: 'Nombre', value: (b) => b.fileName }),
    col<BackupFile>({ key: 'label', title: 'Comentario', value: (b) => b.label }),
    col<BackupFile>({
      key: 'size',
      title: 'Tamaño',
      align: 'end',
      value: (b) => b.sizeBytes,
      display: (b) => formatBytes(b.sizeBytes)
    }),
    col<BackupFile>({
      key: 'modifiedAt',
      title: 'Fecha de modificación',
      value: (b) => b.modifiedAt,
      display: (b) => formatDate(b.modifiedAt)
    }),
    col<BackupFile>({
      key: 'source',
      title: 'Origen',
      value: (b) => b.source,
      display: (b) => BACKUP_SOURCE_LABELS[b.source] ?? b.source
    })
  ]
}

const BACKUP_SOURCE_LABELS: Record<string, string> = {
  navicat: 'Navicat',
  vortaq: 'Vortaq',
  unknown: 'Desconocido'
}

export function eventSchedule(e: EventInfo): string {
  if (e.executeAt) return `Una vez: ${formatDate(e.executeAt)}`
  if (e.intervalValue && e.intervalField) return `Cada ${e.intervalValue} ${e.intervalField}`
  return ''
}

export function cellText(column: ObjectColumn<unknown>, item: unknown): string {
  if (column.display) return column.display(item)
  const v = column.value(item)
  return v === null || v === undefined ? '' : String(v)
}

/** Identifier used in tree node ids (saved query id, backup path or object name). */
export function itemName(group: GroupKind, item: unknown): string {
  const raw = item as { name?: string; id?: string; path?: string }
  if (group === 'queries') return raw.id ?? ''
  if (group === 'backups') return raw.path ?? ''
  return raw.name ?? ''
}

/** Human label for an item. */
export function itemLabel(group: GroupKind, item: unknown): string {
  const raw = item as { name?: string; fileName?: string }
  if (group === 'backups') return raw.fileName ?? ''
  return raw.name ?? ''
}

export function compareCells(a: string | number | null, b: string | number | null): number {
  if (a === b) return 0
  if (a === null || a === '') return -1
  if (b === null || b === '') return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), 'es', { numeric: true, sensitivity: 'base' })
}

export function sortItems<T>(
  items: T[],
  column: ObjectColumn<unknown> | undefined,
  desc: boolean
): T[] {
  if (!column) return items
  const sorted = [...items].sort((x, y) => compareCells(column.value(x), column.value(y)))
  return desc ? sorted.reverse() : sorted
}

export function filterItems<T>(items: T[], group: GroupKind | null, query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter((item) => {
    const label = group ? itemLabel(group, item) : ((item as { name?: string }).name ?? '')
    return label.toLowerCase().includes(q)
  })
}

const row = (label: string, value: string | null | undefined): DetailRow => ({
  label,
  value: text(value) || '—'
})

/** Detail rows shown in the Info panel for a selected object. */
export function objectDetails(group: GroupKind, item: unknown): DetailRow[] {
  switch (group) {
    case 'tables': {
      const t = item as TableInfo
      return [
        row('Filas', formatNumber(t.rows)),
        row('Motor', t.engine),
        row('Longitud de datos', formatBytes(t.dataLength)),
        row('Longitud de índice', formatBytes(t.indexLength)),
        row('Auto incremento', formatNumber(t.autoIncrement)),
        row('Fecha de creación', formatDate(t.createTime)),
        row('Fecha de modificación', formatDate(t.updateTime)),
        row('Intercalación', t.collation),
        row('Comentario', t.comment)
      ]
    }
    case 'views': {
      const v = item as ViewInfo
      return [
        row('Definidor', v.definer),
        row('Seguridad', v.security),
        row('Actualizable', v.updatable ? 'Sí' : 'No'),
        row('Fecha de creación', formatDate(v.createTime ?? null))
      ]
    }
    case 'functions': {
      const r = item as RoutineInfo
      return [
        row('Tipo', r.type === 'PROCEDURE' ? 'Procedimiento' : 'Función'),
        row('Devuelve', r.returns),
        row('Definidor', r.definer),
        row('Fecha de creación', formatDate(r.created)),
        row('Fecha de modificación', formatDate(r.modified)),
        row('Comentario', r.comment)
      ]
    }
    case 'events': {
      const e = item as EventInfo
      return [
        row('Estado', e.status),
        row('Tipo', e.type),
        row('Programación', eventSchedule(e)),
        row('Inicio', formatDate(e.starts)),
        row('Fin', formatDate(e.ends)),
        row('Definidor', e.definer),
        row('Fecha de modificación', formatDate(e.modified)),
        row('Comentario', e.comment)
      ]
    }
    case 'queries': {
      const q = item as SavedQuery
      return [row('Base de datos', q.schema), row('Fecha de modificación', formatDate(q.updatedAt))]
    }
    case 'backups': {
      const b = item as BackupFile
      return [
        row('Archivo', b.fileName),
        row('Tamaño', formatBytes(b.sizeBytes)),
        row('Fecha de modificación', formatDate(b.modifiedAt)),
        row('Origen', BACKUP_SOURCE_LABELS[b.source] ?? b.source),
        row('Comentario', b.label),
        row('Ruta', b.path)
      ]
    }
  }
}

/** Singular, lowercase noun for a group, used in toolbar labels ("Abrir tabla"). */
export const GROUP_SINGULAR: Record<GroupKind, string> = {
  tables: 'tabla',
  views: 'vista',
  functions: 'función',
  events: 'evento',
  queries: 'consulta',
  backups: 'copia de seguridad'
}
