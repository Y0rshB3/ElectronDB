/**
 * db:* channels for PostgreSQL connections (P2a/P2b). ipc/db.ts routes here
 * by the connection's engine; MySQL keeps its own handlers unchanged.
 *
 * Addressing (section 4): every object channel needs `{ database, schema }`;
 * a plain string SchemaRef is refused so no renderer path can act on the
 * wrong database. Writes go through the production guard like MySQL, plus the
 * server-side read-only sessions of a guarded connection (section 10).
 */
import type { IpcArgs, IpcChannel, IpcResult } from '@shared/ipc'
import { CAPABILITY_MESSAGES } from '../db/errors'
import type {
  EngineObjectType,
  NameRef,
  ObjectRef,
  QueryExecuteOptions,
  QueryStatementResult,
  SchemaRef,
  TabSessionState,
  WriteOptions
} from '@shared/types'
import type { AppContext } from '../context'
import type { ConnectionManager } from '../db/manager'
import { PgDriverConnection, isPgConnection, type TabSession } from '../postgres/connection'
import { composeSearchPath, formatSearchPath, postgresOf } from '../postgres/client'
import { describeError, PgUserError, sqlState } from '../postgres/errors'
import * as introspect from '../postgres/introspect'
import { executePgScript, newResolveCache, type ResolveCache } from '../postgres/query'
import { applyPgRowChanges } from '../postgres/rowChanges'
import type { PgSession } from '../postgres/session'
import { fetchPgTableData } from '../postgres/tableData'
import { buildPgFilterWhere } from '../postgres/tableFilter'
import {
  assertProductionWriteConfirmed,
  assertScriptAllowed,
  needsTypedConfirm
} from './productionGuard'

export const MISSING_DATABASE = 'Falta la base de datos: actualiza la vista'

type H<C extends IpcChannel> = (...args: IpcArgs<C>) => Promise<IpcResult<C>>

export interface PgDbHandlers {
  databases: H<'db:databases'>
  schemas: H<'db:schemas'>
  tables: H<'db:tables'>
  views: H<'db:views'>
  routines: H<'db:routines'>
  triggers: H<'db:triggers'>
  columns: H<'db:columns'>
  tableStructure: H<'db:tableStructure'>
  showCreate: H<'db:showCreate'>
  objects: H<'db:objects'>
  extensions: H<'db:extensions'>
  dataTypes: H<'db:dataTypes'>
  tableData: H<'db:tableData'>
  tableFilterSql: H<'db:tableFilterSql'>
  applyRowChanges: H<'db:applyRowChanges'>
  execute: H<'db:execute'>
  dropObject: H<'db:dropObject'>
  createDatabase(
    id: string,
    name: string,
    options?: WriteOptions,
    engineOptions?: Record<string, string>
  ): Promise<void>
  dropDatabase: H<'db:dropDatabase'>
  cancel: H<'db:cancel'>
  sessionState: H<'db:sessionState'>
  commit: H<'db:commit'>
  rollback: H<'db:rollback'>
  closeSession: H<'db:closeSession'>
}

export interface PgScope {
  database: string
  schema: string
}

/** `{ database, schema }` of a PostgreSQL call; a plain string is refused (section 4). */
export function pgScope(ref: SchemaRef | null | undefined): PgScope {
  if (!ref || typeof ref === 'string' || !ref.database)
    throw new PgUserError(MISSING_DATABASE, 'E_PG_SCOPE')
  if (typeof ref.schema !== 'string') throw new PgUserError(MISSING_DATABASE, 'E_PG_SCOPE')
  return { database: ref.database, schema: ref.schema }
}

function requireSchema(scope: PgScope): PgScope {
  if (!scope.schema) throw new PgUserError('Falta el esquema: actualiza la vista', 'E_PG_SCOPE')
  return scope
}

function objectRef(type: EngineObjectType, name: NameRef): ObjectRef {
  if (typeof name === 'string') return { type, name }
  return { ...name, type: name.type ?? type }
}

/** appliedSchema value that never matches: the next run re-applies the search_path. */
const UNKNOWN_SCHEMA = '\u0000unknown'

const READ_ONLY_TXN_MESSAGE =
  'La transacción se abrió en modo solo lectura: ejecuta ROLLBACK y repite el script con la escritura (25006)'

/** Per tab session: catalog caches for result sources. */
const tabCaches = new WeakMap<TabSession, ResolveCache>()

export function createPgDbHandlers(ctx: AppContext, manager: ConnectionManager): PgDbHandlers {
  const connectionOf = async (id: string): Promise<PgDriverConnection> => {
    const connection = await manager.connection(id)
    if (!isPgConnection(connection))
      throw new PgUserError('La conexión no es PostgreSQL', 'E_PG_ENGINE')
    return connection
  }

  /** Runs `fn` on a pooled session of `database`, always releasing it. */
  const withSession = async <T>(
    id: string,
    database: string | null,
    fn: (session: PgSession, connection: PgDriverConnection) => Promise<T>
  ): Promise<T> => {
    const connection = await connectionOf(id)
    const session = await connection.acquire(database ? { database, schema: null } : null)
    try {
      return await fn(session, connection)
    } finally {
      await session.release().catch(() => undefined)
    }
  }

  const showSystem = (id: string): boolean =>
    postgresOf(ctx.connections.get(id) ?? {}).showSystemSchemas === true

  const guarded = (id: string): boolean => needsTypedConfirm(ctx, ctx.connections.get(id))

  /** Lifts the read-only default of a guarded pooled session for one confirmed write. */
  const liftReadOnly = async (session: PgSession, id: string): Promise<void> => {
    if (guarded(id)) await session.query('SET SESSION default_transaction_read_only = off')
  }

  async function runOnTab(
    connection: PgDriverConnection,
    id: string,
    key: string,
    scope: { database: string; schema: string | null },
    sql: string,
    options: QueryExecuteOptions
  ): Promise<QueryStatementResult[]> {
    let tab = connection.tabSession(key)
    if (tab?.lost) {
      const reason = tab.lost
      await connection.closeTabSession(key)
      throw new PgUserError(`${reason}. Vuelve a ejecutar la consulta.`, 'E_PG_SESSION_LOST')
    }
    tab = await connection.openTabSession(key, scope.database)
    const session = tab.session
    const isGuarded = guarded(id)
    const confirmed = options.confirmProduction === true
    let lifted = false
    let cache = tabCaches.get(tab)
    if (!cache) {
      cache = newResolveCache()
      tabCaches.set(tab, cache)
    }
    const restoreIfIdle = async (): Promise<void> => {
      if (!tab!.restoreReadOnly || session.transactionStatus() !== 'idle') return
      await session.query('SET SESSION default_transaction_read_only = on')
      tab!.restoreReadOnly = false
    }
    const executionId = options.executionId
    let results: QueryStatementResult[] = []
    try {
      results = await executePgScript(
        session,
        sql,
        options,
        ctx.settings.get().defaultRowLimit,
        {
          before: async () => {
            await restoreIfIdle()
            await connection.setTabSchema(tab!, scope.schema)
            if (isGuarded && confirmed && session.transactionStatus() === 'idle') {
              await session.query('SET SESSION default_transaction_read_only = off')
              lifted = true
            }
            if (executionId) connection.registerExecution(executionId, session)
          },
          cancelled: () => connection.isCancelled(executionId),
          afterStatement: async (result) => {
            result.transactionStatus = session.transactionStatus()
          },
          explain: (err) =>
            isGuarded && sqlState(err) === '25006' && session.transactionStatus() !== 'idle'
              ? READ_ONLY_TXN_MESSAGE
              : describeError(err)
        },
        cache
      )
    } finally {
      // Before any follow-up query: a late cancel must never hit the restore below.
      connection.unregisterExecution(executionId)
      // Read-only comes back even when the script failed; if it cannot, the session goes.
      try {
        if (lifted) {
          if (session.transactionStatus() === 'idle')
            await session.query('SET SESSION default_transaction_read_only = on')
          else tab.restoreReadOnly = true
        } else await restoreIfIdle()
      } catch {
        await connection.closeTabSession(key)
        // eslint-disable-next-line no-unsafe-finally
        throw new PgUserError(
          'No se pudo devolver la sesión a solo lectura y se ha cerrado (se deshizo la transacción abierta). Vuelve a ejecutar la consulta.',
          'E_PG_READ_ONLY'
        )
      }
    }
    // A rollback (or an aborted transaction) undoes the search_path set inside it.
    if (session.transactionStatus() !== 'idle') tab.appliedSchema = UNKNOWN_SCHEMA
    {
      if (session.transactionStatus() !== 'failed') {
        try {
          const [row] = await session.query<{ s: string | null }>('SELECT current_schema() AS s')
          tab.effectiveSchema = row?.s ?? null
          // A `SET search_path` in the script changes the base the combo applies on.
          tab.appliedSchema =
            tab.effectiveSchema === scope.schema ? scope.schema : tab.appliedSchema
        } catch {
          /* keep the last known schema */
        }
      }
      tab.lastUsed = Date.now()
      const status = session.transactionStatus()
      for (const r of results) {
        r.transactionStatus ??= status
        r.effectiveSchema = tab.effectiveSchema
      }
      if (results.length) results[results.length - 1].transactionStatus = status
      return results
    }
  }

  async function runPooled(
    connection: PgDriverConnection,
    id: string,
    scope: { database: string; schema: string | null },
    sql: string,
    options: QueryExecuteOptions
  ): Promise<QueryStatementResult[]> {
    // Read before borrowing a client: baseSearchPath may need one from the same pool.
    const base = scope.schema ? await connection.baseSearchPath(scope.database) : []
    const session = await connection.acquire({ database: scope.database, schema: null })
    const executionId = options.executionId
    try {
      return await executePgScript(session, sql, options, ctx.settings.get().defaultRowLimit, {
        before: async () => {
          if (scope.schema) {
            await session.query('SELECT set_config($1, $2, false)', [
              'search_path',
              formatSearchPath(composeSearchPath(scope.schema, base))
            ])
            session.usage.userSql = true
          }
          if (options.confirmProduction === true) await liftReadOnly(session, id)
          if (executionId) connection.registerExecution(executionId, session)
        },
        cancelled: () => connection.isCancelled(executionId)
      })
    } finally {
      connection.unregisterExecution(executionId)
      await session.release().catch(() => undefined)
    }
  }

  return {
    databases: async (id) =>
      withSession(id, null, (s) => introspect.listDatabases(s, showSystem(id))),
    schemas: async (id, database) =>
      withSession(id, database, (s) => introspect.listSchemas(s, showSystem(id))),
    tables: async (id, ref) => {
      const scope = requireSchema(pgScope(ref))
      return withSession(id, scope.database, (s) => introspect.listTables(s, scope.schema))
    },
    views: async (id, ref) => {
      const scope = requireSchema(pgScope(ref))
      return withSession(id, scope.database, (s) => introspect.listViews(s, scope.schema))
    },
    routines: async (id, ref) => {
      const scope = requireSchema(pgScope(ref))
      return withSession(id, scope.database, (s) => introspect.listRoutines(s, scope.schema))
    },
    triggers: async (id, ref) => {
      const scope = requireSchema(pgScope(ref))
      return withSession(id, scope.database, (s) => introspect.listTriggers(s, scope.schema))
    },
    columns: async (id, ref, table) => {
      const scope = requireSchema(pgScope(ref))
      return withSession(id, scope.database, (s) => introspect.listColumns(s, scope.schema, table))
    },
    tableStructure: async (id, ref, table) => {
      const scope = requireSchema(pgScope(ref))
      return withSession(id, scope.database, (s) =>
        introspect.tableStructure(s, scope.database, scope.schema, table)
      )
    },
    showCreate: async (id, ref, type, name) => {
      const scope = requireSchema(pgScope(ref))
      return withSession(id, scope.database, (s) =>
        introspect.objectDdl(s, scope.schema, objectRef(type, name))
      )
    },
    objects: async (id, ref, type) => {
      const scope = requireSchema(pgScope(ref))
      return withSession(id, scope.database, (s) => introspect.listObjects(s, scope.schema, type))
    },
    extensions: async (id, database) =>
      withSession(id, database, (s) => introspect.listExtensions(s)),
    dataTypes: async (id, database) =>
      withSession(id, database, (s) => introspect.listDataTypes(s)),
    tableData: async (id, request) => {
      const scope = requireSchema(pgScope(request.schema))
      return withSession(id, scope.database, (s) =>
        fetchPgTableData(s, request, { schema: scope.schema, table: request.table })
      )
    },
    tableFilterSql: async (id, ref, table, filter) => {
      const scope = requireSchema(pgScope(ref))
      return withSession(id, scope.database, async (s) => {
        const columns = await introspect.listColumns(s, scope.schema, table)
        return buildPgFilterWhere(
          filter,
          columns.map((c) => ({ name: c.name, typeKind: c.typeKind, dataType: c.dataType }))
        )
      })
    },
    applyRowChanges: async (id, ref, table, changes, options) => {
      const scope = requireSchema(pgScope(ref))
      if (changes.length) assertProductionWriteConfirmed(ctx, id, options, 'Modificar filas')
      return withSession(id, scope.database, async (s) => {
        // One pg client runs one query at a time: sequential, not Promise.all.
        const columns = await introspect.listColumns(s, scope.schema, table)
        const primaryKey = await introspect.primaryKeyColumns(s, scope.schema, table)
        return applyPgRowChanges(s, scope.schema, table, changes, columns, primaryKey)
      })
    },
    execute: async (id, sql, options = {}) => {
      assertScriptAllowed(ctx, id, sql, options)
      const connection = await connectionOf(id)
      const ref = options.schema
      if (typeof ref === 'string' && ref) throw new PgUserError(MISSING_DATABASE, 'E_PG_SCOPE')
      const scope =
        ref && typeof ref === 'object'
          ? { database: ref.database || connection.initialDatabase, schema: ref.schema || null }
          : { database: connection.initialDatabase, schema: null }
      return options.sessionKey
        ? runOnTab(connection, id, options.sessionKey, scope, sql, options)
        : runPooled(connection, id, scope, sql, options)
    },
    dropObject: async (id, ref, type, name, options) => {
      const scope = requireSchema(pgScope(ref))
      const objectName = typeof name === 'string' ? name : name.name
      assertProductionWriteConfirmed(ctx, id, options, `Eliminar ${objectName}`)
      return withSession(id, scope.database, async (s) => {
        await liftReadOnly(s, id)
        s.usage.userSql = true
        await introspect.dropObject(s, scope.schema, objectRef(type, name))
      })
    },
    createDatabase: async (id, name, options, engineOptions) => {
      assertProductionWriteConfirmed(ctx, id, options, `Crear la base de datos ${name}`)
      return withSession(id, null, async (s) => {
        await liftReadOnly(s, id)
        s.usage.userSql = true
        await introspect.createDatabase(s, name, engineOptions ?? {})
      })
    },
    dropDatabase: async (id, name, options) => {
      assertProductionWriteConfirmed(ctx, id, options, `Eliminar la base de datos ${name}`)
      const connection = await connectionOf(id)
      // Our own sessions on it would block DROP DATABASE: close them first.
      if (name !== connection.initialDatabase) await connection.closeDatabase(name)
      return withSession(id, null, async (s, c) => {
        await liftReadOnly(s, id)
        s.usage.userSql = true
        await introspect.dropDatabase(s, name, c.initialDatabase)
      })
    },
    cancel: async (id, executionId) => {
      const connection = await connectionOf(id)
      return connection.cancel(executionId)
    },
    sessionState: async (id, key) => {
      if (!manager.isOpen(id)) return closedState()
      const connection = await connectionOf(id)
      const tab = connection.tabSession(key)
      if (!tab) return closedState()
      if (tab.lost) {
        const reason = tab.lost
        await connection.closeTabSession(key)
        throw new PgUserError(reason, 'E_PG_SESSION_LOST')
      }
      return tab.state()
    },
    commit: async (id, key, options) => {
      assertProductionWriteConfirmed(ctx, id, options, 'Confirmar la transacción (COMMIT)')
      return endTransaction(await connectionOf(id), key, 'COMMIT')
    },
    rollback: async (id, key) => endTransaction(await connectionOf(id), key, 'ROLLBACK'),
    closeSession: async (id, key) => {
      if (!manager.isOpen(id)) return
      const connection = await connectionOf(id)
      await connection.closeTabSession(key)
    }
  }

  async function endTransaction(
    connection: PgDriverConnection,
    key: string,
    command: 'COMMIT' | 'ROLLBACK'
  ): Promise<TabSessionState> {
    const tab = connection.tabSession(key)
    if (!tab) return closedState()
    if (tab.lost) {
      const reason = tab.lost
      await connection.closeTabSession(key)
      throw new PgUserError(reason, 'E_PG_SESSION_LOST')
    }
    await tab.session.query(command)
    // ROLLBACK also undoes a search_path set inside the transaction: re-apply on the next run.
    if (command === 'ROLLBACK') tab.appliedSchema = UNKNOWN_SCHEMA
    if (tab.restoreReadOnly && tab.session.transactionStatus() === 'idle') {
      await tab.session.query('SET SESSION default_transaction_read_only = on')
      tab.restoreReadOnly = false
    }
    try {
      const [row] = await tab.session.query<{ s: string | null }>('SELECT current_schema() AS s')
      tab.effectiveSchema = row?.s ?? null
    } catch {
      /* keep the last known schema */
    }
    return tab.state()
  }
}

function closedState(): TabSessionState {
  return { open: false, transactionStatus: 'idle', effectiveSchema: null, database: null }
}

/** Main-side capability refusals for PostgreSQL (the renderer never calls these). */
export const PG_REFUSED = {
  events: CAPABILITY_MESSAGES.events,
  users: (name: string): string =>
    `La lista de usuarios y roles de PostgreSQL todavía no está disponible («${name}»).`,
  charsets:
    'PostgreSQL no usa juegos de caracteres por tabla: elige la codificación al crear la base de datos.'
} as const
