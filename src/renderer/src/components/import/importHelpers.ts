import type {
  ImportConnectionItem,
  ImportConnectionsPreview,
  SqlDumpImportResult,
  SqlObjectCounts
} from '@shared/importers'
import type { ProgressEvent } from '@shared/types'
import { formatBytes, formatNumber } from '@renderer/utils/format'

/** Status of a previewed connection in the selection table. */
export type ConnectionRowStatus = 'new' | 'existing' | 'unsupported'

export function connectionRowStatus(item: ImportConnectionItem): ConnectionRowStatus {
  if (item.unsupportedReason || !item.engine) return 'unsupported'
  return item.existingConnectionId ? 'existing' : 'new'
}

export const ROW_STATUS_LABEL: Record<ConnectionRowStatus, string> = {
  new: 'nueva',
  existing: 'ya importada',
  unsupported: 'no soportada'
}

/** Rows preselected after a preview: importable connections not imported yet. */
export function defaultSelection(preview: ImportConnectionsPreview): string[] {
  return preview.items.filter((i) => connectionRowStatus(i) === 'new').map((i) => i.key)
}

/** Keys of the rows that can be ticked (unsupported ones cannot). */
export function selectableKeys(preview: ImportConnectionsPreview | null): string[] {
  return (preview?.items ?? []).filter((i) => connectionRowStatus(i) !== 'unsupported').map((i) => i.key)
}

/** One line of the live log of a SQL import. */
export interface ImportLogEntry {
  id: number
  tone: 'ok' | 'info' | 'warning' | 'error' | 'section'
  text: string
  /** Second line (statement excerpt of an error, file of a package step). */
  detail?: string
  /** Key of an entry that updates in place (safety copy progress). */
  sticky?: string
}

/** Upper bound of log lines kept in memory (errors are never dropped). */
export const LOG_LIMIT = 2000

/**
 * Turns a progress event of an import into a log entry; null for events that
 * only move the counters (periodic 'statement' events and the final done event).
 */
export function logEntryOf(event: ProgressEvent, id: number): ImportLogEntry | null {
  const d = event.detail
  switch (event.phase) {
    case 'object':
      return { id, tone: 'ok', text: event.message }
    case 'objectError':
      return {
        id,
        tone: 'error',
        text: d?.error ? `${event.message}: ${d.error}` : event.message,
        detail: d?.objectName
      }
    case 'database':
    case 'start':
    case 'finish':
      return { id, tone: 'info', text: event.message }
    case 'warning':
      return { id, tone: 'warning', text: event.message }
    case 'file':
      return { id, tone: 'section', text: event.message }
    case 'safety':
      return { id, tone: 'info', text: event.message, sticky: 'safety' }
    default:
      return null
  }
}

/**
 * Appends an entry: a sticky entry replaces the previous one with the same
 * key when it is the last line; past LOG_LIMIT the oldest non-error lines go.
 */
export function appendLog(log: ImportLogEntry[], entry: ImportLogEntry): ImportLogEntry[] {
  const last = log[log.length - 1]
  const next =
    entry.sticky && last?.sticky === entry.sticky ? [...log.slice(0, -1), entry] : [...log, entry]
  if (next.length <= LOG_LIMIT) return next
  const drop = next.findIndex((e) => e.tone !== 'error' && e.tone !== 'section')
  return drop < 0 ? next.slice(1) : [...next.slice(0, drop), ...next.slice(drop + 1)]
}

/** «1,2 MB de 8,0 MB» for a byte-based progress event. */
export function bytesProgress(current: number, total: number | null): string {
  if (!total) return formatBytes(current)
  return `${formatBytes(current)} de ${formatBytes(total)}`
}

const COUNT_LABELS: [keyof SqlObjectCounts, string, string][] = [
  ['databases', 'base de datos', 'bases de datos'],
  ['tables', 'tabla', 'tablas'],
  ['views', 'vista', 'vistas'],
  ['routines', 'rutina', 'rutinas'],
  ['triggers', 'trigger', 'triggers'],
  ['events', 'evento', 'eventos']
]

/** «3 tablas, 1 vista, 2 rutinas» (zero counts left out); '' when everything is zero. */
export function describeCounts(counts: SqlObjectCounts | null | undefined): string {
  if (!counts) return ''
  return COUNT_LABELS.filter(([key]) => (counts[key] ?? 0) > 0)
    .map(([key, one, many]) => `${formatNumber(counts[key])} ${counts[key] === 1 ? one : many}`)
    .join(', ')
}

/** Headline of a finished dump import. */
export function dumpSummary(result: SqlDumpImportResult): string {
  const statements = `${formatNumber(result.executed)} de ${formatNumber(result.statements)} sentencias`
  const rows = `${formatNumber(result.rowsAffected)} ${result.rowsAffected === 1 ? 'fila' : 'filas'}`
  const created = describeCounts(result.created)
  return [statements, rows, created && `creados: ${created}`].filter(Boolean).join(' · ')
}

/**
 * Database name proposed for a dump file: the file name without .sql / .sql.gz,
 * trimmed to MySQL's 64-character limit.
 */
export function schemaFromFileName(fileName: string): string {
  return fileName
    .replace(/\.sql(\.gz)?$/i, '')
    .trim()
    .slice(0, 64)
}

/** Problem with a target database name typed by the user, or null. */
export function schemaNameProblem(name: string): string | null {
  const value = name.trim()
  if (!value) return 'Indica la base de datos de destino.'
  if (value.length > 64) return 'El nombre no puede tener más de 64 caracteres.'
  if (/[/\\.]|\s$/.test(value)) return 'El nombre no puede contener «/», «\\» ni «.».'
  if (['mysql', 'information_schema', 'performance_schema', 'sys'].includes(value.toLowerCase()))
    return `«${value}» es una base de datos del sistema.`
  return null
}

/** Duplicate target names in a package (case-insensitive), for the folder table. */
export function duplicateSchemas(names: string[]): Set<string> {
  const seen = new Map<string, number>()
  for (const n of names) {
    const key = n.trim().toLowerCase()
    if (key) seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k))
}
