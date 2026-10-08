import type { AppContext } from '../context'

/**
 * Databases of a PostgreSQL, SQLite (main and attachments) or MongoDB
 * connection, for «Restaurar todo» plans (which databases would be replaced).
 * Engine modules are loaded on first use, like the backup service does.
 */
export async function listEngineDatabases(ctx: AppContext, connectionId: string): Promise<string[]> {
  const { getConnectionManager } = await import('../db/manager')
  const connection = await getConnectionManager(ctx).connection(connectionId)
  const [{ isPgConnection }, { isSqliteConnection }, { isMongoConnection }] = await Promise.all([
    import('../postgres/connection'),
    import('../sqlite/connection'),
    import('../mongo/connection')
  ])
  if (isMongoConnection(connection)) {
    const { listDatabases } = await import('../mongo/admin')
    return (await listDatabases(connection)).map((d) => d.name)
  }
  if (isSqliteConnection(connection)) {
    const { listDatabases } = await import('../sqlite/introspect')
    return (await connection.exclusive((s) => listDatabases(s))).map((d) => d.name)
  }
  if (isPgConnection(connection)) {
    const { listDatabases } = await import('../postgres/introspect')
    const session = await connection.acquire(null)
    try {
      return (await listDatabases(session, true)).map((d) => d.name)
    } finally {
      await session.release().catch(() => undefined)
    }
  }
  throw new Error('La conexión no admite esta consulta.')
}
