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
  PROFILE_MOVED_NOTICE,
  REENTER_PASSWORDS_NOTICE,
  runProfileMigration,
  runSecretMigration,
  startupNotices
} from './index'
import type { KeychainExecFn } from './legacyKeychain'
import { deriveMacOsCryptKey, encryptMacOsCrypt } from './osCrypt'
import { readMigrationMarker, writeMigrationMarker } from './profile'

const OLD_PASSWORD = 'legacy-safe-storage-password'

describe('Navidog -> Vortaq migration flow', () => {
  let root: string
  let appData: string
  let legacy: string
  let current: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'electrondb-flow-'))
    appData = join(root, 'Application Support')
    legacy = join(appData, 'Navidog')
    current = join(appData, 'Vortaq')
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

  /** Notices about passwords (the one-time "moved" notice has its own tests). */
  const secretNotices = () => startupNotices(current).filter((n) => n.id !== PROFILE_MOVED_NOTICE)

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
    expect(secretNotices()).toEqual([])

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
      const notices = secretNotices()
      expect(notices).toHaveLength(1)
      expect(notices[0].message).toContain('lo intentará de nuevo en el próximo arranque')
      dismissStartupNotice(current, REENTER_PASSWORDS_NOTICE)
      expect(secretNotices()).toEqual([])
    }

    const ctx = contextFor(current)
    await runSecretMigration(ctx, { platform: 'darwin', exec: denied })
    expect(readMigrationMarker(current)).toMatchObject({
      secrets: 'done',
      secretAttempts: MAX_SECRET_ATTEMPTS
    })
    const notices = secretNotices()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ id: REENTER_PASSWORDS_NOTICE, level: 'warning' })
    expect(notices[0].message).toContain('Vuelve a escribir la contraseña de: Dev, Producción')

    dismissStartupNotice(current, REENTER_PASSWORDS_NOTICE)
    expect(secretNotices()).toEqual([])
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
    expect(secretNotices()).toEqual([])
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

describe('ElectronDB -> Vortaq migration flow', () => {
  const ED_PASSWORD = 'electrondb-safe-storage-password'
  const ND_PASSWORD = 'navidog-safe-storage-password'
  let root: string
  let appData: string
  let electronDb: string
  let navidog: string
  let current: string

  const writeJson = (dir: string, name: string, value: unknown): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), JSON.stringify(value))
  }
  const contextFor = (dir: string) => ({
    userDataPath: dir,
    connections: new ConnectionsRepo(dir),
    credentials: new CredentialStore(dir, plainCodec, 'plain')
  })
  /** Fake `security`: answers per keychain item and records the items asked for. */
  const keychain =
    (items: Record<string, string>, asked: string[]): KeychainExecFn =>
    async (_file, args) => {
      const service = args[args.indexOf('-s') + 1]
      asked.push(service)
      if (service in items) return { stdout: `${items[service]}\n` }
      throw Object.assign(new Error('not found'), { code: 44 })
    }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vortaq-chain-'))
    appData = join(root, 'Application Support')
    electronDb = join(appData, 'ElectronDB')
    navidog = join(appData, 'Navidog')
    current = join(appData, 'Vortaq')
    const ed = deriveMacOsCryptKey(ED_PASSWORD)
    const nd = deriveMacOsCryptKey(ND_PASSWORD)
    writeJson(electronDb, 'connections.json', {
      version: 1,
      items: [
        { id: 'c1', name: 'Dev' },
        { id: 'c2', name: 'Producción' }
      ]
    })
    writeJson(electronDb, 'credentials.json', {
      version: 1,
      codec: 'safeStorage',
      items: {
        'mysql:c1': encryptMacOsCrypt('dev-pass', ed).toString('base64'),
        'ai:p1': encryptMacOsCrypt('sk-test-key', ed).toString('base64'),
        // left behind by an unfinished Navidog -> ElectronDB migration
        'mysql:c2': encryptMacOsCrypt('prod-pass', nd).toString('base64')
      }
    })
    writeJson(electronDb, 'jobs.json', { version: 1, items: [{ id: 'j1', name: 'Nightly' }] })
    writeJson(electronDb, 'tour.json', { completed: true })
    writeJson(electronDb, 'updates.json', { lastSeenVersion: '0.1.9' })
    writeJson(electronDb, 'filter-profiles.json', { version: 1, items: [] })
    writeJson(electronDb, 'ai-providers.json', { version: 1, items: [{ id: 'p1' }] })
    writeJson(join(electronDb, 'ai'), 'c1.json', { conversations: [] })
    writeJson(electronDb, 'migrated-from-navidog.json', { version: 1, from: navidog })
    writeJson(navidog, 'connections.json', { version: 1, items: [{ id: 'old', name: 'Old' }] })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const migrate = () =>
    runProfileMigration({
      appData,
      userData: current,
      userDataOverride: null,
      legacyUserDataOverride: null
    })

  it('prefers the ElectronDB profile and copies every profile file, conversations included', () => {
    const result = migrate()
    expect(result.status).toBe('migrated')
    for (const name of [
      'connections.json',
      'credentials.json',
      'jobs.json',
      'tour.json',
      'updates.json',
      'filter-profiles.json',
      'ai-providers.json',
      join('ai', 'c1.json')
    ])
      expect(existsSync(join(current, name))).toBe(true)
    // ElectronDB's own marker describes the copy into ElectronDB: never carried over
    expect(existsSync(join(current, 'migrated-from-navidog.json'))).toBe(false)
    expect(existsSync(join(current, 'migrated-from-electrondb.json'))).toBe(true)
    expect(readMigrationMarker(current)).toMatchObject({
      source: 'ElectronDB',
      from: electronDb,
      secrets: 'pending',
      movedNoticeShown: false
    })
    expect(contextFor(current).connections.get('old')).toBeFalsy()
    // a second start does nothing
    expect(migrate()).toEqual({ status: 'skipped', reason: 'already migrated' })
  })

  it('falls back to Navidog when the ElectronDB folder holds no data', () => {
    rmSync(electronDb, { recursive: true })
    mkdirSync(join(electronDb, 'Cache'), { recursive: true })
    const result = migrate()
    expect(result.status).toBe('migrated')
    expect(readMigrationMarker(current)).toMatchObject({ source: 'Navidog', from: navidog })
    expect(existsSync(join(current, 'migrated-from-navidog.json'))).toBe(true)
  })

  it('re-encrypts with the ElectronDB key and asks for the Navidog key only for what is left', async () => {
    migrate()
    const asked: string[] = []
    const ctx = contextFor(current)
    await runSecretMigration(ctx, {
      platform: 'darwin',
      exec: keychain(
        { 'ElectronDB Safe Storage': ED_PASSWORD, 'Navidog Safe Storage': ND_PASSWORD },
        asked
      )
    })
    expect(asked).toEqual(['ElectronDB Safe Storage', 'Navidog Safe Storage'])
    expect(ctx.credentials.get('mysql', 'c1')).toBe('dev-pass')
    expect(ctx.credentials.get('mysql', 'c2')).toBe('prod-pass')
    expect(ctx.credentials.get('ai', 'p1')).toBe('sk-test-key')
    expect(readMigrationMarker(current)).toMatchObject({ secrets: 'done', passwordsToReenter: [] })
  })

  it('never reads the Navidog key when the ElectronDB key decrypts everything', async () => {
    const ed = deriveMacOsCryptKey(ED_PASSWORD)
    writeJson(electronDb, 'credentials.json', {
      version: 1,
      codec: 'safeStorage',
      items: { 'mysql:c1': encryptMacOsCrypt('dev-pass', ed).toString('base64') }
    })
    migrate()
    const asked: string[] = []
    await runSecretMigration(contextFor(current), {
      platform: 'darwin',
      exec: keychain({ 'ElectronDB Safe Storage': ED_PASSWORD }, asked)
    })
    expect(asked).toEqual(['ElectronDB Safe Storage'])
  })

  it('a denied ElectronDB key stops the chain and is retried later', async () => {
    migrate()
    const asked: string[] = []
    const denied: KeychainExecFn = async (_file, args) => {
      asked.push(args[args.indexOf('-s') + 1])
      throw Object.assign(new Error('User canceled the operation.'), { code: 128 })
    }
    await runSecretMigration(contextFor(current), { platform: 'darwin', exec: denied })
    expect(asked).toEqual(['ElectronDB Safe Storage'])
    expect(readMigrationMarker(current)).toMatchObject({ secrets: 'pending', secretAttempts: 1 })
    const notice = startupNotices(current).find((n) => n.id === REENTER_PASSWORDS_NOTICE)
    expect(notice?.title).toBe('Contraseñas de ElectronDB pendientes')
  })

  it('Windows/Linux: values the current store cannot read are listed to type again', async () => {
    migrate()
    await runSecretMigration(contextFor(current), { platform: 'linux' })
    expect(readMigrationMarker(current)).toMatchObject({
      secrets: 'done',
      passwordsToReenter: expect.arrayContaining(['Dev', 'Producción'])
    })
  })

  it('shows the "moved" notice once', () => {
    migrate()
    const moved = startupNotices(current).filter((n) => n.id === PROFILE_MOVED_NOTICE)
    expect(moved).toHaveLength(1)
    expect(moved[0]).toMatchObject({ level: 'info', title: 'ElectronDB ahora se llama Vortaq' })
    expect(moved[0].message).toContain(electronDb)
    dismissStartupNotice(current, PROFILE_MOVED_NOTICE)
    expect(startupNotices(current).some((n) => n.id === PROFILE_MOVED_NOTICE)).toBe(false)
    expect(readMigrationMarker(current)).toMatchObject({ movedNoticeShown: true })
  })

  it('an ElectronDB-era marker (no source) never shows the "moved" notice', () => {
    writeJson(current, 'migrated-from-navidog.json', {
      version: 1,
      from: navidog,
      secrets: 'done'
    })
    expect(startupNotices(current)).toEqual([])
    expect(readMigrationMarker(current)).toMatchObject({ source: 'Navidog' })
  })
})
