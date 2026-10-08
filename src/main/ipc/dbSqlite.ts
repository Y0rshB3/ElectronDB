/**
 * db:* and sqlite:* channels for SQLite connections (P3). ipc/db.ts routes
 * here by the connection's engine; MySQL and PostgreSQL keep their handlers.
 *
 * Addressing (section 4): the plain-string SchemaRef is the attached database
 * alias (main, temp or an ATTACH alias). Writes go through the production
 * guard like every engine, plus `PRAGMA query_only` on guarded connections
 * (section 10) and the shared-transaction rule of the single handle.
 */
import { performance } from 'node:perf_hooks'
import type { IpcArgs, IpcChannel, IpcResult } from '@shared/ipc'
import type {
  EngineObjectType,
  NameRef,
  ObjectRef,
  SchemaRef,
  SqliteMaintenanceAction,
  SqliteMaintenanceResult,
  TabSessionState
} from '@shared/types'
import type { AppContext } from '../context'
import type { ConnectionManager } from '../db/manager'
import {
  NO_TAB,
  isSqliteConnection,
  type SqliteDriverConnection,
  type SqliteSession
} from '../sqlite/connection'
import { SqliteUserError } from '../sqlite/errors'
import * as introspect from '../sqlite/introspect'
import { executeSqliteScript } from '../sqlite/query'
import { applySqliteRowChanges } from '../sqlite/rowChanges'
import { fetchSqliteTableData } from '../sqlite/tableData'
import { buildSqliteFilterWhere } from '../sqlite/tableFilter'
import { assertProductionWriteConfirmed, assertScriptAllowed } from './productionGuard'

type H<C extends IpcChannel> = (...args: IpcArgs<C>) => Promise<IpcResult<C>>

export interface SqliteDbHandlers {
  databases: H<'db:databases'>
  tables: H<'db:tables'>
  views: H<'db:views'>
  triggers: H<'db:triggers'>
  columns: H<'db:columns'>
  tableStructure: H<'db:tableStructure'>
  showCreate: H<'db:showCreate'>
  objects: H<'db:objects'>
  tableData: H<'db:tableData'>
  tableFilterSql: H<'db:tableFilterSql'>
  applyRowChanges: H<'db:applyRowChanges'>
  execute: H<'db:execute'>
  dropObject: H<'db:dropObject'>
  cancel: H<'db:cancel'>
  sessionState: H<'db:sessionState'>
  commit: H<'db:commit'>
  rollback: H<'db:rollback'>
  closeSession: H<'db:closeSession'>
  reopenWritable: H<'sqlite:reopenWritable'>
  copyFile: H<'sqlite:copyFile'>
  maintenance: H<'sqlite:maintenance'>
}

/** Main-side refusals for channels SQLite does not have (the renderer never calls them). */
export const SQLITE_REFUSED = {
  createDatabase:
    'En SQLite cada base de datos es un archivo: crea uno con «Nueva conexión › SQLite › Crear base de datos nueva».',
  dropDatabase:
    'En SQLite cada base de datos es un archivo: para quitar una base de datos adjunta, edita la conexión.',
  notAvailable: 'Esta operación no existe en las conexiones SQLite.'
} as const

/** The attached database alias of a call ('main' when empty). */
export function sqliteDb(ref: SchemaRef | null | undefined): string {
  if (ref === null || ref === undefined || ref === '') return 'main'
  if (typeof ref !== 'string')
    throw new SqliteUserError('Las conexiones SQLite usan el nombre de la base de datos adjunta')
  return ref
}

function objectRef(type: EngineObjectType, name: NameRef): ObjectRef {
  if (typeof name === 'string') return { type, name }
  return { ...name, type: name.type ?? type }
}

function closedState(): TabSessionState {
  return {
    open: false,
    transactionStatus: 'idle',
    effectiveSchema: null,
    database: null,
    transactionElsewhere: false
  }
}

export function createSqliteDbHandlers(
  ctx: AppContext,
  manager: ConnectionManager
): SqliteDbHandlers {
  const connectionOf = async (id: string): Promise<SqliteDriverConnection> => {
    const connection = await manager.connection(id)
    if (!isSqliteConnection(connection))
      throw new SqliteUserError('La conexión no es SQLite', 'E_SQLITE_ENGINE')
    return connection
  }

  /** Reads on the shared handle (behind any script in progress). */
  const read = async <T>(id: string, fn: (s: SqliteSession) => Promise<T>): Promise<T> =>
    (await connectionOf(id)).exclusive(fn)

  /**
   * A write Vortaq makes itself (grid save, drop, maintenance): refused while a
   * query tab owns the open transaction; query_only lifted for it on a guarded
   * connection (the caller has checked the confirmation).
   */
  const write = async <T>(
    id: string,
    action: string,
    fn: (s: SqliteSession, c: SqliteDriverConnection) => Promise<T>
  ): Promise<T> => {
    const connection = await connectionOf(id)
    return connection.exclusive(async (s) => {
      connection.assertCanWrite(NO_TAB, action)
      const lifted = await connection.liftGuard(true)
      try {
        return await fn(s, connection)
      } finally {
        await connection.restoreGuard(lifted)
      }
    })
  }

  const maintenance = async (
    id: string,
    action: SqliteMaintenanceAction
  ): Promise<SqliteMaintenanceResult> => {
    const started = performance.now()
    const done = (ok: boolean, messages: string[]): SqliteMaintenanceResult => ({
      ok,
      messages,
      durationMs: Math.round(performance.now() - started)
    })
    if (action === 'integrityCheck' || action === 'quickCheck') {
      const pragma = action === 'integrityCheck' ? 'integrity_check' : 'quick_check'
      const rows = await read(id, (s) => s.query<Record<string, unknown>>(`PRAGMA ${pragma}`))
      const lines = rows.map((r) => String(Object.values(r)[0] ?? ''))
      const ok = lines.length === 1 && lines[0] === 'ok'
      return done(ok, ok ? [] : lines)
    }
    if (action === 'foreignKeyCheck') {
      const rows = await read(id, (s) =>
        s.query<{ table: string; parent: string; n: number }>(
          'SELECT "table" AS "table", parent, count(*) AS n FROM pragma_foreign_key_check GROUP BY 1, 2 ORDER BY 1, 2'
        )
      )
      return done(
        rows.length === 0,
        rows.map((r) => `${r.table}: ${r.n} fila(s) sin su fila en ${r.parent}`)
      )
    }
    const sql = action === 'vacuum' ? 'VACUUM' : 'PRAGMA optimize'
    await write(id, action === 'vacuum' ? 'VACUUM' : 'Optimizar', (s) => s.exec(sql))
    return done(true, [])
  }

  return {
    databases: async (id) => read(id, (s) => introspect.listDatabases(s)),
    tables: async (id, ref) => read(id, (s) => introspect.listTables(s, sqliteDb(ref))),
    views: async (id, ref) => read(id, (s) => introspect.listViews(s, sqliteDb(ref))),
    triggers: async (id, ref) => read(id, (s) => introspect.listTriggers(s, sqliteDb(ref))),
    columns: async (id, ref, table) =>
      read(id, (s) => introspect.listColumns(s, sqliteDb(ref), table)),
    tableStructure: async (id, ref, table) =>
      read(id, (s) => introspect.tableStructure(s, sqliteDb(ref), table)),
    showCreate: async (id, ref, type, name) =>
      read(id, (s) => introspect.objectDdl(s, sqliteDb(ref), objectRef(type, name))),
    objects: async (id, ref, type) =>
      read(id, (s) => introspect.listObjects(s, sqliteDb(ref), type)),
    tableData: async (id, request) =>
      fetchSqliteTableData(await connectionOf(id), request, {
        db: sqliteDb(request.schema),
        table: request.table
      }),
    tableFilterSql: async (id, ref, table, filter) =>
      read(id, async (s) => {
        const columns = await introspect.listColumns(s, sqliteDb(ref), table)
        return buildSqliteFilterWhere(
          filter,
          columns.map((c) => ({ name: c.name, typeKind: c.typeKind, dataType: c.columnType }))
        )
      }),
    applyRowChanges: async (id, ref, table, changes, options) => {
      const db = sqliteDb(ref)
      if (changes.length) assertProductionWriteConfirmed(ctx, id, options, 'Modificar filas')
      return write(id, 'Guardar los cambios de la cuadrícula', async (s) => {
        const columns = await introspect.listColumns(s, db, table)
        const identity = await introspect.rowIdentity(s, db, table)
        return applySqliteRowChanges(s, db, table, changes, columns, identity)
      })
    },
    execute: async (id, sql, options = {}) => {
      assertScriptAllowed(ctx, id, sql, options)
      return executeSqliteScript(
        await connectionOf(id),
        sql,
        options,
        ctx.settings.get().defaultRowLimit
      )
    },
    dropObject: async (id, ref, type, name, options) => {
      const db = sqliteDb(ref)
      const target = objectRef(type, name)
      assertProductionWriteConfirmed(ctx, id, options, `Eliminar ${target.name}`)
      await write(id, `Eliminar ${target.name}`, (s) =>
        s.exec(introspect.dropStatement(db, target))
      )
    },
    cancel: async (id, executionId) => {
      if (!manager.isOpen(id)) return false
      return (await connectionOf(id)).cancel(executionId)
    },
    sessionState: async (id, key) => {
      if (!manager.isOpen(id)) return closedState()
      return (await connectionOf(id)).tabState(key)
    },
    commit: async (id, key, options) => {
      assertProductionWriteConfirmed(ctx, id, options, 'Confirmar la transacción (COMMIT)')
      const connection = await connectionOf(id)
      await connection.endTransaction(key, 'COMMIT')
      return connection.tabState(key)
    },
    rollback: async (id, key) => {
      const connection = await connectionOf(id)
      await connection.endTransaction(key, 'ROLLBACK')
      return connection.tabState(key)
    },
    closeSession: async (id, key) => {
      if (!manager.isOpen(id)) return
      await (await connectionOf(id)).closeTab(key)
    },
    reopenWritable: async (id, options) => {
      assertProductionWriteConfirmed(ctx, id, options, 'Reabrir en modo escritura')
      const connection = await connectionOf(id)
      await connection.reopenWritable()
      if (connection.readOnly)
        throw new SqliteUserError(
          connection.readOnlyReason ?? 'El archivo no se puede abrir en modo escritura.',
          'E_SQLITE_READ_ONLY'
        )
      return connection.serverInfo()
    },
    copyFile: async (id, targetPath) => {
      const started = performance.now()
      const result = await (await connectionOf(id)).vacuumInto(targetPath)
      return {
        path: targetPath,
        sizeBytes: result.sizeBytes,
        durationMs: Math.round(performance.now() - started)
      }
    },
    maintenance: async (id, action, options) => {
      if (action === 'vacuum' || action === 'optimize')
        assertProductionWriteConfirmed(
          ctx,
          id,
          options,
          action === 'vacuum' ? 'VACUUM' : 'Optimizar'
        )
      return maintenance(id, action)
    }
  }
}
