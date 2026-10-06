import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialStore, plainCodec } from '../credentials/store'
import { ConnectionsRepo } from '../storage/repos'
import {
  dismissStartupNotice,
  legacySecretsToRetry,
  MAX_SECRET_ATTEMPTS,
  REENTER_PASSWORDS_NOTICE,
  runProfileMigration,
  runSecretMigration,
  startupNotices
} from './index'
import type { KeychainExecFn } from './legacyKeychain'
import { deriveMacOsCryptKey, encryptMacOsCrypt } from './osCrypt'
import { readMigrationMarker, writeMigrationMarker } from './profile'

const OLD_PASSWORD = 'legacy-safe-storage-password'

describe('Navidog -> ElectronDB migration flow', () => {
  let root: string
  let appData: string
  let legacy: string
  let current: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'electrondb-flow-'))
    appData = join(root, 'Application Support')
    legacy = join(appData, 'Navidog')
    current = join(appData, 'ElectronDB')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(
      join(legacy, 'connections.json'),
      JSON.stringify({
        version: 1,
        items: [
          { id: 'c1', name: 'Dev' },
          { id: 'c2', name: 'Producción' }
        ]
      })
    )
    const key = deriveMacOsCryptKey(OLD_PASSWORD)
    writeFileSync(
      join(legacy, 'credentials.json'),
      JSON.stringify({
        version: 1,
        codec: 'safeStorage',
        items: {
          'mysql:c1': encryptMacOsCrypt('dev-pass', key).toString('base64'),
          'mysql:c2': encryptMacOsCrypt('prod-pass', key).toString('base64')
        }
      })
    )
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const contextFor = (dir: string) => ({
    userDataPath: dir,
    connections: new ConnectionsRepo(dir),
    credentials: new CredentialStore(dir, plainCodec, 'plain')
  })

  it('a scratch profile never picks up the real legacy profile', () => {
    const result = runProfileMigration({
      appData,
      userData: join(root, 'scratch'),
      userDataOverride: join(root, 'scratch'),
      legacyUserDataOverride: null
    })
    expect(result).toEqual({ status: 'skipped', reason: 'scratch profile' })
    expect(existsSync(join(root, 'scratch', 'connections.json'))).toBe(false)
  })

  it('an explicit legacy folder (tests) is migrated even into a scratch profile', () => {
    const scratch = join(root, 'scratch')
    const result = runProfileMigration({
      appData: join(root, 'elsewhere'),
      userData: scratch,
      userDataOverride: scratch,
      legacyUserDataOverride: legacy
    })
    expect(result.status).toBe('migrated')
    expect(existsSync(join(scratch, 'credentials.json'))).toBe(true)
  })

  it('copies, re-encrypts with the old keychain key and clears the pending state', async () => {
    expect(
      runProfileMigration({
        appData,
        userData: current,
        userDataOverride: null,
        legacyUserDataOverride: null
      }).status
    ).toBe('migrated')
    const calls: string[][] = []
    const exec: KeychainExecFn = async (file, args) => {
      calls.push([file, ...args])
      return { stdout: `${OLD_PASSWORD}\n` }
    }
    const ctx = contextFor(current)
    await runSecretMigration(ctx, { platform: 'darwin', keychain: '/k.keychain-db', exec })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([
      'security',
      'find-generic-password',
      '-s',
      'Navidog Safe Storage',
      '-w',
      '/k.keychain-db'
    ])
    expect(ctx.credentials.get('mysql', 'c1')).toBe('dev-pass')
    expect(ctx.credentials.get('mysql', 'c2')).toBe('prod-pass')
    expect(readMigrationMarker(current)).toMatchObject({ secrets: 'done', passwordsToReenter: [] })
    expect(startupNotices(current)).toEqual([])

    // runs once: a second start does not ask the keychain again
    await runSecretMigration(contextFor(current), { platform: 'darwin', exec })
    expect(calls).toHaveLength(1)
  })

  const migrate = (): void => {
    runProfileMigration({
      appData,
      userData: current,
      userDataOverride: null,
      legacyUserDataOverride: null
    })
  }
  const denied: KeychainExecFn = async () =>
    Promise.reject(Object.assign(new Error('User canceled the operation.'), { code: 128 }))
  const allowed: KeychainExecFn = async () => ({ stdout: `${OLD_PASSWORD}\n` })
  const notFound: KeychainExecFn = async () =>
    Promise.reject(Object.assign(new Error('not found'), { code: 44 }))

  it('denied keychain access: keeps retrying on the next starts, then gives up with one notice', async () => {
    migrate()
    for (let attempt = 1; attempt < MAX_SECRET_ATTEMPTS; attempt++) {
      const ctx = contextFor(current)
      await runSecretMigration(ctx, { platform: 'darwin', exec: denied })
      expect(ctx.credentials.has('mysql', 'c1')).toBe(false)
      expect(readMigrationMarker(current)).toMatchObject({
        secrets: 'pending',
        secretAttempts: attempt,
        passwordsToReenter: ['Dev', 'Producción']
      })
      const notices = startupNotices(current)
      expect(notices).toHaveLength(1)
      expect(notices[0].message).toContain('lo intentará de nuevo en el próximo arranque')
      dismissStartupNotice(current, REENTER_PASSWORDS_NOTICE)
      expect(startupNotices(current)).toEqual([])
    }

    const ctx = contextFor(current)
    await runSecretMigration(ctx, { platform: 'darwin', exec: denied })
    expect(readMigrationMarker(current)).toMatchObject({
      secrets: 'done',
      secretAttempts: MAX_SECRET_ATTEMPTS
    })
    const notices = startupNotices(current)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ id: REENTER_PASSWORDS_NOTICE, level: 'warning' })
    expect(notices[0].message).toContain('Vuelve a escribir la contraseña de: Dev, Producción')

    dismissStartupNotice(current, REENTER_PASSWORDS_NOTICE)
    expect(startupNotices(current)).toEqual([])
    // the legacy profile still holds every value
    expect(Object.keys(legacySecretsToRetry(legacy, ctx).items).sort()).toEqual([
      'mysql:c1',
      'mysql:c2'
    ])
  })

  it('a retry recovers the values from the legacy profile and keeps passwords typed meanwhile', async () => {
    migrate()
    await runSecretMigration(contextFor(current), { platform: 'darwin', exec: denied })
    const meanwhile = contextFor(current)
    meanwhile.credentials.set('mysql', 'c2', 'typed-again')

    const ctx = contextFor(current)
    await runSecretMigration(ctx, { platform: 'darwin', exec: allowed })
    expect(ctx.credentials.get('mysql', 'c1')).toBe('dev-pass')
    expect(ctx.credentials.get('mysql', 'c2')).toBe('typed-again')
    expect(readMigrationMarker(current)).toMatchObject({
      secrets: 'done',
      secretAttempts: 2,
      passwordsToReenter: []
    })
    expect(startupNotices(current)).toEqual([])
  })

  it('a missing legacy key is final, and setting the marker back to pending recovers later', async () => {
    migrate()
    await runSecretMigration(contextFor(current), { platform: 'darwin', exec: notFound })
    expect(readMigrationMarker(current)).toMatchObject({ secrets: 'done', secretAttempts: 1 })

    // README recovery: the user sets "secrets" back to "pending"
    const marker = readMigrationMarker(current)!
    writeMigrationMarker(current, { ...marker, secrets: 'pending' })
    const ctx = contextFor(current)
    await runSecretMigration(ctx, { platform: 'darwin', exec: allowed })
    expect(ctx.credentials.get('mysql', 'c1')).toBe('dev-pass')
    expect(ctx.credentials.get('mysql', 'c2')).toBe('prod-pass')
    expect(readMigrationMarker(current)).toMatchObject({ secrets: 'done', secretAttempts: 2 })
  })

  it('a retry ignores legacy values of connections deleted since', async () => {
    migrate()
    await runSecretMigration(contextFor(current), { platform: 'darwin', exec: denied })
    const ctx = contextFor(current)
    ctx.connections.delete('c2')
    expect(Object.keys(legacySecretsToRetry(legacy, ctx).items)).toEqual(['mysql:c1'])
    expect(legacySecretsToRetry(join(root, 'gone'), ctx).items).toEqual({})
  })

  it('does nothing without a marker (fresh install or no legacy profile)', async () => {
    const fresh = join(root, 'fresh')
    mkdirSync(fresh)
    const exec: KeychainExecFn = async () => {
      throw new Error('must not be called')
    }
    await expect(
      runSecretMigration(contextFor(fresh), { platform: 'darwin', exec })
    ).resolves.toBeUndefined()
    expect(startupNotices(fresh)).toEqual([])
  })
})
