/**
 * SQLite type affinity (sqlite.org/datatype3.html, section 3.1) and the
 * engine-neutral TypeKind of a declared type. Pure: main (introspection,
 * results, edits) and the renderer (designer) both use it.
 */
import type { TypeKind } from '../types'

export type SqliteAffinity = 'INTEGER' | 'TEXT' | 'BLOB' | 'REAL' | 'NUMERIC'

/** The five rules in order: INT, CHAR/CLOB/TEXT, BLOB or none, REAL/FLOA/DOUB, else NUMERIC. */
export function affinityOf(declared: string | null | undefined): SqliteAffinity {
  const t = (declared ?? '').toUpperCase()
  if (t.includes('INT')) return 'INTEGER'
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT'
  if (t === '' || t.includes('BLOB')) return 'BLOB'
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL'
  return 'NUMERIC'
}

/**
 * TypeKind for the grid editors and alignment. Date and time names win over
 * the affinity (DATETIME has NUMERIC affinity but holds text dates). Booleans
 * stay integers: SQLite stores them as 0/1.
 */
export function sqliteTypeKind(declared: string | null | undefined): TypeKind {
  const t = (declared ?? '').toUpperCase().trim()
  if (t === '') return 'other'
  if (/\b(DATETIME|TIMESTAMP)\b/.test(t)) return 'datetime'
  if (/\bDATE\b/.test(t)) return 'date'
  if (/\bTIME\b/.test(t)) return 'time'
  if (/\bJSONB?\b/.test(t)) return 'json'
  switch (affinityOf(t)) {
    case 'INTEGER':
      return 'integer'
    case 'TEXT':
      return 'text'
    case 'BLOB':
      return 'binary'
    case 'REAL':
      return 'float'
    default:
      return /\b(BOOL|BOOLEAN)\b/.test(t) ? 'integer' : 'decimal'
  }
}
