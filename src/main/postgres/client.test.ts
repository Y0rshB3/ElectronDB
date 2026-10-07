import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import {
  APPLICATION_NAME,
  PINNED_OPTIONS,
  buildSslPlan,
  composeSearchPath,
  createClient,
  formatSearchPath,
  parseSearchPath,
  shouldRetrySsl,
  sslModeOf
} from './client'

const AMBIENT = {
  PGPASSWORD: 'from-env',
  PGUSER: 'envuser',
  PGDATABASE: 'envdb',
  PGHOST: 'env.example.test',
  PGPORT: '6543',
  PGOPTIONS: '-c search_path=evil',
  PGREPLICATION: 'database',
  PGAPPNAME: 'other-app',
  PGCLIENTENCODING: 'LATIN1',
  PGSSLMODE: 'disable',
  PGSSLNEGOTIATION: 'direct'
}

describe('pg clients never use ambient credentials (invariant 7)', () => {
  const saved: Record<string, string | undefined> = {}
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-pgpass-'))
    const passfile = join(dir, 'pgpass')
    writeFileSync(passfile, '*:*:*:*:from-pgpass\n', { mode: 0o600 })
    for (const [k, v] of Object.entries({ ...AMBIENT, PGPASSFILE: passfile })) {
      saved[k] = process.env[k]
      process.env[k] = v
    }
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('sets every connection parameter explicitly and asks for the password through a function', async () => {
    const client = createClient({
      endpoint: { host: '127.0.0.1', port: 55432 },
      user: 'app',
      database: 'shop',
      password: null,
      ssl: false,
      connectTimeoutMs: 1000,
      keepAliveSec: 0
    })
    const params = (client as unknown as { connectionParameters: Record<string, unknown> })
      .connectionParameters
    expect(params.user).toBe('app')
    expect(params.database).toBe('shop')
    expect(params.host).toBe('127.0.0.1')
    expect(params.port).toBe(55432)
    expect(params.options).toBe(PINNED_OPTIONS)
    expect(params.replication).toBeUndefined()
    expect(params.application_name).toBe(APPLICATION_NAME)
    expect(params.client_encoding).toBe('UTF8')
    expect(params.ssl).toBe(false)
    expect(params.sslnegotiation).toBe('postgres')
    const password = (client as unknown as { password: unknown }).password
    expect(typeof password).toBe('function')
    // No stored password: an empty one, never PGPASSWORD or ~/.pgpass.
    expect(await (password as () => Promise<string>)()).toBe('')
  })

  it('pins the session settings the value-fidelity contract relies on', () => {
    expect(PINNED_OPTIONS).toBe(
      '-c DateStyle=ISO,MDY -c IntervalStyle=postgres -c extra_float_digits=3 -c bytea_output=hex'
    )
  })
})

const base = (ssl: ConnectionInput['ssl'], host = 'db.example.test') =>
  ({ ssl, host }) as Pick<ConnectionInput, 'ssl' | 'host'>

describe('SSL modes (libpq names)', () => {
  it('derives the mode from the generic switches when none is stored', () => {
    expect(sslModeOf(base({ enabled: false, verifyServer: false }))).toBe('disable')
    expect(sslModeOf(base({ enabled: true, verifyServer: false }))).toBe('require')
    expect(sslModeOf(base({ enabled: true, verifyServer: true }))).toBe('verify-full')
    expect(sslModeOf(base({ enabled: true, verifyServer: false, mode: 'prefer' }))).toBe('prefer')
  })

  it('maps each mode to TLS options and a fallback', async () => {
    const endpoint = { host: 'db.example.test', port: 5432 }
    const plan = (mode: NonNullable<ConnectionInput['ssl']['mode']>) =>
      buildSslPlan(base({ enabled: mode !== 'disable', verifyServer: false, mode }), endpoint)
    expect(await plan('disable')).toEqual({ first: false, fallback: null, mode: 'disable' })
    expect(await plan('allow')).toMatchObject({
      first: false,
      fallback: { rejectUnauthorized: false }
    })
    expect(await plan('prefer')).toMatchObject({
      first: { rejectUnauthorized: false },
      fallback: false
    })
    expect(await plan('require')).toMatchObject({
      first: { rejectUnauthorized: false },
      fallback: null
    })
    const verifyCa = await plan('verify-ca')
    expect(verifyCa.first).toMatchObject({ rejectUnauthorized: true })
    expect(
      (verifyCa.first as { checkServerIdentity: () => unknown }).checkServerIdentity()
    ).toBeUndefined()
    expect(await plan('verify-full')).toMatchObject({
      first: { rejectUnauthorized: true, servername: 'db.example.test' }
    })
  })

  it('verifies the real host through an SSH tunnel (servername, not 127.0.0.1)', async () => {
    const plan = await buildSslPlan(
      base({ enabled: true, verifyServer: true, mode: 'verify-full' }),
      { host: '127.0.0.1', port: 40001, tlsServername: 'db.example.test' }
    )
    expect(plan.first).toMatchObject({ servername: 'db.example.test', rejectUnauthorized: true })
    expect(typeof (plan.first as { checkServerIdentity?: unknown }).checkServerIdentity).toBe(
      'function'
    )
  })

  it('retries only on the errors the mode allows', async () => {
    const endpoint = { host: 'h', port: 1 }
    const prefer = await buildSslPlan(
      base({ enabled: true, verifyServer: false, mode: 'prefer' }),
      endpoint
    )
    expect(shouldRetrySsl(prefer, new Error('The server does not support SSL connections'))).toBe(
      true
    )
    expect(shouldRetrySsl(prefer, new Error('password authentication failed'))).toBe(false)
    const allow = await buildSslPlan(
      base({ enabled: true, verifyServer: false, mode: 'allow' }),
      endpoint
    )
    expect(
      shouldRetrySsl(
        allow,
        new Error('no pg_hba.conf entry for host "x", user "u", database "d", no encryption')
      )
    ).toBe(true)
    const require = await buildSslPlan(
      base({ enabled: true, verifyServer: false, mode: 'require' }),
      endpoint
    )
    expect(shouldRetrySsl(require, new Error('The server does not support SSL connections'))).toBe(
      false
    )
  })

  it('refuses unreadable certificate files with a Spanish message', async () => {
    await expect(
      buildSslPlan(
        base({
          enabled: true,
          verifyServer: true,
          mode: 'verify-full',
          caCertPath: '/nonexistent/ca.pem'
        }),
        { host: 'h', port: 1 }
      )
    ).rejects.toThrow('No se pudo leer el archivo CA SSL en /nonexistent/ca.pem')
  })
})

describe('search_path composition', () => {
  it('puts the tab schema first, keeps public and drops duplicates', () => {
    expect(composeSearchPath('app', ['$user', 'public'])).toEqual(['app', '$user', 'public'])
    expect(composeSearchPath('public', ['$user', 'public'])).toEqual(['public', '$user'])
    expect(composeSearchPath(null, ['a', 'a', 'public'])).toEqual(['a', 'public'])
  })

  it('parses and formats search_path settings with quoted names', () => {
    expect(parseSearchPath('"$user", public')).toEqual(['$user', 'public'])
    expect(parseSearchPath('app, "My ""Schema""", public')).toEqual([
      'app',
      'My "Schema"',
      'public'
    ])
    expect(formatSearchPath(['app', 'My "Schema"'])).toBe('"app", "My ""Schema"""')
  })
})
