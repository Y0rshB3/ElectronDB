/**
 * SQLite cells in .vqb data files (docs/vqb-format.md, "SQLite"). SQLite is
 * dynamically typed, so every cell keeps its own storage class:
 *
 *   INTEGER → JSON integer, or {"$bigint":"…"} outside ±(2^53−1)
 *   REAL    → JSON number with a fraction, or {"$float":"…"} when the value is
 *             integral (5.0, -0.0, 1e300), infinite: a bare JSON 5 would read
 *             back as INTEGER
 *   TEXT    → JSON string
 *   BLOB    → {"$bin":"<base64>"}
 *   NULL    → null
 */
import type { CellValue, StorageClass } from '@shared/types'
import { VqbValueError, binOf, tagOf, type VqbValue } from './values'

const INT_RE = /^[+-]?\d+$/

/** .vqb value of one cell read with its storage class (Vortaq's normalised CellValue). */
export function encodeSqliteCell(value: CellValue, storage: StorageClass): VqbValue {
  if (value === null || storage === 'null') return null
  switch (storage) {
    case 'integer':
      if (typeof value === 'number') return value
      if (typeof value === 'string' && INT_RE.test(value)) return { $bigint: value }
      throw new VqbValueError('entero de SQLite no válido')
    case 'real': {
      const n = typeof value === 'number' ? value : Number(value)
      if (Number.isNaN(n)) throw new VqbValueError('real de SQLite no válido')
      if (!Number.isFinite(n) || Number.isInteger(n))
        return { $float: Object.is(n, -0) ? '-0' : String(n) }
      return n
    }
    case 'blob': {
      const text = String(value)
      const m = /^0x([0-9a-fA-F]*)$/.exec(text)
      if (!m || m[1].length % 2) throw new VqbValueError('blob de SQLite no válido')
      return { $bin: Buffer.from(m[1], 'hex').toString('base64') }
    }
    default:
      return String(value)
  }
}

/**
 * Bind parameter (for the SQLite worker's `bindable`) that stores the value
 * with the storage class it had: `{ $int }` for INTEGER, a JS number for
 * REAL, `{ $blob }` for BLOB. Values written by other engines' tags ($dec,
 * $dt, $json…) are bound as their text.
 */
export function sqliteParam(value: VqbValue): unknown {
  if (value === null) return null
  if (typeof value === 'boolean') return { $int: value ? '1' : '0' }
  if (typeof value === 'number') return Number.isInteger(value) ? { $int: String(value) } : value
  if (typeof value === 'string') return value
  const tag = tagOf(value)
  const v = value as Record<string, unknown>
  switch (tag) {
    case '$bigint':
      return { $int: String(v.$bigint) }
    case '$float':
      return Number(String(v.$float).replace(/^([+-]?)inf$/i, '$1Infinity'))
    case '$bin':
      return { $blob: '0x' + binOf(value as { $bin: string }).toString('hex') }
    case '$dec':
    case '$dt':
    case '$json':
      return String(v[tag])
    default:
      throw new VqbValueError(`valor no admitido en SQLite (${String(tag)})`)
  }
}
