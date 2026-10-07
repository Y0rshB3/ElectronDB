/**
 * Moved to the MySQL dialect (src/shared/dialects/mysql.ts) in P1a; this
 * re-export keeps the old import path (main and renderer) for one phase.
 */
export { splitStatements } from './dialects/mysql'
export type { SqlStatement } from './dialects/mysql'
