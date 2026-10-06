import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CredentialStore, plainCodec, type SecretCodec } from '../credentials/store'
import { ConnectionsRepo } from '../storage/repos'
import type { KeychainReadResult } from './legacyKeychain'
import { decryptMacOsCrypt, deriveMacOsCryptKey, encryptMacOsCrypt } from './osCrypt'
import { migrateLegacySecrets, reenterPasswordsMessage } from './secrets'

const silent = { info: () => {}, warn: () => {} }
const OLD_PASSWORD = 'old-keychain-password'
const NEW_PASSWORD = 'new-keychain-password'

/** Stands in for safeStorage under the new name: os_crypt with another keychain password. */
function newSafeStorage(): SecretCodec {
  const key = deriveMacOsCryptKey(NEW_PASSWORD)
  return {
    encrypt: (plain) => encryptMacOsCrypt(plain, key).toString('base64'),
    decrypt: (cipher) => {
      const plain = decryptMacOsCrypt(Buffer.from(cipher, 'base64'), key)
      if (plain === null) throw new Error('Error while decrypting the ciphertext')
      return plain
    }
  }
}

const legacyValue = (plain: string): string =>
  encryptMacOsCrypt(plain, deriveMacOsCryptKey(OLD_PASSWORD)).toString('base64')

describe('migrateLegacySecrets', () => {
  let dir: string
  let connections: ConnectionsRepo

  const writeCredentials = (codec: string, items: Record<string, string>): void =>
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ version: 1, codec, items }))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'electrondb-secrets-'))
    writeFileSync(
      join(dir, 'connections.json'),
      JSON.stringify({
        version: 1,
        items: [
          { id: 'c1', name: 'Dev' },
          { id: 'c2', name: 'Producción' }
        ]
      })
    )
    connections = new ConnectionsRepo(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('macOS: decrypts with the old keychain key and re-encrypts with the current codec', async () => {
    writeCredentials('safeStorage', {
      'mysql:c1': legacyValue('dev-pass'),
      'ssh:c2': legacyValue('ssh-pass')
    })
    const store = new CredentialStore(dir, newSafeStorage(), 'safeStorage')
    const legacyPassword = vi.fn(async (): Promise<KeychainReadResult> => ({
      ok: true,
      password: OLD_PASSWORD
    }))
    const result = await migrateLegacySecrets({
      credentials: store,
      connections,
      platform: 'darwin',
      legacyPassword,
      log: silent
    })
    expect(result).toMatchObject({ migrated: 2, kept: 0, dropped: [], legacyKeyProblem: null })
    expect(legacyPassword).toHaveBeenCalledTimes(1)
    expect(store.get('mysql', 'c1')).toBe('dev-pass')
    expect(store.get('ssh', 'c2')).toBe('ssh-pass')
    // persisted, and readable by a fresh store with the new key
    const reopened = new CredentialStore(dir, newSafeStorage(), 'safeStorage')
    expect(reopened.get('mysql', 'c1')).toBe('dev-pass')
    expect(readFileSync(join(dir, 'credentials.json'), 'utf8')).not.toContain('dev-pass')
  })

  it('macOS into a plain (test) profile: values become base64 of the plaintext', async () => {
    writeCredentials('safeStorage', { 'mysql:c1': legacyValue('dev-pass') })
    const store = new CredentialStore(dir, plainCodec, 'plain')
    await migrateLegacySecrets({
      credentials: store,
      connections,
      platform: 'darwin',
      legacyPassword: async () => ({ ok: true, password: OLD_PASSWORD }),
      log: silent
    })
    expect(store.storedCodec()).toBe('plain')
    expect(store.get('mysql', 'c1')).toBe('dev-pass')
  })

  it('macOS, keychain access denied: drops every value and names the connections', async () => {
    writeCredentials('safeStorage', {
      'mysql:c1': legacyValue('dev-pass'),
      'mysql:c2': legacyValue('prod-pass'),
      'ssh:c2': legacyValue('ssh-pass')
    })
    const store = new CredentialStore(dir, newSafeStorage(), 'safeStorage')
    const legacyPassword = vi.fn(async (): Promise<KeychainReadResult> => ({
      ok: false,
      reason: 'denied',
      detail: 'acceso denegado (código 128)'
    }))
    const result = await migrateLegacySecrets({
      credentials: store,
      connections,
      platform: 'darwin',
      legacyPassword,
      log: silent
    })
    expect(legacyPassword).toHaveBeenCalledTimes(1)
    expect(result.migrated).toBe(0)
    expect(result.dropped.sort()).toEqual(['mysql:c1', 'mysql:c2', 'ssh:c2'])
    expect(result.passwordsToReenter.sort()).toEqual(['Dev', 'Producción', 'Producción (SSH)'])
    expect(result.legacyKeyProblem).toContain('denegado')
    expect(store.has('mysql', 'c1')).toBe(false)
    expect(store.has('ssh', 'c2')).toBe(false)
    expect(reenterPasswordsMessage(['Dev', 'Producción'])).toBe(
      'Vuelve a escribir la contraseña de: Dev, Producción'
    )
  })

  it('macOS, wrong old key: drops the value instead of storing garbage', async () => {
    writeCredentials('safeStorage', { 'mysql:c1': legacyValue('dev-pass') })
    const store = new CredentialStore(dir, newSafeStorage(), 'safeStorage')
    const result = await migrateLegacySecrets({
      credentials: store,
      connections,
      platform: 'darwin',
      legacyPassword: async () => ({ ok: true, password: 'not the right one' }),
      log: silent
    })
    expect(result.dropped).toEqual(['mysql:c1'])
    expect(store.has('mysql', 'c1')).toBe(false)
  })

  it('keeps values the current codec already reads (Windows with the copied Local State)', async () => {
    const current = newSafeStorage()
    writeCredentials('safeStorage', {
      'mysql:c1': current.encrypt('dev-pass'),
      'mysql:c2': legacyValue('prod-pass')
    })
    const store = new CredentialStore(dir, current, 'safeStorage')
    const legacyPassword = vi.fn(async (): Promise<KeychainReadResult> => ({
      ok: false,
      reason: 'not-found',
      detail: 'n/a'
    }))
    const result = await migrateLegacySecrets({
      credentials: store,
      connections,
      platform: 'win32',
      legacyPassword,
      log: silent
    })
    expect(legacyPassword).not.toHaveBeenCalled()
    expect(result).toMatchObject({ kept: 1, migrated: 0, dropped: ['mysql:c2'] })
    expect(store.get('mysql', 'c1')).toBe('dev-pass')
    expect(result.passwordsToReenter).toEqual(['Producción'])
  })

  it('Linux: unreadable values (old keyring entry) are dropped without asking the keychain', async () => {
    writeCredentials('safeStorage', { 'mysql:c1': Buffer.from('v11garbage').toString('base64') })
    const store = new CredentialStore(dir, newSafeStorage(), 'safeStorage')
    const legacyPassword = vi.fn(async (): Promise<KeychainReadResult> => ({
      ok: true,
      password: OLD_PASSWORD
    }))
    const result = await migrateLegacySecrets({
      credentials: store,
      connections,
      platform: 'linux',
      legacyPassword,
      log: silent
    })
    expect(legacyPassword).not.toHaveBeenCalled()
    expect(result.passwordsToReenter).toEqual(['Dev'])
  })

  it('plain (test) profiles are re-encoded with the current codec', async () => {
    writeCredentials('plain', { 'mysql:c1': plainCodec.encrypt('dev-pass') })
    const store = new CredentialStore(dir, newSafeStorage(), 'safeStorage')
    const result = await migrateLegacySecrets({
      credentials: store,
      connections,
      platform: 'darwin',
      legacyPassword: async () => ({ ok: false, reason: 'not-found', detail: 'n/a' }),
      log: silent
    })
    expect(result.migrated).toBe(1)
    expect(store.storedCodec()).toBe('safeStorage')
    expect(store.get('mysql', 'c1')).toBe('dev-pass')
  })

  it('labels unknown connection ids by id', async () => {
    writeCredentials('safeStorage', { 'mysql:gone': legacyValue('x') })
    const store = new CredentialStore(dir, newSafeStorage(), 'safeStorage')
    const result = await migrateLegacySecrets({
      credentials: store,
      connections,
      platform: 'darwin',
      legacyPassword: async () => ({ ok: false, reason: 'failed', detail: 'boom' }),
      log: silent
    })
    expect(result.passwordsToReenter).toEqual(['gone'])
  })
})
