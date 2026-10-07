import type { ColumnInfo, TableStructure, TypeKind } from '@shared/types'

/*
 * Engine-neutral column and table metadata (docs/multi-engine-design.md,
 * section 2.1). Drivers fill `typeKind`, `primaryKey`, `autoIncrement` and
 * `kind`; when a field is absent (the MySQL driver does not send them yet)
 * each helper falls back to the exact MySQL check the renderer used before.
 */

const NUMERIC_KINDS: ReadonlySet<TypeKind> = new Set<TypeKind>(['integer', 'decimal', 'float'])
const TEMPORAL_KINDS: ReadonlySet<TypeKind> = new Set<TypeKind>(['date', 'time', 'datetime'])

export const isNumericKind = (kind: TypeKind): boolean => NUMERIC_KINDS.has(kind)
export const isTemporalKind = (kind: TypeKind): boolean => TEMPORAL_KINDS.has(kind)

/** AUTO_INCREMENT / identity / serial column. Fallback: MySQL EXTRA contains auto_increment. */
export function isAutoIncrementColumn(c: Pick<ColumnInfo, 'extra' | 'autoIncrement'>): boolean {
  return c.autoIncrement ?? /auto_increment/i.test(c.extra)
}

/** Column is part of the primary key. Fallback: MySQL COLUMN_KEY 'PRI'. */
export function isPrimaryKeyColumn(c: Pick<ColumnInfo, 'key' | 'primaryKey'>): boolean {
  return c.primaryKey ?? c.key === 'PRI'
}

/**
 * True for views (and materialized views): their rows are not edited in place.
 * Fallback: information_schema TABLE_TYPE other than 'BASE TABLE'; older
 * payloads lack tableType, and an index list still only exists for base tables.
 */
export function isViewLike(structure: Pick<TableStructure, 'kind' | 'tableType'>): boolean {
  if (structure.kind) return structure.kind === 'view' || structure.kind === 'materialized-view'
  return !!structure.tableType && structure.tableType !== 'BASE TABLE'
}
