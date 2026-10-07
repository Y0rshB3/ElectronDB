/**
 * SQL dialect registry (docs/multi-engine-design.md, section 6). Only MySQL
 * ships a dialect in P1a; MariaDB, PostgreSQL and SQLite register theirs in
 * their own phases. MongoDB never has one (its classifier lives elsewhere).
 */
import { engineOf } from '../engines'
import type { EngineId } from '../types'
import { mysqlDialect } from './mysql'
import type { SqlDialect, SqlDialectId } from './types'

export type { LexRules, SqlDialect, SqlDialectId, SqlStatement, WriteCheck } from './types'
export { mysqlDialect } from './mysql'

const DIALECTS: Partial<Record<SqlDialectId, SqlDialect>> = {
  mysql: mysqlDialect
}

/** The dialect with this id; throws when this build does not include it. */
export function getDialect(id: SqlDialectId): SqlDialect {
  const dialect = DIALECTS[id]
  if (!dialect) {
    throw new Error(`El dialecto SQL «${id}» todavía no está disponible en esta versión.`)
  }
  return dialect
}

/**
 * The SQL dialect of an engine, or null for engines without SQL (MongoDB).
 * Throws for a SQL engine whose dialect is not in this build yet.
 */
export function dialectForEngine(engine: EngineId): SqlDialect | null {
  const id = engineOf({ engine }).capabilities.sqlDialect
  return id ? getDialect(id) : null
}
