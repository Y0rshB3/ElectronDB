import { formatRowChangeFailure } from '@shared/rowChangeFailure'
import type { ApplyRowChangesResult, CellValue, RowChange } from '@shared/types'
import { MysqlUserError, describeError, isMysqlErrorLike } from './errors'
import type { MysqlSession } from './types'

export interface Escaper {
  escape(value: CellValue | Date | Buffer): string
  escapeId(identifier: string): string
}

/** A bound parameter: a cell value, or raw bytes for binary columns. */
export type ParamValue = CellValue | Buffer

export interface BuiltStatement {
  /** Parameterised SQL. */
  sql: string
  params: ParamValue[]
  /** Same statement with literals inlined, for display/logging by the UI only. */
  display: string
}

type Session = Pick<MysqlSession, 'execute' | 'escape' | 'escapeId'>

function target(schema: string, table: string, e: Escaper): string {
  return `${e.escapeId(schema)}.${e.escapeId(table)}`
}

/** information_schema DATA_TYPE values whose cells the grid shows as 0xHEX text. */
const BINARY_DATA_TYPES = new Set([
  'binary',
  'varbinary',
  'tinyblob',
  'blob',
  'mediumblob',
  'longblob',
  'bit',
  'geometry',
  'point',
  'linestring',
  'polygon',
  'multipoint',
  'multilinestring',
  'multipolygon',
  'geometrycollection',
  'geomcollection'
])

export function isBinaryDataType(dataType: string): boolean {
  return BINARY_DATA_TYPES.has(dataType.toLowerCase())
}

const HEX_LITERAL = /^0x((?:[0-9a-f]{2})*)$/i

/**
 * The grid renders binary cells as "0xHEX" (values.normalizeCell). Turns such
 * text back into bytes for binary columns so keys match and edits round-trip;
 * any other value is kept as typed.
 */
export function decodeBinaryValues(
  values: Record<string, CellValue>,
  binaryColumns: ReadonlySet<string>
): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {}
  for (const [column, value] of Object.entries(values)) {
    const match =
      typeof value === 'string' && binaryColumns.has(column) ? HEX_LITERAL.exec(value) : null
    out[column] = match ? Buffer.from(match[1], 'hex') : value
  }
  return out
}

function keyClause(
  key: Record<string, ParamValue>,
  e: Escaper
): { sql: string; display: string; params: ParamValue[] } {
  const columns = Object.keys(key)
  if (columns.length === 0)
    throw new MysqlUserError('No se puede modificar la fila: la tabla no tiene clave primaria')
  const sqlParts: string[] = []
  const displayParts: string[] = []
  const params: ParamValue[] = []
  for (const column of columns) {
    const value = key[column]
    const id = e.escapeId(column)
    if (value === null) {
      sqlParts.push(`${id} IS NULL`)
      displayParts.push(`${id} IS NULL`)
    } else {
      sqlParts.push(`${id} = ?`)
      displayParts.push(`${id} = ${e.escape(value)}`)
      params.push(value)
    }
  }
  return { sql: sqlParts.join(' AND '), display: displayParts.join(' AND '), params }
}

export function buildRowChangeStatement(
  change: RowChange,
  schema: string,
  table: string,
  e: Escaper,
  binaryColumns: ReadonlySet<string> = new Set()
): BuiltStatement {
  const t = target(schema, table, e)
  switch (change.kind) {
    case 'insert': {
      const values = decodeBinaryValues(change.values, binaryColumns)
      const columns = Object.keys(values)
      const ids = columns.map((c) => e.escapeId(c)).join(', ')
      const params = columns.map((c) => values[c])
      const placeholders = columns.map(() => '?').join(', ')
      const literals = params.map((v) => e.escape(v)).join(', ')
      return {
        sql: `INSERT INTO ${t} (${ids}) VALUES (${placeholders})`,
        params,
        display: `INSERT INTO ${t} (${ids}) VALUES (${literals})`
      }
    }
    case 'update': {
      const values = decodeBinaryValues(change.values, binaryColumns)
      const columns = Object.keys(values)
      if (columns.length === 0)
        throw new MysqlUserError('La actualización no contiene columnas modificadas')
      const where = keyClause(decodeBinaryValues(change.key, binaryColumns), e)
      const params = columns.map((c) => values[c])
      const set = columns.map((c) => `${e.escapeId(c)} = ?`).join(', ')
      const setDisplay = columns.map((c) => `${e.escapeId(c)} = ${e.escape(values[c])}`).join(', ')
      return {
        sql: `UPDATE ${t} SET ${set} WHERE ${where.sql}`,
        params: [...params, ...where.params],
        display: `UPDATE ${t} SET ${setDisplay} WHERE ${where.display}`
      }
    }
    case 'delete': {
      const where = keyClause(decodeBinaryValues(change.key, binaryColumns), e)
      return {
        sql: `DELETE FROM ${t} WHERE ${where.sql}`,
        params: where.params,
        display: `DELETE FROM ${t} WHERE ${where.display}`
      }
    }
    default:
      throw new MysqlUserError(
        `Tipo de cambio no soportado: ${String((change as { kind: unknown }).kind)}`
      )
  }
}

/**
 * Failure of one change of a batch, already rolled back. Its message follows
 * the shared contract (formatRowChangeFailure) so the UI can point at the row.
 * Not a MysqlUserError on purpose: server messages may quote row values, and
 * the IPC error log only keeps code/errno for other error classes.
 */
export class RowChangeError extends Error {
  readonly code: string
  readonly errno?: number
  readonly fatal?: boolean
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'RowChangeError'
    const source = isMysqlErrorLike(cause) ? cause : null
    this.code = source?.code ?? 'E_ROW_CHANGE'
    if (source?.errno !== undefined) this.errno = source.errno
    if (source?.fatal !== undefined) this.fatal = source.fatal
  }
}

/** Text after `pattern` in a server message, e.g. the column of "Column 'x' cannot be null". */
function quoted(message: string, pattern: RegExp): string | null {
  return pattern.exec(message)?.[1] ?? null
}

/**
 * Spanish, actionable reason for the server errors a row edit usually hits.
 * Never repeats the offending value (it may be row data); unknown errors keep
 * the server message and code.
 */
export function explainRowChangeError(err: unknown): string {
  if (!isMysqlErrorLike(err)) return String(err)
  const message = err.sqlMessage ?? err.message ?? ''
  const column = quoted(message, /column '((?:[^']|'')+)'/i) ?? quoted(message, /Field '([^']+)'/)
  const col = column ? `la columna «${column}»` : null
  switch (err.errno) {
    case 1048:
      return `${col ?? 'una columna'} no admite NULL`
    case 1364:
      return `${col ?? 'una columna'} es obligatoria y no tiene valor por defecto`
    case 1406:
      return `el valor es demasiado largo para ${col ?? 'una columna'}`
    case 1264:
      return `el valor está fuera de rango para ${col ?? 'una columna'}`
    case 1265:
    case 1292:
    case 1366:
    case 1367:
      return col
        ? `el valor no es válido para ${col}`
        : 'un valor no tiene el tipo que espera la columna'
    case 1054:
      return `${col ?? 'una columna'} no existe en la tabla`
    case 1062: {
      const key = quoted(message, /for key '([^']+)'/)
      return `ya existe una fila con el mismo valor en la clave única${key ? ` «${key}»` : ''}`
    }
    case 1451:
      return 'otras filas dependen de esta fila (clave foránea)'
    case 1452:
      return 'el valor no existe en la tabla referenciada (clave foránea)'
    case 1142:
    case 1143:
      return 'no tienes permisos para modificar esta tabla'
    case 1205:
      return 'la fila está bloqueada por otra transacción (tiempo de espera agotado)'
    case 1213:
      return 'conflicto de bloqueo con otra transacción; vuelve a intentarlo'
    default:
      return describeError(err)
  }
}

/**
 * Applies row edits atomically. Every UPDATE/DELETE must hit exactly one row:
 * zero means the row changed or vanished since it was loaded (or the key did
 * not match), more than one means the key is not unique. Either way the whole
 * batch is rolled back, and the error (RowChangeError) says which change
 * failed and that nothing was written. Relies on mysql2's default
 * CLIENT_FOUND_ROWS flag, so an UPDATE that sets identical values still
 * reports the matched row.
 *
 * `binaryColumns` names the table's binary columns, whose "0xHEX" cells are
 * sent back as bytes (see decodeBinaryValues).
 */
export async function applyRowChanges(
  session: Session,
  schema: string,
  table: string,
  changes: RowChange[],
  binaryColumns: ReadonlySet<string> = new Set()
): Promise<ApplyRowChangesResult> {
  if (!schema || !table) throw new MysqlUserError('Falta el esquema o la tabla')
  if (changes.length === 0) return { applied: 0, statements: [] }
  const built = changes.map((c) =>
    buildRowChangeStatement(c, schema, table, session, binaryColumns)
  )
  const failure = (i: number, reason: string, cause?: unknown): RowChangeError =>
    new RowChangeError(formatRowChangeFailure(i, changes.length, changes[i].kind, reason), cause)

  const statements: string[] = []
  const insertIds: (number | null)[] = []
  await session.execute('START TRANSACTION')
  try {
    for (let i = 0; i < built.length; i++) {
      const stmt = built[i]
      let res: Awaited<ReturnType<Session['execute']>>
      try {
        res = await session.execute(stmt.sql, stmt.params)
      } catch (err) {
        throw failure(i, explainRowChangeError(err), err)
      }
      if (changes[i].kind !== 'insert' && res.affectedRows > 1)
        throw failure(i, `afectaría ${res.affectedRows} filas en lugar de una`)
      if (changes[i].kind !== 'insert' && res.affectedRows === 0)
        throw failure(
          i,
          'la fila ya no existe o su clave cambió desde que se cargó; recarga los datos e inténtalo de nuevo'
        )
      statements.push(stmt.display)
      insertIds.push(changes[i].kind === 'insert' ? (res.insertId ?? null) : null)
    }
    await session.execute('COMMIT')
  } catch (err) {
    await session.execute('ROLLBACK').catch(() => undefined)
    throw err
  }
  return { applied: statements.length, statements, insertIds }
}
