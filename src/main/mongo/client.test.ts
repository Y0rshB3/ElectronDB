import { describe, expect, it } from 'vitest'
import { defaultMongoOptions } from '@shared/engines'
import type { ConnectionInput, MongoOptions } from '@shared/types'
import { buildClientPlan } from './client'

function input(
  mongo: Partial<MongoOptions> = {},
  extra: Partial<ConnectionInput> = {}
): ConnectionInput {
  return {
    name: 'm',
    color: null,
    environment: 'local',
    host: 'db.example',
    port: 27017,
    username: 'ana',
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
    ssl: { enabled: false, verifyServer: true },
    backupDir: '',
    extraBackupDirs: [],
    engine: 'mongodb',
    mongo: { ...defaultMongoOptions(), ...mongo },
    ...extra
  }
}

const secrets = { password: 's3cret' }

describe('buildClientPlan', () => {
  it('puts credentials in auth, never in the URI', async () => {
    const plan = await buildClientPlan(input(), secrets, { host: 'db.example', port: 27017 })
    expect(plan.uri).toBe('mongodb://db.example:27017/')
    expect(plan.uri).not.toContain('s3cret')
    expect(plan.uri).not.toContain('ana')
    expect(plan.options.auth).toEqual({ username: 'ana', password: 's3cret' })
    expect(plan.options.authSource).toBe('admin')
    expect(plan.options.appName).toBe('Vortaq')
    expect(plan.options.serverSelectionTimeoutMS).toBe(10_000)
    expect(plan.options.directConnection).toBe(true)
  })

  it('turns TLS on for SRV and leaves the host as the SRV name', async () => {
    const plan = await buildClientPlan(
      input({ srv: true, topology: 'replicaSet' }, { host: 'c.example.net', port: 0 }),
      secrets,
      null
    )
    expect(plan.uri).toBe('mongodb+srv://c.example.net/')
    expect(plan.options.tls).toBe(true)
    expect(plan.options.directConnection).toBeUndefined()
  })

  it('uses the seed list and replica set name', async () => {
    const plan = await buildClientPlan(
      input({
        topology: 'replicaSet',
        replicaSet: 'rs0',
        members: [
          { host: 'a', port: 1 },
          { host: 'b', port: 2 }
        ]
      }),
      secrets,
      null
    )
    expect(plan.uri).toBe('mongodb://a:1,b:2/')
    expect(plan.options.replicaSet).toBe('rs0')
  })

  it('goes straight to the tunnel and keeps the real host for TLS', async () => {
    const plan = await buildClientPlan(
      input(
        {},
        {
          ssh: {
            enabled: true,
            host: 'jump',
            port: 22,
            username: 'u',
            authType: 'password',
            savePassword: false
          },
          ssl: { enabled: true, verifyServer: true }
        }
      ),
      secrets,
      { host: '127.0.0.1', port: 40001, tlsServername: 'db.example' }
    )
    expect(plan.uri).toBe('mongodb://127.0.0.1:40001/')
    expect(plan.options.directConnection).toBe(true)
    expect(plan.options.servername).toBe('db.example')
  })

  it('refuses SRV or a replica set through SSH', async () => {
    const ssh = {
      enabled: true,
      host: 'jump',
      port: 22,
      username: 'u',
      authType: 'password' as const,
      savePassword: false
    }
    await expect(buildClientPlan(input({ srv: true }, { ssh }), secrets, null)).rejects.toThrow(
      /SRV/
    )
    await expect(
      buildClientPlan(
        input({ topology: 'replicaSet', members: [{ host: 'a', port: 1 }] }, { ssh }),
        secrets,
        {
          host: '127.0.0.1',
          port: 1
        }
      )
    ).rejects.toThrow(/independiente o directa/)
  })

  it('refuses credentials in the extra options and drops native compressors', async () => {
    await expect(
      buildClientPlan(input({ extraOptions: { proxyPassword: 'x' } }), secrets, null)
    ).rejects.toThrow(/credenciales/)
    const plan = await buildClientPlan(
      input({
        extraOptions: { compressors: 'snappy,zstd,zlib', w: 'majority', maxIdleTimeMS: '1000' }
      }),
      secrets,
      null
    )
    expect(plan.options.compressors).toEqual(['zlib'])
    expect(plan.options.w).toBe('majority')
    expect(plan.options.maxIdleTimeMS).toBe(1000)
  })

  it('maps mechanisms and keeps retryWrites off when asked (DocumentDB/Cosmos)', async () => {
    const plan = await buildClientPlan(
      input({ authMechanism: 'scram-sha-256', retryWrites: false }),
      secrets,
      null
    )
    expect(plan.options.authMechanism).toBe('SCRAM-SHA-256')
    expect(plan.options.retryWrites).toBe(false)
    const none = await buildClientPlan(input({ authMechanism: 'none' }), secrets, null)
    expect(none.options.auth).toBeUndefined()
    await expect(buildClientPlan(input({ authMechanism: 'x509' }), secrets, null)).rejects.toThrow(
      /TLS/
    )
  })
})
