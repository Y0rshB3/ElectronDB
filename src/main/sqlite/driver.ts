/**
 * SQLite driver (docs/multi-engine-design.md, section 5.6): node:sqlite in one
 * utility process per open connection (at most 4), the file opened without
 * ever creating it, cancel by killing the process. The spawner is injected
 * (spawner.ts), so node-side tests never import Electron.
 */
import { performance } from 'node:perf_hooks'
import type { ConnectionConfig, ConnectionInput, ConnectionTestResult } from '@shared/types'
import type { Driver, DriverHooks, DriverSecrets, Endpoint } from '../db/driver'
import { WorkerClient } from './client'
import { SqliteDriverConnection, sqliteOf } from './connection'
import { SqliteUserError, describeError, describeForLog } from './errors'
import { getSqliteSpawner, type ProcessSpawner } from './spawner'

/** Open SQLite connections at once (each is a process of tens of MB). */
export const MAX_OPEN_SQLITE = 4
let openCount = 0

/** Test hook: how many SQLite connections are open in this process. */
export function openSqliteCount(): number {
  return openCount
}

function tooMany(): SqliteUserError {
  return new SqliteUserError(
    `Demasiados archivos SQLite abiertos (máximo ${MAX_OPEN_SQLITE}): cierra alguno.`,
    'E_SQLITE_TOO_MANY'
  )
}

/**
 * «Probar conexión»: opens the file read-only (never creates or changes it),
 * checks the attachments, and reports the SQLite version. Initial queries are
 * not run: they may write (journal_mode=WAL changes the file set).
 */
export async function testSqliteFile(
  input: ConnectionInput,
  spawner: ProcessSpawner,
  startedAt: number
): Promise<ConnectionTestResult> {
  const s = sqliteOf(input)
  if (s.pathNeedsReview)
    throw new SqliteUserError(
      'La ruta del archivo viene de otro equipo: elige el archivo con «Abrir archivo».',
      'E_SQLITE_PATH_REVIEW'
    )
  const client = new WorkerClient(spawner, () => undefined)
  client.start()
  try {
    const result = await client.call('open', {
      filePath: s.filePath,
      readOnly: true,
      foreignKeys: false,
      busyTimeoutMs: s.busyTimeoutMs,
      attached: s.attached.map((a) => ({ alias: a.alias, filePath: a.filePath })),
      initialStatements: [],
      queryOnly: true
    })
    const [tables] = (
      await client.call(
        'query',
        "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
        []
      )
    ).rows as { n: number }[]
    const details = [
      s.readOnly ? 'Se abrirá en modo solo lectura' : 'Lectura y escritura',
      `${tables?.n ?? 0} tabla(s)`
    ]
    if (s.attached.length) details.push(`${s.attached.length} base(s) de datos adjunta(s)`)
    return {
      ok: true,
      serverVersion: `SQLite ${result.sqliteVersion}`,
      durationMs: Math.round(performance.now() - startedAt),
      details
    }
  } finally {
    await client.close()
  }
}

export function createSqliteDriver(spawner: () => ProcessSpawner = getSqliteSpawner): Driver {
  return {
    engines: ['sqlite'],

    async test(
      input: ConnectionInput,
      _secrets: DriverSecrets,
      _endpoint: Endpoint | null,
      startedAt: number
    ): Promise<ConnectionTestResult> {
      return testSqliteFile(input, spawner(), startedAt)
    },

    async open(
      config: ConnectionConfig,
      _secrets: DriverSecrets,
      _endpoint: Endpoint | null,
      hooks: DriverHooks
    ): Promise<SqliteDriverConnection> {
      if (sqliteOf(config).pathNeedsReview)
        throw new SqliteUserError(
          'La ruta del archivo viene de otro equipo: edita la conexión y elige el archivo con «Abrir archivo».',
          'E_SQLITE_PATH_REVIEW'
        )
      if (openCount >= MAX_OPEN_SQLITE) throw tooMany()
      openCount++
      let counted = true
      const release = (): void => {
        if (counted) openCount--
        counted = false
      }
      const connection = new SqliteDriverConnection({
        config,
        spawner: spawner(),
        isGuarded: () => hooks.isGuarded?.() ?? false,
        onFatal: (reason) => {
          release()
          hooks.onFatal(reason)
        }
      })
      const close = connection.close.bind(connection)
      connection.close = async () => {
        release()
        await close()
      }
      try {
        await connection.probe()
        return connection
      } catch (err) {
        await connection.close().catch(() => undefined)
        throw err
      }
    },

    describeForUser: describeError,
    describeForLog,
    userError: (message) => new SqliteUserError(message),
    isAuthRejected: () => false,
    missingPasswordError: (name) =>
      new SqliteUserError(`La conexión ${name} no usa contraseña.`, 'E_SQLITE_NO_PASSWORD')
  }
}

export const sqliteDriver: Driver = createSqliteDriver()

/**
 * «Crear base de datos nueva»: creates an empty database file (header
 * written) at `filePath`. The only place Vortaq creates a SQLite file.
 */
export async function createSqliteFile(
  filePath: string,
  spawner: ProcessSpawner = getSqliteSpawner()
): Promise<{ filePath: string; sqliteVersion: string }> {
  const client = new WorkerClient(spawner, () => undefined)
  client.start()
  try {
    const result = await client.call('open', {
      filePath,
      readOnly: false,
      foreignKeys: true,
      busyTimeoutMs: 5000,
      attached: [],
      initialStatements: [],
      queryOnly: false,
      create: true
    })
    return { filePath, sqliteVersion: result.sqliteVersion }
  } finally {
    await client.close()
  }
}
