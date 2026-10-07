import type { QueryColumn } from '@shared/types'
import { isNumericKind, isTemporalKind } from '@renderer/utils/columnMeta'

/**
 * Visual classification of a result column from its MySQL type name (as sent by
 * the main process, e.g. "INT UNSIGNED", "DECIMAL", "DATETIME"). Only used for
 * presentation: numbers are right aligned in mono, temporal values in mono.
 */
export type ColumnKind = 'number' | 'temporal' | 'text'

const NUMBER =
  /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|YEAR|BIT)\b/i
const TEMPORAL = /^(DATE|TIME|DATETIME|TIMESTAMP)\b/i

export function columnKind(type: string | null | undefined): ColumnKind {
  const t = (type ?? '').trim()
  if (NUMBER.test(t)) return 'number'
  if (TEMPORAL.test(t)) return 'temporal'
  return 'text'
}

export interface ValueHint {
  /** Placeholder shown in a filter value input. */
  placeholder: string
  /** Virtual keyboard / input mode hint. */
  inputmode: 'decimal' | 'text'
}

/**
 * Input hint for typing a value of this column (filter builder): the literal
 * format MySQL expects for temporal types, "Número" for numeric ones.
 */
export function valueHint(type: string | null | undefined): ValueHint {
  const t = (type ?? '').trim().toUpperCase()
  if (/^YEAR\b/.test(t)) return { placeholder: 'AAAA', inputmode: 'decimal' }
  if (/^(DATETIME|TIMESTAMP)\b/.test(t))
    return { placeholder: 'AAAA-MM-DD hh:mm:ss', inputmode: 'text' }
  if (/^DATE\b/.test(t)) return { placeholder: 'AAAA-MM-DD', inputmode: 'text' }
  if (/^TIME\b/.test(t)) return { placeholder: 'hh:mm:ss', inputmode: 'text' }
  if (columnKind(t) === 'number') return { placeholder: 'Número', inputmode: 'decimal' }
  return { placeholder: 'Valor', inputmode: 'text' }
}

/** Kind of value a filter condition compares, shown as a small chip after the value ("número"). */
export function typeLabel(type: string | null | undefined): string {
  const t = (type ?? '').trim().toUpperCase()
  if (!t) return ''
  if (/^(DATETIME|TIMESTAMP)\b/.test(t)) return 'fecha y hora'
  if (/^DATE\b/.test(t)) return 'fecha'
  if (/^TIME\b/.test(t)) return 'hora'
  if (/^YEAR\b/.test(t)) return 'año'
  if (columnKind(t) === 'number') return 'número'
  if (/^(BLOB|TINYBLOB|MEDIUMBLOB|LONGBLOB|BINARY|VARBINARY|GEOMETRY)\b/.test(t)) return 'binario'
  return 'texto'
}

/** Same classification from the driver's `typeKind`; falls back to the MySQL type name. */
export function columnKindOf(column: Pick<QueryColumn, 'type' | 'typeKind'>): ColumnKind {
  if (!column.typeKind) return columnKind(column.type)
  if (isNumericKind(column.typeKind)) return 'number'
  if (isTemporalKind(column.typeKind)) return 'temporal'
  return 'text'
}
