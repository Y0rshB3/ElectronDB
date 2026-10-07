/**
 * Re-export shim for one phase (P1a). The connection manager is engine-neutral
 * and lives in src/main/db/manager.ts; the mysql2 pool code it used to hold is
 * the MySQL driver in ./driver.ts. Import from those in new code.
 */
export {
  ConnectionManager,
  getConnectionManager,
  getSessionFactory,
  planPassword,
  type PasswordPlan
} from '../db/manager'
export { buildOptions, buildSsl, castGeometryAsBuffer, missingPasswordError } from './driver'
