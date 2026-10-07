/**
 * Moved to the MySQL dialect (src/shared/dialects/mysql.ts) in P1a; this
 * re-export keeps the old import path for one phase.
 */
export { analyzeWrites, normalize } from '@shared/dialects/mysql'
export type { WriteCheck } from '@shared/dialects/mysql'
