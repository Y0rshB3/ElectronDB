/**
 * PostgreSQL grid saves (docs/multi-engine-design.md, section 5.4), on top of
 * the generic all-or-nothing loop (db/rowChanges.ts):
 * - binds as `$n::<sqlType>` so enums, domains, arrays, json and dates cast
 *   explicitly from the grid's text;
 * - cells the user never touched are not sent, so defaults, serials and
 *   identity columns fill themselves; `GENERATED ALWAYS` identity and
 *   generated columns are refused;
 * - INSERT … RETURNING gives the generated key back (insertIds);
 * - rows are addressed by the primary key only: a table without one is
 *   read-only in v1.
 */
import { quoteIdent } from '@shared/dialects/postgresql'
import type { ApplyRowChangesResult, CellValue, ColumnInfo, RowChange } from '@shared/types'
import { applyRowChangesAtomically } from '../db/rowChanges'
import { ServerError } from '../db/errors'
import { describeError, PgUserError, sqlState } from './errors'
import type { PgSession } from './session'

export interface PgStatement {
  sql: string
  params: unknown[]
  /** Column whose value RETURNING gives back for an insert (first PK column), if any. */
  returning: string | null
}

export const NO_PRIMARY_KEY =
  'La tabla no tiene clave primaria: sus filas no se pueden editar desde la cuadrícula (solo lectura)'

/** Grid text to a bind value: 0xHEX for bytea becomes \x…, booleans stay booleans. */
function bindValue(value: CellValue, column: ColumnInfo | undefined): unknown {
  if (value === null) return null
  if (column?.typeKind === 'binary' && typeof value === 'string' && /^0x[0-9a-f]*$/i.test(value))
    return `\\x${value.slice(2)}`
  if (typeof value === 'boolean') return value
  return String(value)
}

function castOf(column: ColumnInfo | undefined): string {
  const type = column?.sqlType ?? column?.columnType
  return type ? `::${type}` : ''
}

export function buildPgRowStatement(
  schema: string,
  table: string,
  change: RowChange,
  columns: ColumnInfo[],
  primaryKey: string[]
): PgStatement {
  const byName = new Map(columns.map((c) => [c.name, c]))
  const target = `${quoteIdent(schema)}.${quoteIdent(table)}`
  const params: unknown[] = []
  const bind = (name: string, value: CellValue): string => {
    const column = byName.get(name)
    if (!column) throw new PgUserError(`La columna ${name} no existe en ${schema}.${table}`)
    params.push(bindValue(value, column))
    return `$${params.length}${castOf(column)}`
  }
  const keyClause = (key: Record<string, CellValue>): string => {
    if (!primaryKey.length) throw new PgUserError(NO_PRIMARY_KEY)
    for (const k of primaryKey)
      if (!(k in key)) throw new PgUserError(`Falta la clave ${k} para identificar la fila`)
    return primaryKey
      .map((k) =>
        key[k] === null ? `${quoteIdent(k)} IS NULL` : `${quoteIdent(k)} = ${bind(k, key[k])}`
      )
      .join(' AND ')
  }
  const refuseGenerated = (name: string): void => {
    const c = byName.get(name)
    if (c?.generated)
      throw new PgUserError(`La columna ${name} es calculada (GENERATED): no se puede escribir`)
    if (c?.identity === 'always')
      throw new PgUserError(
        `La columna ${name} es GENERATED ALWAYS AS IDENTITY: el valor lo genera el servidor`
      )
  }

  if (change.kind === 'insert') {
    // An empty serial/identity cell means "let the server generate it": leave it out.
    const names = Object.keys(change.values).filter((n) => {
      const c = byName.get(n)
      return !(change.values[n] === null && (c?.autoIncrement || c?.identity))
    })
    names.forEach(refuseGenerated)
    const returning = primaryKey[0] ?? null
    const tail = returning ? ` RETURNING ${quoteIdent(returning)}` : ''
    if (!names.length)
      return { sql: `INSERT INTO ${target} DEFAULT VALUES${tail}`, params, returning }
    const values = names.map((n) => bind(n, change.values[n]))
    return {
      sql: `INSERT INTO ${target} (${names.map(quoteIdent).join(', ')}) VALUES (${values.join(', ')})${tail}`,
      params,
      returning
    }
  }
  if (change.kind === 'update') {
    const names = Object.keys(change.values)
    if (!names.length) throw new PgUserError('No hay cambios que aplicar en la fila')
    names.forEach((n) => {
      const c = byName.get(n)
      if (c?.generated)
        throw new PgUserError(`La columna ${n} es calculada (GENERATED): no se puede escribir`)
    })
    const set = names.map((n) => `${quoteIdent(n)} = ${bind(n, change.values[n])}`).join(', ')
    return {
      sql: `UPDATE ${target} SET ${set} WHERE ${keyClause(change.key)}`,
      params,
      returning: null
    }
  }
  return { sql: `DELETE FROM ${target} WHERE ${keyClause(change.key)}`, params, returning: null }
}

/** Display text of a statement (literals inlined for the result list only). */
export function displayPgStatement(stmt: PgStatement): string {
  return stmt.sql.replace(/\$(\d+)(::[^\s,)]+(?:\[\])?)?/g, (_m, n: string, cast?: string) => {
    const v = stmt.params[Number(n) - 1]
    const literal =
      v === null || v === undefined
        ? 'NULL'
        : typeof v === 'boolean'
          ? v
            ? 'TRUE'
            : 'FALSE'
          : `'${String(v).replace(/'/g, "''")}'`
    return `${literal}${cast ?? ''}`
  })
}

/** Spanish reason for a rejected change; SQLSTATE explained, never row values in the log. */
export function explainPgRowError(err: unknown): string {
  return describeError(err)
}

/**
 * Applies the grid changes in one transaction (`BEGIN READ WRITE`: a guarded
 * connection's sessions default to read-only, and main already checked the
 * confirmation).
 */
export async function applyPgRowChanges(
  session: PgSession,
  schema: string,
  table: string,
  changes: RowChange[],
  columns: ColumnInfo[],
  primaryKey: string[]
): Promise<ApplyRowChangesResult> {
  if (!columns.length) throw new PgUserError(`La tabla ${schema}.${table} no existe`)
  const statements = changes.map((c) => buildPgRowStatement(schema, table, c, columns, primaryKey))
  return applyRowChangesAtomically(changes, statements, {
    begin: async () => void (await session.query('BEGIN READ WRITE')),
    execute: async (stmt) => {
      const res = await session.queryArrays(stmt.sql, stmt.params)
      const id = stmt.returning && res.rows[0] ? res.rows[0][0] : null
      return {
        affectedRows: res.rowCount ?? 0,
        insertId: id === null || id === undefined ? null : (id as number | string)
      }
    },
    commit: async () => void (await session.query('COMMIT')),
    rollback: async () => void (await session.query('ROLLBACK')),
    display: displayPgStatement,
    explainError: explainPgRowError,
    // Server text (detail of 23505 quotes the duplicate value): shown, logged as code only.
    toError: (message, cause) => new ServerError(message, sqlState(cause))
  })
}
