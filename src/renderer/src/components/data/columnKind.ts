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

/** Short type label shown after a filter value, like Navicat's "[Número]". */
export function typeLabel(type: string | null | undefined): string {
  const t = (type ?? '').trim().toUpperCase()
  if (!t) return ''
  if (/^(DATETIME|TIMESTAMP)\b/.test(t)) return 'Fecha y hora'
  if (/^DATE\b/.test(t)) return 'Fecha'
  if (/^TIME\b/.test(t)) return 'Hora'
  if (/^YEAR\b/.test(t)) return 'Año'
  if (columnKind(t) === 'number') return 'Número'
  if (/^(BLOB|TINYBLOB|MEDIUMBLOB|LONGBLOB|BINARY|VARBINARY|GEOMETRY)\b/.test(t)) return 'Binario'
  return 'Texto'
}

/** Same classification from the driver's `typeKind`; falls back to the MySQL type name. */
export function columnKindOf(column: Pick<QueryColumn, 'type' | 'typeKind'>): ColumnKind {
  if (!column.typeKind) return columnKind(column.type)
  if (isNumericKind(column.typeKind)) return 'number'
  if (isTemporalKind(column.typeKind)) return 'temporal'
  return 'text'
}
