/**
 * Table designer changes on SQLite (docs/multi-engine-design.md, section 8.1):
 * in-place statements in one transaction, or the extended rebuild procedure
 * (src/shared/sqlite/rebuild.ts). Main reads everything the rebuild depends on
 * itself, inside the transaction: the dependent triggers and views, the
 * sqlite_sequence row and the baseline foreign key violations. Only violations
 * that were not there before abort the rebuild; pre-existing ones come back
 * as warnings. PRAGMA foreign_keys is always restored.
 */
import { performance } from 'node:perf_hooks'
import { quoteIdent, sqliteDialect } from '@shared/dialects/sqlite'
import {
  FOREIGN_KEY_CHECK,
  buildRebuildScript,
  mentionsTable,
  tempTableName
} from '@shared/sqlite/rebuild'
import type {
  SqliteAlterRequest,
  SqliteAlterResult,
  SqliteTableDependent,
  SqliteTableDependents
} from '@shared/types'
import type { SqliteQueryable } from './introspect'
import { NO_TAB, type SqliteDriverConnection, type SqliteSession } from './connection'
import { SqliteUserError } from './errors'

type Row = Record<string, unknown>

const q = (name: string): string => quoteIdent(name, true)

/** Triggers on the table plus triggers and views whose SQL names it, in sqlite_schema order. */
export async function readDependents(
  s: SqliteQueryable,
  schema: string,
  table: string
): Promise<SqliteTableDependent[]> {
  const rows = await s.query<Row>(
    `SELECT type, name, tbl_name, sql FROM ${q(schema)}.sqlite_schema
      WHERE type IN ('trigger', 'view') AND sql IS NOT NULL ORDER BY rowid`
  )
  const lower = table.toLowerCase()
  return rows
    .filter((r) => {
      const sql = String(r.sql)
      if (r.type === 'trigger' && String(r.tbl_name).toLowerCase() === lower) return true
      return mentionsTable(sql, table)
    })
    .map((r) => ({
      type: r.type === 'view' ? 'view' : 'trigger',
      name: String(r.name),
      sql: String(r.sql)
    }))
}

async function readSequence(
  s: SqliteQueryable,
  schema: string,
  table: string
): Promise<number | null> {
  const has = await s.query<Row>(
    `SELECT 1 FROM ${q(schema)}.sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'`
  )
  if (!has.length) return null
  const [row] = await s.query<Row>(
    `SELECT seq FROM ${q(schema)}.sqlite_sequence WHERE name = ? COLLATE NOCASE`,
    [table]
  )
  return row && typeof row.seq === 'number' ? row.seq : null
}

async function foreignKeysOn(s: SqliteQueryable): Promise<boolean> {
  const [row] = await s.query<{ foreign_keys: number }>('PRAGMA foreign_keys')
  return row?.foreign_keys === 1
}

export async function tableDependents(
  s: SqliteQueryable,
  schema: string,
  table: string
): Promise<SqliteTableDependents> {
  return {
    dependents: await readDependents(s, schema, table),
    sequence: await readSequence(s, schema, table),
    foreignKeys: await foreignKeysOn(s)
  }
}

interface Violation {
  table: string
  rowid: unknown
  parent: string
  fkid: unknown
}

async function violations(s: SqliteSession, schema: string): Promise<Violation[]> {
  const rows = await s.query<Row>(`PRAGMA ${q(schema)}.foreign_key_check`)
  return rows.map((r) => ({
    table: String(r.table),
    rowid: r.rowid ?? null,
    parent: String(r.parent),
    fkid: r.fkid ?? null
  }))
}

const violationKey = (v: Violation): string =>
  JSON.stringify([v.table.toLowerCase(), v.rowid, v.parent.toLowerCase(), v.fkid])

function summarise(list: Violation[]): string[] {
  const counts = new Map<string, number>()
  for (const v of list) {
    const key = `${v.table}\u0000${v.parent}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()].map(([key, n]) => {
    const [table, parent] = key.split('\u0000')
    return `${table}: ${n} fila(s) sin su fila en ${parent}`
  })
}

/** Each statement the renderer sends must be exactly one statement. */
function single(sql: unknown, what: string): string {
  if (typeof sql !== 'string' || !sql.trim())
    throw new SqliteUserError(`${what} no válida.`, 'E_SQLITE_DESIGN')
  const parts = sqliteDialect.splitStatements(sql)
  if (parts.length !== 1)
    throw new SqliteUserError(`${what} debe ser una sola sentencia.`, 'E_SQLITE_DESIGN')
  return parts[0].sql.replace(/;\s*$/, '')
}

function validate(request: SqliteAlterRequest): void {
  if (!request || typeof request.newName !== 'string' || !request.newName.trim())
    throw new SqliteUserError('Falta el nombre de la tabla.', 'E_SQLITE_DESIGN')
  if (!Array.isArray(request.statements))
    throw new SqliteUserError('Cambios de la tabla no válidos.', 'E_SQLITE_DESIGN')
  request.statements = request.statements.map((st) => single(st, 'Una sentencia del diseño'))
  const r = request.rebuild
  if (r) {
    if (request.table === null)
      throw new SqliteUserError('Una tabla nueva no se reconstruye.', 'E_SQLITE_DESIGN')
    if (typeof r.createBody !== 'string' || !r.createBody.trim().startsWith('('))
      throw new SqliteUserError('Definición de la tabla no válida.', 'E_SQLITE_DESIGN')
    single(`CREATE TABLE x ${r.createBody}`, 'La definición de la tabla')
    r.indexes = r.indexes.map((ix) => {
      const sql = single(ix, 'Un índice')
      if (!/^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(sql))
        throw new SqliteUserError('Un índice del diseño no es CREATE INDEX.', 'E_SQLITE_DESIGN')
      return sql
    })
    for (const c of r.columnMap)
      if (typeof c.target !== 'string' || typeof c.source !== 'string')
        throw new SqliteUserError('Columnas del diseño no válidas.', 'E_SQLITE_DESIGN')
  }
}

/**
 * Applies a designer request. The caller has checked the production guard;
 * this holds the connection lock, refuses while a query tab owns the open
 * transaction and lifts query_only for the change on a guarded connection.
 */
export async function alterSqliteTable(
  connection: SqliteDriverConnection,
  schema: string,
  request: SqliteAlterRequest
): Promise<SqliteAlterResult> {
  validate(request)
  const started = performance.now()
  return connection.exclusive(async (s) => {
    connection.assertCanWrite(NO_TAB, 'Diseñar la tabla')
    const lifted = await connection.liftGuard(true)
    try {
      const result = request.rebuild
        ? await rebuild(s, schema, request)
        : await inPlace(s, request.statements)
      return { ...result, durationMs: Math.round(performance.now() - started) }
    } finally {
      await connection.restoreGuard(lifted)
    }
  })
}

async function inPlace(
  s: SqliteSession,
  statements: string[]
): Promise<Omit<SqliteAlterResult, 'durationMs'>> {
  if (!statements.length) return { applied: [], warnings: [] }
  await s.exec('BEGIN')
  try {
    for (const st of statements) await s.exec(st)
    await s.exec('COMMIT')
  } catch (err) {
    await s.exec('ROLLBACK').catch(() => undefined)
    throw err
  }
  return { applied: statements, warnings: [] }
}

async function rebuild(
  s: SqliteSession,
  schema: string,
  request: SqliteAlterRequest
): Promise<Omit<SqliteAlterResult, 'durationMs'>> {
  const definition = request.rebuild!
  const foreignKeys = await foreignKeysOn(s)
  const baseline = await violations(s, schema)
  const known = new Set(baseline.map(violationKey))
  const applied: string[] = []
  const run = async (sql: string): Promise<void> => {
    await s.exec(sql)
    applied.push(sql)
  }
  let open = false
  await run('PRAGMA foreign_keys = OFF')
  try {
    await run('BEGIN')
    open = true
    for (const st of request.statements) await run(st)
    // Read after the in-place steps: a rename has already rewritten the dependents.
    const table = request.newName
    const exists = await s.query<Row>(
      `SELECT 1 FROM ${q(schema)}.sqlite_schema WHERE type = 'table' AND name = ? COLLATE NOCASE`,
      [table]
    )
    if (!exists.length)
      throw new SqliteUserError(`La tabla ${table} no existe en ${schema}.`, 'E_SQLITE_NO_TABLE')
    const clash = await s.query<Row>(
      `SELECT 1 FROM ${q(schema)}.sqlite_schema WHERE name = ? COLLATE NOCASE`,
      [tempTableName(table)]
    )
    if (clash.length)
      throw new SqliteUserError(
        `Ya existe ${tempTableName(table)}: elimínala antes de reconstruir la tabla.`,
        'E_SQLITE_DESIGN'
      )
    const script = buildRebuildScript(definition, [], {
      schema,
      table,
      dependents: await readDependents(s, schema, table),
      sequence: await readSequence(s, schema, table),
      foreignKeys
    })
    // script.body starts with BEGIN (already open) and ends with the check and COMMIT.
    for (const st of script.body.slice(1)) {
      if (st === FOREIGN_KEY_CHECK) {
        const fresh = (await violations(s, schema)).filter((v) => !known.has(violationKey(v)))
        if (fresh.length)
          throw new SqliteUserError(
            `La nueva estructura deja filas sin su fila referenciada (${summarise(fresh).join('; ')}). No se aplicó ningún cambio.`,
            'E_SQLITE_FK_VIOLATION'
          )
        continue
      }
      await run(st)
      if (st === 'COMMIT') open = false
    }
  } catch (err) {
    if (open) await s.exec('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    await s.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`).catch(() => undefined)
  }
  applied.push(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`)
  return {
    applied,
    warnings: baseline.length
      ? summarise(baseline).map((w) => `${w} (ya existían antes del cambio)`)
      : []
  }
}
