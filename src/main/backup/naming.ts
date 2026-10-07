import { NB3_EXTENSION } from './nb3/format'

/**
 * Navicat backup file names: `YYYYMMDDHHmmss[-label| label].nb3`, timestamp in local time.
 */

const NAME_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:[- ](.*))?\.nb3$/i

export interface ParsedBackupName {
  createdAt: string | null
  label: string | null
}

export function parseBackupFileName(fileName: string): ParsedBackupName {
  const m = NAME_RE.exec(fileName)
  if (!m) return { createdAt: null, label: null }
  const [, y, mo, d, h, mi, s, label] = m
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  const valid =
    !Number.isNaN(date.getTime()) &&
    date.getMonth() === Number(mo) - 1 &&
    date.getDate() === Number(d) &&
    date.getHours() === Number(h)
  return { createdAt: valid ? date.toISOString() : null, label: label?.trim() || null }
}

const pad = (n: number): string => String(n).padStart(2, '0')

export function formatBackupStamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

const UNSAFE_LABEL_CHARS = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|'])

/** Maps path separators, reserved characters and C0/DEL control characters to '-'. */
function replaceUnsafe(label: string): string {
  let out = ''
  for (const ch of label) {
    const code = ch.charCodeAt(0)
    out += code < 0x20 || code === 0x7f || UNSAFE_LABEL_CHARS.has(ch) ? '-' : ch
  }
  return out
}

/** Removes path separators and control characters; keeps the label readable. */
export function sanitizeLabel(label: string | undefined | null): string {
  if (!label) return ''
  return replaceUnsafe(label)
    .replace(/-+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-.\s]+|[-.\s]+$/g, '')
    .slice(0, 80)
}

export function formatBackupFileName(date: Date, label?: string | null): string {
  const clean = sanitizeLabel(label)
  return `${formatBackupStamp(date)}${clean ? `-${clean}` : ''}${NB3_EXTENSION}`
}

export const isBackupFileName = (name: string): boolean =>
  name.toLowerCase().endsWith(NB3_EXTENSION)

/** Extension of plain SQL dumps written by «Exportar a .sql» (`.sql.gz` when compressed). */
export const SQL_DUMP_EXTENSION = '.sql'

/** `YYYYMMDDHHmmss[-label].sql[.gz]`: same stamp and label rules as the .nb3 names. */
export function formatSqlDumpFileName(date: Date, label?: string | null, gzip = false): string {
  const clean = sanitizeLabel(label)
  return `${formatBackupStamp(date)}${clean ? `-${clean}` : ''}${SQL_DUMP_EXTENSION}${gzip ? '.gz' : ''}`
}

/** True for `.sql` and `.sql.gz` file names. */
export const isSqlDumpFileName = (name: string): boolean => /\.sql(\.gz)?$/i.test(name)
