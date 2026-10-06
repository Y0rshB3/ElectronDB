import type { AppContext } from '../context'
import * as introspect from '../mysql/introspect'
import { getConnectionManager } from '../mysql/manager'
import { executeScript } from '../mysql/query'
import { applyRowChanges, isBinaryDataType } from '../mysql/rowChanges'
import type { PooledSession } from '../mysql/session'
import { fetchTableData } from '../mysql/tableData'
import { listUsers } from '../mysql/users'
import { assertProductionWriteConfirmed, assertScriptAllowed } from './productionGuard'
import { handle } from './typed'

export function registerDbHandlers(ctx: AppContext): void {
  const manager = getConnectionManager(ctx)

  /** Runs `fn` on a short-lived dedicated session, always releasing it. */
  const withSession = async <T>(
    connectionId: string,
    schema: string | null,
    fn: (session: PooledSession) => Promise<T>
  ): Promise<T> => {
    const session = await manager.acquire(connectionId, schema)
    try {
      return await fn(session)
    } finally {
      await session.release().catch(() => undefined)
    }
  }

  handle('db:databases', (id) => withSession(id, null, (s) => introspect.listDatabases(s)))
  handle('db:tables', (id, schema) =>
    withSession(id, null, (s) => introspect.listTables(s, schema))
  )
  handle('db:views', (id, schema) => withSession(id, null, (s) => introspect.listViews(s, schema)))
  handle('db:routines', (id, schema) =>
    withSession(id, null, (s) => introspect.listRoutines(s, schema))
  )
  handle('db:events', (id, schema) =>
    withSession(id, null, (s) => introspect.listEvents(s, schema))
  )
  handle('db:triggers', (id, schema) =>
    withSession(id, null, (s) => introspect.listTriggers(s, schema))
  )
  handle('db:columns', (id, schema, table) =>
    withSession(id, null, (s) => introspect.listColumns(s, schema, table))
  )
  handle('db:tableStructure', (id, schema, table) =>
    withSession(id, null, (s) => introspect.tableStructure(s, schema, table))
  )
  handle('db:showCreate', (id, schema, type, name) =>
    withSession(id, null, (s) => introspect.showCreate(s, schema, type, name))
  )
  handle('db:tableData', (id, request) => withSession(id, null, (s) => fetchTableData(s, request)))
  handle('db:applyRowChanges', (id, schema, table, changes, options) => {
    if (changes.length) assertProductionWriteConfirmed(ctx, id, options, 'Modificar filas')
    return withSession(id, null, async (s) => {
      // binary cells travel as "0xHEX" text; the column types say which to decode
      const columns = await introspect.listColumns(s, schema, table)
      const binary = new Set(columns.filter((c) => isBinaryDataType(c.dataType)).map((c) => c.name))
      return applyRowChanges(s, schema, table, changes, binary)
    })
  })
  handle('db:execute', (id, sql, options) => {
    assertScriptAllowed(ctx, id, sql, options)
    return withSession(id, null, (s) =>
      executeScript(s, sql, options ?? {}, ctx.settings.get().defaultRowLimit)
    )
  })
  handle('db:users', (id) => withSession(id, null, (s) => listUsers(s)))
  handle('db:dropObject', (id, schema, type, name, options) => {
    assertProductionWriteConfirmed(ctx, id, options, `Eliminar ${name}`)
    return withSession(id, null, (s) => introspect.dropObject(s, schema, type, name))
  })
  handle('db:createDatabase', (id, name, charset, collation, options) => {
    assertProductionWriteConfirmed(ctx, id, options, `Crear la base de datos ${name}`)
    return withSession(id, null, (s) => introspect.createDatabase(s, name, charset, collation))
  })
  handle('db:dropDatabase', (id, name, options) => {
    assertProductionWriteConfirmed(ctx, id, options, `Eliminar la base de datos ${name}`)
    return withSession(id, null, (s) => introspect.dropDatabase(s, name))
  })
  handle('db:charsets', (id) => withSession(id, null, (s) => introspect.listCharsets(s)))
}
