/**
 * SQLite grid saves (docs/multi-engine-design.md, sections 2.2 and 5.4) on the
 * generic all-or-nothing loop (db/rowChanges.ts):
 * - rows are addressed by rowid (or by the primary key of a WITHOUT ROWID
 *   table); a key cell that is NULL matches with IS;
 * - each edited cell keeps its storage class (dynamic typing): an integer
 *   stays an integer, a real a real and a `0xHEX` blob a blob, whatever the
 *   declared type; text is bound as text and SQLite applies the column's
 *   affinity, as it does for any statement. STRICT tables report their own
 *   errors;
 * - untouched cells are not sent (defaults and the rowid fill themselves);
 *   generated columns are refused;
 * - one transaction (BEGIN IMMEDIATE … COMMIT).
 */
import { quoteIdent } from '@shared/dialects/sqlite'
import { affinityOf } from '@shared/sqlite/affinity'
import type {
  ApplyRowChangesResult,
  CellValue,
  ColumnInfo,
  RowChange,
  StorageClass
} from '@shared/types'
import { applyRowChangesAtomically } from '../db/rowChanges'
import type { SqliteSession } from './connection'
import { SqliteServerError, SqliteUserError, describeError, sqliteErrcode } from './errors'
import type { RowIdentity } from './introspect'

export interface SqliteStatement {
  sql: string
  params: unknown[]
}

export const NO_ROW_IDENTITY = (reason: string): string =>
  `Las filas de esta tabla no se pueden editar desde la cuadrícula: ${reason} (solo lectura)`

const INTEGER = /^[+-]?\d+$/
const REAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/
const HEX = /^0x([0-9a-f]{2})*$/i

/**
 * Bind value of a grid cell. `storage` is the class the cell had when loaded
 * (absent for new rows): the edit keeps it when the text still fits it.
 */
export function bindCell(
  value: CellValue,
  column: Pick<ColumnInfo, 'columnType'> | undefined,
  loaded?: StorageClass
): unknown {
  if (value === null) return null
  // A cell that was NULL has no class to keep: infer it like a new cell.
  const storage = loaded === 'null' ? undefined : loaded
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number')
    return Number.isInteger(value) && storage !== 'real' ? { $int: value } : value
  const text = String(value)
  const declared = (column?.columnType ?? '').toUpperCase()
  if (storage === 'blob' || (!storage && declared.includes('BLOB'))) {
    if (HEX.test(text)) return { $blob: text }
  }
  if (storage === 'integer' && INTEGER.test(text.trim())) return { $int: text.trim() }
  if (storage === 'real' && REAL.test(text.trim())) return Number(text.trim())
  // New cells in an untyped column: numbers stay numbers, as `INSERT … VALUES (5)` would.
  if (!storage && affinityOf(declared) === 'BLOB' && !declared.includes('BLOB')) {
    if (INTEGER.test(text.trim())) return { $int: text.trim() }
    if (REAL.test(text.trim())) return Number(text.trim())
  }
  return text
}

/** Key columns of `identity` as the grid names them (the rowid column or the PK). */
export function keyColumnsOf(identity: RowIdentity): { grid: string; sql: string }[] {
  if (identity.kind === 'rowid') {
    const name = identity.column ?? identity.alias
    return [
      { grid: name, sql: identity.column ? quoteIdent(identity.column, true) : identity.alias }
    ]
  }
  if (identity.kind === 'primaryKey')
    return identity.columns.map((c) => ({ grid: c, sql: quoteIdent(c, true) }))
  throw new SqliteUserError(NO_ROW_IDENTITY(identity.reason), 'E_SQLITE_NO_IDENTITY')
}

export function buildSqliteRowStatement(
  db: string,
  table: string,
  change: RowChange,
  columns: ColumnInfo[],
  identity: RowIdentity
): SqliteStatement {
  const byName = new Map(columns.map((c) => [c.name.toLowerCase(), c]))
  const target = `${quoteIdent(db, true)}.${quoteIdent(table, true)}`
  const params: unknown[] = []
  const storage = change.kind === 'delete' ? undefined : change.storage
  const column = (name: string): ColumnInfo => {
    const c = byName.get(name.toLowerCase())
    if (!c) throw new SqliteUserError(`La columna ${name} no existe en ${db}.${table}`)
    if (c.generated)
      throw new SqliteUserError(`La columna ${name} es calculada (GENERATED): no se puede escribir`)
    return c
  }
  const bind = (name: string, value: CellValue): string => {
    params.push(bindCell(value, column(name), storage?.[name]))
    return '?'
  }
  const keyClause = (key: Record<string, CellValue>): string =>
    keyColumnsOf(identity)
      .map(({ grid, sql }) => {
        if (!(grid in key))
          throw new SqliteUserError(`Falta la clave ${grid} para identificar la fila`)
        const v = key[grid]
        if (v === null) return `${sql} IS NULL`
        params.push(typeof v === 'number' && Number.isInteger(v) ? { $int: v } : v)
        return `${sql} = ?`
      })
      .join(' AND ')

  if (change.kind === 'insert') {
    // The rowid column the grid shows is not a table column: a typed rowid is inserted as
    // `rowid`, an empty one is left out (SQLite assigns it).
    const rowidName = identity.kind === 'rowid' && identity.column === null ? identity.alias : null
    const rowidKey = rowidName
      ? Object.keys(change.values).find((n) => n.toLowerCase() === rowidName)
      : undefined
    const names = Object.keys(change.values).filter((n) => {
      if (n === rowidKey) return false
      const c = byName.get(n.toLowerCase())
      return !(change.values[n] === null && c?.autoIncrement)
    })
    const cols = names.map((n) => quoteIdent(column(n).name, true))
    const values = names.map((n) => bind(n, change.values[n]))
    const rowid = rowidKey !== undefined ? change.values[rowidKey] : null
    if (rowid !== null && rowid !== '') {
      const text = String(rowid).trim()
      if (!/^[+-]?\d+$/.test(text))
        throw new SqliteUserError('El rowid de una fila nueva debe ser un número entero')
      cols.unshift(rowidName!)
      params.unshift({ $int: text })
      values.unshift('?')
    }
    if (!cols.length) return { sql: `INSERT INTO ${target} DEFAULT VALUES`, params }
    return {
      sql: `INSERT INTO ${target} (${cols.join(', ')}) VALUES (${values.join(', ')})`,
      params
    }
  }
  if (change.kind === 'update') {
    const names = Object.keys(change.values)
    if (!names.length) throw new SqliteUserError('No hay cambios que aplicar en la fila')
    const set = names
      .map((n) => `${quoteIdent(column(n).name, true)} = ${bind(n, change.values[n])}`)
      .join(', ')
    return { sql: `UPDATE ${target} SET ${set} WHERE ${keyClause(change.key)}`, params }
  }
  return { sql: `DELETE FROM ${target} WHERE ${keyClause(change.key)}`, params }
}

/** Display text of a statement (literals inlined for the result list only). */
export function displaySqliteStatement(stmt: SqliteStatement): string {
  let i = 0
  return stmt.sql.replace(/\?/g, () => {
    const v = stmt.params[i++]
    if (v === null || v === undefined) return 'NULL'
    if (typeof v === 'number') return String(v)
    if (typeof v === 'object') {
      const o = v as { $int?: unknown; $blob?: unknown }
      if (o.$int !== undefined) return String(o.$int)
      if (typeof o.$blob === 'string') return `X'${o.$blob.slice(2)}'`
    }
    return `'${String(v).replace(/'/g, "''")}'`
  })
}

/**
 * Applies the grid changes in one transaction. The caller holds the
 * connection lock and has checked the shared-transaction rule and the guard.
 */
export async function applySqliteRowChanges(
  session: SqliteSession,
  db: string,
  table: string,
  changes: RowChange[],
  columns: ColumnInfo[],
  identity: RowIdentity
): Promise<ApplyRowChangesResult> {
  if (!columns.length) throw new SqliteUserError(`La tabla ${db}.${table} no existe`)
  const statements = changes.map((c) => buildSqliteRowStatement(db, table, c, columns, identity))
  return applyRowChangesAtomically(changes, statements, {
    begin: async () => void (await session.exec('BEGIN IMMEDIATE')),
    execute: async (stmt) => {
      const r = await session.exec(stmt.sql, stmt.params)
      return { affectedRows: r.changes, insertId: r.lastInsertRowid }
    },
    commit: async () => void (await session.exec('COMMIT')),
    rollback: async () => void (await session.exec('ROLLBACK')),
    display: displaySqliteStatement,
    explainError: describeError,
    toError: (message, cause) => new SqliteServerError(message, sqliteErrcode(cause))
  })
}
