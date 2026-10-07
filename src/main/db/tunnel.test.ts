import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { utils } from 'ssh2'
import type { SshConfig } from '@shared/types'
import { MysqlUserError } from '../mysql/errors'
import { buildConnectConfig, checkPrivateKey, openSshTunnel, type SshTunnelOptions } from './tunnel'

let dir: string
let encryptedPath: string
let plainPath: string
let garbagePath: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'electrondb-tunnel-'))
  encryptedPath = join(dir, 'id_encrypted')
  plainPath = join(dir, 'id_plain')
  garbagePath = join(dir, 'id_garbage')
  writeFileSync(
    encryptedPath,
    utils.generateKeyPairSync('ed25519', { passphrase: 'correct', cipher: 'aes256-ctr', rounds: 4 })
      .private
  )
  writeFileSync(plainPath, utils.generateKeyPairSync('ed25519').private)
  writeFileSync(garbagePath, 'not a key')
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function options(ssh: Partial<SshConfig>, secret: string | null): SshTunnelOptions {
  return {
    ssh: {
      enabled: true,
      host: 'bastion.example',
      port: 2222,
      username: 'deploy',
      authType: 'password',
      savePassword: true,
      ...ssh
    },
    secret,
    targetHost: '127.0.0.1',
    targetPort: 3306,
    readyTimeout: 1000
  }
}

describe('buildConnectConfig', () => {
  it('builds a password config', async () => {
    const config = await buildConnectConfig(options({}, 'pw'))
    expect(config).toMatchObject({
      host: 'bastion.example',
      port: 2222,
      username: 'deploy',
      password: 'pw',
      readyTimeout: 1000
    })
  })

  it('refuses a password tunnel without a stored password', async () => {
    await expect(buildConnectConfig(options({}, null))).rejects.toThrow(
      'No hay contraseña SSH guardada para deploy@bastion.example'
    )
  })

  it('requires host, user and key path', async () => {
    await expect(buildConnectConfig(options({ host: '' }, 'pw'))).rejects.toThrow(/no tiene host/)
    await expect(buildConnectConfig(options({ username: '' }, 'pw'))).rejects.toThrow(
      /no tiene usuario/
    )
    await expect(buildConnectConfig(options({ authType: 'key' }, null))).rejects.toThrow(
      /no se indicó la ruta/
    )
    await expect(
      buildConnectConfig(options({ authType: 'key', privateKeyPath: join(dir, 'missing') }, null))
    ).rejects.toThrow(/No se pudo leer la clave privada/)
  })

  it('accepts an unencrypted key with or without passphrase', async () => {
    const config = await buildConnectConfig(
      options({ authType: 'key', privateKeyPath: plainPath }, null)
    )
    expect(Buffer.isBuffer(config.privateKey)).toBe(true)
    expect(config.password).toBeUndefined()
    expect(config.passphrase).toBeUndefined()
  })

  it('accepts an encrypted key with the right passphrase', async () => {
    const config = await buildConnectConfig(
      options({ authType: 'key', privateKeyPath: encryptedPath }, 'correct')
    )
    expect(config.passphrase).toBe('correct')
  })

  it('explains a missing or wrong passphrase in Spanish without leaking it', async () => {
    const missing = await buildConnectConfig(
      options({ authType: 'key', privateKeyPath: encryptedPath }, null)
    ).catch((e) => e)
    expect(missing).toBeInstanceOf(MysqlUserError)
    expect(missing.message).toMatch(/está cifrada y no hay frase de contraseña guardada/)

    const wrong = await buildConnectConfig(
      options({ authType: 'key', privateKeyPath: encryptedPath }, 's3cr3t-wrong')
    ).catch((e) => e)
    expect(wrong).toBeInstanceOf(MysqlUserError)
    expect(wrong.message).toMatch(/frase de contraseña .* es incorrecta/)
    expect(wrong.message).not.toContain('s3cr3t-wrong')
  })

  it('rejects an unsupported key file', () => {
    expect(() => checkPrivateKey(Buffer.from('not a key'), null, garbagePath)).toThrow(
      /no tiene un formato soportado/
    )
  })
})

describe('openSshTunnel', () => {
  it('fails with a Spanish MysqlUserError before connecting when the passphrase is missing', async () => {
    const err = await openSshTunnel(
      options({ authType: 'key', privateKeyPath: encryptedPath }, null)
    ).catch((e) => e)
    expect(err).toBeInstanceOf(MysqlUserError)
  })

  it('wraps an unreachable SSH server into a Spanish MysqlUserError', async () => {
    // port 1 on loopback: refused immediately, no external traffic
    const err = await openSshTunnel(options({ host: '127.0.0.1', port: 1 }, 'pw')).catch((e) => e)
    expect(err).toBeInstanceOf(MysqlUserError)
    expect(err.message).toMatch(/^No se pudo conectar por SSH a 127\.0\.0\.1/)
  })
})
