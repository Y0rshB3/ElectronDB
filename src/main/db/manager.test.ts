import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IpcEventChannel } from '@shared/ipc'
import type { ConnectionInput, EngineId, LogEvent, ServerInfo } from '@shared/types'
import type { AppContext } from '../context'
import { CredentialStore, plainCodec } from '../credentials/store'
import { configureLog } from '../log'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '../storage/repos'
import type { Driver, DriverConnection, DriverHooks, DriverSecrets, Endpoint } from './driver'
import { CAPABILITY_MESSAGES, DbUserError, describeForLog } from './errors'
import { ConnectionManager, getConnectionManager, getSessionFactory } from './manager'

class FakeUserError extends DbUserError {
  constructor(message: string) {
    super(message, 'E_FAKE_USER')
    this.name = 'FakeUserError'
  }
}

const SERVER_INFO = { version: '8.4.0-fake' } as ServerInfo

interface FakeDriver extends Driver {
  opens: { secrets: DriverSecrets; endpoint: Endpoint | null; hooks: DriverHooks }[]
  closes: number
  openError: unknown
  closeError: unknown
  dialectId: string
}

function fakeDriver(): FakeDriver {
  const driver: FakeDriver = {
    engines: ['mysql'],
    opens: [],
    closes: 0,
    openError: null,
    closeError: null,
    dialectId: 'mysql',
    async test(_config, _secrets, _endpoint, startedAt) {
      if (driver.openError) throw driver.openError
      return { ok: true, serverVersion: SERVER_INFO.version, durationMs: startedAt >= 0 ? 1 : -1 }
    },
    async open(config, secrets, endpoint, hooks) {
      // let a concurrent open() reach the dedupe map first
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (driver.openError) throw driver.openError
      driver.opens.push({ secrets, endpoint, hooks })
      const connection = {
        config,
        serverVersion: SERVER_INFO.version,
        family: 'sql',
        dialect: { id: driver.dialectId },
        serverInfo: async () => SERVER_INFO,
        acquire: async () => ({ connectionId: config.id }),
        close: async () => {
          driver.closes++
          if (driver.closeError) throw driver.closeError
        }
      }
      return connection as unknown as DriverConnection
    },
    describeForUser: (err) => `usuario: ${err instanceof Error ? err.message : String(err)}`,
    describeForLog,
    userError: (message) => new FakeUserError(message),
    isAuthRejected: (err) => (err as { code?: unknown } | null)?.code === 'E_FAKE_DENIED',
    missingPasswordError: (name) => new FakeUserError(`Sin contraseña para ${name}`)
  }
  return driver
}

function input(name: string, engine?: EngineId): ConnectionInput {
  return {
    name,
    ...(engine ? { engine } : {}),
    color: null,
    environment: 'local',
    host: '127.0.0.1',
    port: 3306,
    username: 'root',
    savePassword: true,
    customDatabases: [],
    initialQueries: '',
    ssh: {
      enabled: false,
      host: '',
      port: 22,
      username: '',
      authType: 'password',
      savePassword: false
    },
    ssl: { enabled: false, verifyServer: false },
    backupDir: '',
    extraBackupDirs: []
  }
}

describe('ConnectionManager (engine-neutral)', () => {
  let dir: string
  let ctx: AppContext
  let events: { channel: IpcEventChannel; payload: unknown }[]
  let driver: FakeDriver
  let manager: ConnectionManager
  let logs: LogEvent[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-dbmanager-'))
    events = []
    logs = []
    configureLog({ minLevel: 'debug', sink: (e) => logs.push(e) })
    ctx = {
      userDataPath: dir,
      logDir: join(dir, 'logs'),
      connections: new ConnectionsRepo(dir),
      jobs: new JobsRepo(dir),
      runs: new RunsRepo(dir),
      settings: new SettingsRepo(dir, dir),
      credentials: new CredentialStore(dir, plainCodec, 'plain'),
      headless: false,
      emit: (channel, payload) => {
        events.push({ channel, payload })
      }
    }
    driver = fakeDriver()
    manager = new ConnectionManager(ctx, { drivers: async () => driver })
  })

  afterEach(() => {
    configureLog({ minLevel: 'info', sink: null })
    rmSync(dir, { recursive: true, force: true })
  })

  const saved = (name: string, password: string | null = 'pw', engine?: EngineId): string => {
    const { id } = ctx.connections.save(input(name, engine))
    if (password !== null) ctx.credentials.set('mysql', id, password)
    return id
  }

  it('opens once for concurrent callers and passes secrets and the direct endpoint', async () => {
    const id = saved('Local')
    ctx.credentials.set('ssh', id, 'ssh-pw')
    const [a, b] = await Promise.all([manager.open(id), manager.open(id)])
    expect(a).toBe(SERVER_INFO)
    expect(b).toBe(SERVER_INFO)
    expect(driver.opens).toHaveLength(1)
    expect(driver.opens[0].secrets).toEqual({
      password: 'pw',
      sshPassword: 'ssh-pw',
      sslKeyPassword: null
    })
    expect(driver.opens[0].endpoint).toEqual({ host: '127.0.0.1', port: 3306 })
    expect(manager.isOpen(id)).toBe(true)
  })

  it('refuses a missing connection before calling the driver', async () => {
    await expect(manager.open('nope')).rejects.toThrow('La conexión nope no existe')
    expect(driver.opens).toHaveLength(0)
  })

  it('without a stored password tries an empty one; a rejection becomes the driver message', async () => {
    const id = saved('Sin clave', null)
    await manager.open(id)
    expect(driver.opens[0].secrets).toEqual({
      password: null,
      sshPassword: null,
      sslKeyPassword: null
    })
    expect(logs.some((e) => e.message.includes('without a password'))).toBe(true)
    await manager.close(id)

    driver.openError = Object.assign(new Error('Access denied'), { code: 'E_FAKE_DENIED' })
    const err = await manager.open(id).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FakeUserError)
    expect((err as Error).message).toBe('Sin contraseña para Sin clave')
    expect(manager.isOpen(id)).toBe(false)

    // A stored (wrong) password keeps the wrapped server message.
    ctx.credentials.set('mysql', id, 'wrong')
    await expect(manager.open(id)).rejects.toThrow(
      'No se pudo conectar a Sin clave: usuario: Access denied'
    )
  })

  it("'none' mode never sends a password, even a stored one", async () => {
    const { id } = ctx.connections.save({ ...input('Proxy'), authMode: 'none' })
    ctx.credentials.set('mysql', id, 'stale')
    await manager.open(id)
    expect(driver.opens[0].secrets.password).toBeNull()
  })

  it('wraps driver errors with the driver description, keeping our own errors as they are', async () => {
    const id = saved('Caído')
    driver.openError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    await expect(manager.open(id)).rejects.toThrow(
      'No se pudo conectar a Caído: usuario: connect ECONNREFUSED'
    )
    const own = new DbUserError('La consulta inicial falló')
    driver.openError = own
    await expect(manager.open(id)).rejects.toBe(own)
    expect(manager.isOpen(id)).toBe(false)
  })

  it('reports test() failures without throwing, described by the driver', async () => {
    const ok = await manager.test(input('Nueva'), 'pw', null)
    expect(ok).toEqual({ ok: true, serverVersion: SERVER_INFO.version, durationMs: 1 })

    const noPassword = await manager.test(input('Nueva'), null, null)
    expect(noPassword).toEqual({
      ok: true,
      serverVersion: SERVER_INFO.version,
      durationMs: 1,
      connectedWithoutPassword: true
    })

    driver.openError = Object.assign(new Error('Access denied'), { code: 'E_FAKE_DENIED' })
    const rejected = await manager.test(input('Nueva'), null, null)
    expect(rejected).toMatchObject({ ok: false, error: 'Sin contraseña para Nueva' })

    driver.openError = new Error('Access denied')
    const denied = await manager.test(input('Nueva'), 'pw', null)
    expect(denied).toMatchObject({ ok: false, error: 'usuario: Access denied' })
  })

  it('tears down on a fatal error and tells the renderer', async () => {
    const id = saved('Remota')
    await manager.open(id)
    driver.opens[0].hooks.onFatal('túnel cerrado')
    expect(manager.isOpen(id)).toBe(false)
    expect(events).toEqual([
      { channel: 'event:connectionClosed', payload: { connectionId: id, reason: 'túnel cerrado' } }
    ])
    await Promise.resolve()
    expect(driver.closes).toBe(1)
  })

  it('closeAll never logs a raw driver error', async () => {
    const a = saved('A')
    const b = saved('B')
    await manager.open(a)
    await manager.open(b)
    driver.closeError = Object.assign(new Error("Duplicate entry 'ana@example.com'"), {
      code: 'ER_DUP_ENTRY',
      errno: 1062
    })
    await manager.closeAll()
    expect(manager.isOpen(a) || manager.isOpen(b)).toBe(false)
    expect(driver.closes).toBe(2)
    const text = logs.map((l) => l.message).join('\n')
    expect(text).toContain('Error ER_DUP_ENTRY errno 1062')
    expect(text).not.toContain('ana@example.com')
  })

  it('only hands out MySQL sessions from acquire()', async () => {
    const id = saved('Local')
    await expect(manager.acquire(id)).resolves.toEqual({ connectionId: id })
    const other = saved('Otro')
    driver.dialectId = 'postgresql'
    await expect(manager.acquire(other)).rejects.toThrow(
      'MySQL todavía no está disponible en esta versión de Vortaq.'
    )
  })
})

describe('ConnectionManager with the real registry', () => {
  let dir: string
  let ctx: AppContext

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-dbmanager-'))
    ctx = {
      userDataPath: dir,
      logDir: join(dir, 'logs'),
      connections: new ConnectionsRepo(dir),
      jobs: new JobsRepo(dir),
      runs: new RunsRepo(dir),
      settings: new SettingsRepo(dir, dir),
      credentials: new CredentialStore(dir, plainCodec, 'plain'),
      headless: false,
      emit: () => undefined
    }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('opens a MariaDB connection with the MySQL driver (connection refused, not unavailable)', async () => {
    const { id } = ctx.connections.save({ ...input('Maria', 'mariadb'), port: 1 })
    ctx.credentials.set('mysql', id, 'pw')
    const manager = getConnectionManager(ctx)
    const err = await manager.open(id).catch((e: unknown) => e)
    expect((err as Error).message).not.toMatch(/todavía no está disponible/)
    expect(manager.isOpen(id)).toBe(false)
  })

  it('gives backups and jobs no session on a PostgreSQL connection', async () => {
    const { id } = ctx.connections.save(input('PG', 'postgresql'))
    const err = await getSessionFactory(ctx)
      .acquire(id, 'public')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DbUserError)
    expect((err as Error).message).toBe(CAPABILITY_MESSAGES.sessions)
    expect(getConnectionManager(ctx).isOpen(id)).toBe(false)
  })

  it('keeps the manager message for a connection that does not exist', async () => {
    await expect(getSessionFactory(ctx).acquire('nope')).rejects.toThrow(
      'La conexión nope no existe'
    )
  })
})
