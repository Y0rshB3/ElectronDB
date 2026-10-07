import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { envVar } from '@main/env'
import {
  legacySafeStorageServices,
  readGenericPassword,
  readLegacySafeStoragePassword
} from '@main/migration/legacyKeychain'
import { runProfileMigration, runSecretMigration } from '@main/migration'
import { deriveMacOsCryptKey, encryptMacOsCrypt } from '@main/migration/osCrypt'
import { ConnectionsRepo } from '@main/storage/repos'

/**
 * Reads the safeStorage keys of the earlier product names (ElectronDB,
 * Navidog) with the real `security` tool, from a THROWAWAY keychain file
 * (never the login keychain). Opt-in, macOS only:
 *   VORTAQ_TEST_KEYCHAIN_DIR=<scratch dir> npm run test:integration
 * The keychain is created with `security create-keychain` under that folder
 * and deleted (also from the search list) at the end.
 */
const baseDir = envVar('TEST_KEYCHAIN_DIR')?.trim()
const enabled = process.platform === 'darwin' && !!baseDir

const KEYCHAIN_PASSWORD = 'vortaq-throwaway'
const OLD_SAFE_STORAGE_PASSWORD = 'bGVnYWN5LXNhZmUtc3RvcmFnZQ=='
const ELECTRONDB_SAFE_STORAGE_PASSWORD = 'ZWxlY3Ryb25kYi1zYWZlLXN0b3JhZ2U='

const security = (...args: string[]): string =>
  execFileSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

describe.skipIf(!enabled)('legacy safeStorage key from a throwaway keychain', () => {
  let work: string
  let keychain: string
  let searchListBefore: string

  beforeAll(() => {
    mkdirSync(resolve(baseDir!), { recursive: true })
    work = mkdtempSync(join(resolve(baseDir!), 'vortaq-keychain-it-'))
    keychain = join(work, 'legacy.keychain-db')
    searchListBefore = security('list-keychains', '-d', 'user')
    security('create-keychain', '-p', KEYCHAIN_PASSWORD, keychain)
    security('unlock-keychain', '-p', KEYCHAIN_PASSWORD, keychain)
    // -A: any app may read it without the "allow access" prompt (test only).
    security(
      'add-generic-password',
      '-a',
      'Navidog',
      '-s',
      'Navidog Safe Storage',
      '-w',
      OLD_SAFE_STORAGE_PASSWORD,
      '-A',
      keychain
    )
    security(
      'add-generic-password',
      '-a',
      'ElectronDB',
      '-s',
      'ElectronDB Safe Storage',
      '-w',
      ELECTRONDB_SAFE_STORAGE_PASSWORD,
      '-A',
      keychain
    )
  })

  afterAll(() => {
    try {
      if (keychain && existsSync(keychain)) security('delete-keychain', keychain)
    } finally {
      if (work) rmSync(work, { recursive: true, force: true })
    }
    expect(security('list-keychains', '-d', 'user')).toBe(searchListBefore)
  })

  it('reads the "Navidog Safe Storage" password from the given keychain file', async () => {
    expect(await readLegacySafeStoragePassword({ keychain })).toEqual({
      ok: true,
      password: OLD_SAFE_STORAGE_PASSWORD
    })
  })

  it('reads the "ElectronDB Safe Storage" password from the given keychain file', async () => {
    expect(
      await readLegacySafeStoragePassword({
        keychain,
        services: legacySafeStorageServices({ name: 'ElectronDB' })
      })
    ).toEqual({ ok: true, password: ELECTRONDB_SAFE_STORAGE_PASSWORD })
  })

  it('reports a missing item as not-found', async () => {
    expect(await readGenericPassword('Vortaq Missing Item', { keychain })).toMatchObject({
      ok: false,
      reason: 'not-found'
    })
  })

  it('migrates a copied Navidog profile end to end with the real security tool', async () => {
    const appData = join(work, 'Application Support')
    const legacy = join(appData, 'Navidog')
    const current = join(appData, 'Vortaq')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(
      join(legacy, 'connections.json'),
      JSON.stringify({ version: 1, items: [{ id: 'c1', name: 'Dev' }] })
    )
    const key = deriveMacOsCryptKey(OLD_SAFE_STORAGE_PASSWORD)
    writeFileSync(
      join(legacy, 'credentials.json'),
      JSON.stringify({
        version: 1,
        codec: 'safeStorage',
        items: {
          'mysql:c1': encryptMacOsCrypt('dev-pass', key).toString('base64'),
          'ssh:c1': encryptMacOsCrypt('ssh-pass', key).toString('base64')
        }
      })
    )
    expect(
      runProfileMigration({
        appData,
        userData: current,
        userDataOverride: null,
        legacyUserDataOverride: null
      }).status
    ).toBe('migrated')
    const credentials = new CredentialStore(current, plainCodec, 'plain')
    await runSecretMigration(
      { userDataPath: current, credentials, connections: new ConnectionsRepo(current) },
      { keychain }
    )
    expect(credentials.get('mysql', 'c1')).toBe('dev-pass')
    expect(credentials.get('ssh', 'c1')).toBe('ssh-pass')
  })
})

describe.skipIf(!enabled)('ElectronDB profile with the real security tool', () => {
  let work: string
  let keychain: string

  beforeAll(() => {
    work = mkdtempSync(join(resolve(baseDir!), 'vortaq-keychain-ed-it-'))
    keychain = join(work, 'legacy.keychain-db')
    security('create-keychain', '-p', KEYCHAIN_PASSWORD, keychain)
    security('unlock-keychain', '-p', KEYCHAIN_PASSWORD, keychain)
    security(
      'add-generic-password',
      '-a',
      'ElectronDB',
      '-s',
      'ElectronDB Safe Storage',
      '-w',
      ELECTRONDB_SAFE_STORAGE_PASSWORD,
      '-A',
      keychain
    )
  })

  afterAll(() => {
    try {
      if (keychain && existsSync(keychain)) security('delete-keychain', keychain)
    } finally {
      if (work) rmSync(work, { recursive: true, force: true })
    }
  })

  it('re-encrypts passwords and AI keys copied from ElectronDB', async () => {
    const appData = join(work, 'Application Support')
    const legacy = join(appData, 'ElectronDB')
    const current = join(appData, 'Vortaq')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(
      join(legacy, 'connections.json'),
      JSON.stringify({ version: 1, items: [{ id: 'c1', name: 'Dev' }] })
    )
    const key = deriveMacOsCryptKey(ELECTRONDB_SAFE_STORAGE_PASSWORD)
    writeFileSync(
      join(legacy, 'credentials.json'),
      JSON.stringify({
        version: 1,
        codec: 'safeStorage',
        items: {
          'mysql:c1': encryptMacOsCrypt('dev-pass', key).toString('base64'),
          'ai:p1': encryptMacOsCrypt('sk-ai-key', key).toString('base64')
        }
      })
    )
    expect(
      runProfileMigration({
        appData,
        userData: current,
        userDataOverride: null,
        legacyUserDataOverride: null
      }).status
    ).toBe('migrated')
    const credentials = new CredentialStore(current, plainCodec, 'plain')
    await runSecretMigration(
      { userDataPath: current, credentials, connections: new ConnectionsRepo(current) },
      { keychain }
    )
    expect(credentials.get('mysql', 'c1')).toBe('dev-pass')
    expect(credentials.get('ai', 'p1')).toBe('sk-ai-key')
  })
})
