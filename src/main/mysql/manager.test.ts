import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import type { AppContext } from '../context'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '../storage/repos'
import { connectionInput } from '../automation/testSupport'

const mysql = vi.hoisted(() => ({
  createPool: vi.fn(),
  createConnection: vi.fn()
}))
vi.mock('mysql2/promise', () => mysql)

import { ConnectionManager, buildOptions, buildSsl, planPassword } from './manager'
import { isAuthRejected } from './errors'

function accessDenied(): Error {
  return Object.assign(new Error("Access denied for user 'app'@'localhost' (using password: NO)"), {
    code: 'ER_ACCESS_DENIED_ERROR',
    errno: 1045,
    sqlState: '28000'
  })
}

/** A fake pool whose first getConnection() resolves or rejects as told. */
function fakePool(outcome: Error | null): object {
  return {
    on: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn(async () => {
      if (outcome) throw outcome
      return {
        connection: {},
        query: vi.fn().mockResolvedValue([[{ version: '8.4.0' }], []]),
        release: vi.fn(),
        destroy: vi.fn()
      }
    })
  }
}

function fakeConnection(): object {
  return {
    query: vi.fn(async (sql: string) =>
      /VERSION\(\)/i.test(sql) ? [[{ version: '8.4.0' }], []] : [[], []]
    ),
    end: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn()
  }
}

describe('ConnectionManager authentication modes', () => {
  let dir: string
  let ctx: AppContext
  let secrets: Map<string, string>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-manager-'))
    secrets = new Map()
    ctx = {
      userDataPath: dir,
      logDir: join(dir, 'logs'),
      connections: new ConnectionsRepo(dir),
      jobs: new JobsRepo(dir),
      runs: new RunsRepo(dir),
      settings: new SettingsRepo(dir, dir),
      credentials: {
        get: (kind: string, id: string) => secrets.get(`${kind}:${id}`) ?? null
      } as unknown as AppContext['credentials'],
      headless: true,
      emit: () => undefined
    }
    mysql.createPool.mockReset()
    mysql.createConnection.mockReset()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const save = (overrides: Partial<ConnectionInput> = {}): string =>
    ctx.connections.save({ ...connectionInput('Prod proxy'), ...overrides }).id

  it("opens an 'none' connection without a password option and without asking for one", async () => {
    const id = save({ authMode: 'none' })
    secrets.set(`mysql:${id}`, 'stale-unused')
    mysql.createPool.mockReturnValue(fakePool(null))
    const manager = new ConnectionManager(ctx)
    await manager.getPool(id)
    const options = mysql.createPool.mock.calls[0][0]
    expect(options).not.toHaveProperty('password')
    expect(options.user).toBe('root')
    expect(manager.isOpen(id)).toBe(true)
  })

  it('uses the stored password in password mode', async () => {
    const id = save({ authMode: 'password' })
    secrets.set(`mysql:${id}`, 's3cret')
    mysql.createPool.mockReturnValue(fakePool(null))
    await new ConnectionManager(ctx).getPool(id)
    expect(mysql.createPool.mock.calls[0][0].password).toBe('s3cret')
  })

  it('password mode with nothing stored: connects when the server accepts an empty password', async () => {
    const id = save() // legacy record: no authMode at all
    mysql.createPool.mockReturnValue(fakePool(null))
    const manager = new ConnectionManager(ctx)
    await manager.getPool(id)
    expect(mysql.createPool).toHaveBeenCalledTimes(1)
    expect(mysql.createPool.mock.calls[0][0]).not.toHaveProperty('password')
    expect(manager.isOpen(id)).toBe(true)
  })

  it('password mode with nothing stored: access denied becomes the actionable message', async () => {
    const id = save({ authMode: 'password' })
    const pool = fakePool(accessDenied())
    mysql.createPool.mockReturnValue(pool)
    const manager = new ConnectionManager(ctx)
    await expect(manager.open(id)).rejects.toThrow(
      'No hay contraseña guardada para la conexión Prod proxy: escríbela en la conexión o marca «Sin contraseña»'
    )
    expect(mysql.createPool).toHaveBeenCalledTimes(1)
    expect((pool as { end: ReturnType<typeof vi.fn> }).end).toHaveBeenCalled()
    expect(manager.isOpen(id)).toBe(false)
  })

  it('a wrong stored password keeps the server message (no misleading hint)', async () => {
    const id = save()
    secrets.set(`mysql:${id}`, 'wrong')
    mysql.createPool.mockReturnValue(fakePool(accessDenied()))
    await expect(new ConnectionManager(ctx).open(id)).rejects.toThrow(
      /No se pudo conectar a Prod proxy: Usuario o contraseña incorrectos.*Mensaje del servidor: Access denied .*ER_ACCESS_DENIED_ERROR 1045/
    )
  })

  it("'none' mode surfaces access denied as-is (the proxy or certificate is the problem)", async () => {
    const id = save({ authMode: 'none' })
    mysql.createPool.mockReturnValue(fakePool(accessDenied()))
    await expect(new ConnectionManager(ctx).open(id)).rejects.toThrow(/Access denied/)
  })

  describe('test()', () => {
    it("'none' ignores a typed and a stored password", async () => {
      const id = save({ authMode: 'none' })
      secrets.set(`mysql:${id}`, 'stored')
      mysql.createConnection.mockResolvedValue(fakeConnection())
      const res = await new ConnectionManager(ctx).test(
        { ...connectionInput('Prod proxy'), id, authMode: 'none' },
        'typed',
        null
      )
      expect(res.ok).toBe(true)
      expect(res.connectedWithoutPassword).toBeUndefined()
      expect(mysql.createConnection.mock.calls[0][0]).not.toHaveProperty('password')
    })

    it('password mode with nothing typed or stored flags an accepted empty password', async () => {
      mysql.createConnection.mockResolvedValue(fakeConnection())
      const res = await new ConnectionManager(ctx).test(connectionInput('Nueva'), null, null)
      expect(res).toMatchObject({ ok: true, connectedWithoutPassword: true })
    })

    it('password mode with nothing: access denied gives the actionable message', async () => {
      mysql.createConnection.mockRejectedValue(accessDenied())
      const res = await new ConnectionManager(ctx).test(connectionInput('Nueva'), null, null)
      expect(res.ok).toBe(false)
      expect(res.error).toBe(
        'No hay contraseña guardada para la conexión Nueva: escríbela en la conexión o marca «Sin contraseña»'
      )
    })

    it('a typed password is used and never reported as empty', async () => {
      mysql.createConnection.mockResolvedValue(fakeConnection())
      const res = await new ConnectionManager(ctx).test(connectionInput('Nueva'), 'typed', null)
      expect(res.connectedWithoutPassword).toBeUndefined()
      expect(mysql.createConnection.mock.calls[0][0].password).toBe('typed')
    })
  })
})

describe('planPassword', () => {
  it('covers every mode', () => {
    expect(planPassword({ authMode: 'none' }, 'x')).toEqual({
      password: undefined,
      emptyAttempt: false
    })
    expect(planPassword({ authMode: 'password' }, 'x')).toEqual({
      password: 'x',
      emptyAttempt: false
    })
    // An explicitly stored empty password is a real choice, not "missing".
    expect(planPassword({}, '')).toEqual({ password: '', emptyAttempt: false })
    expect(planPassword({}, null)).toEqual({ password: undefined, emptyAttempt: true })
  })
})

describe('isAuthRejected', () => {
  it('matches credential rejections only', () => {
    expect(isAuthRejected(accessDenied())).toBe(true)
    expect(isAuthRejected({ message: 'x', errno: 1698 })).toBe(true)
    expect(isAuthRejected({ message: 'x', code: 'AUTH_SWITCH_PLUGIN_ERROR' })).toBe(true)
    expect(isAuthRejected({ message: 'x', code: 'ER_DBACCESS_DENIED_ERROR', errno: 1044 })).toBe(
      false
    )
    expect(isAuthRejected({ message: 'x', code: 'ECONNREFUSED' })).toBe(false)
    expect(isAuthRejected('nope')).toBe(false)
  })
})

describe('SSL options', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-ssl-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('passes CA, client certificate and key to mysql2, with server verification', async () => {
    for (const f of ['ca.pem', 'client-cert.pem', 'client-key.pem'])
      writeFileSync(join(dir, f), `-----${f}-----`)
    const input: ConnectionInput = {
      ...connectionInput('Cert'),
      authMode: 'none',
      ssl: {
        enabled: true,
        caCertPath: join(dir, 'ca.pem'),
        clientCertPath: join(dir, 'client-cert.pem'),
        clientKeyPath: join(dir, 'client-key.pem'),
        verifyServer: true
      }
    }
    const options = await buildOptions(input, undefined, { host: '127.0.0.1', port: 3306 })
    const ssl = options.ssl as Record<string, unknown>
    expect(String(ssl.ca)).toBe('-----ca.pem-----')
    expect(String(ssl.cert)).toBe('-----client-cert.pem-----')
    expect(String(ssl.key)).toBe('-----client-key.pem-----')
    expect(ssl.rejectUnauthorized).toBe(true)
    expect(options).not.toHaveProperty('password')
  })

  it('is off when disabled and reports an unreadable file actionably', async () => {
    expect(await buildSsl(connectionInput('Plain'))).toBeUndefined()
    await expect(
      buildSsl({
        ...connectionInput('Cert'),
        ssl: { enabled: true, clientCertPath: join(dir, 'missing.pem'), verifyServer: false }
      })
    ).rejects.toThrow(/No se pudo leer el archivo de certificado cliente SSL/)
  })
})
