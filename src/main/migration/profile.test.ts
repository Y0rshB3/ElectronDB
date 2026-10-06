import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  findLegacyProfile,
  migrateLegacyProfile,
  MIGRATION_MARKER,
  readMigrationMarker,
  rewriteProfilePaths
} from './profile'

const silent = { info: () => {}, warn: () => {} }

describe('profile migration', () => {
  let root: string
  let from: string
  let to: string

  const write = (dir: string, name: string, data: unknown): void => {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), typeof data === 'string' ? data : JSON.stringify(data))
  }
  const read = (dir: string, name: string): unknown =>
    JSON.parse(readFileSync(join(dir, name), 'utf8'))

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'electrondb-migration-'))
    from = join(root, 'Navidog')
    to = join(root, 'ElectronDB')
    write(from, 'connections.json', {
      version: 1,
      items: [
        {
          id: 'c1',
          name: 'Dev',
          backupDir: join(from, 'backups', 'Dev'),
          ssl: { ca: join(from, 'certs', 'ca.pem') }
        }
      ]
    })
    write(from, 'settings.json', { backupsRootDir: join(from, 'backups'), theme: 'light' })
    write(from, 'jobs.json', { version: 1, items: [] })
    write(from, 'credentials.json', {
      version: 1,
      codec: 'safeStorage',
      items: { 'mysql:c1': 'djEw' }
    })
    write(from, 'backup-index.json', { version: 1, entries: {} })
    write(from, 'logs/navidog.log', 'old log\n')
    write(from, 'backups/Dev/20260101-nightly.nb3', 'nb3')
    write(from, 'Local Storage/leveldb/000003.log', 'ls')
    write(from, 'Local State', '{}')
    write(from, 'Cache/data_0', 'cache')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('copies JSON files, logs and Local Storage, leaves backups in place and a marker', () => {
    const result = migrateLegacyProfile({
      from,
      to,
      platform: 'darwin',
      now: () => new Date('2026-10-05T10:00:00Z'),
      log: silent
    })
    expect(result.status).toBe('migrated')
    for (const name of [
      'connections.json',
      'settings.json',
      'jobs.json',
      'credentials.json',
      'logs/navidog.log',
      'Local Storage/leveldb/000003.log'
    ])
      expect(existsSync(join(to, name)), name).toBe(true)
    // backups can be many GB: they are used where they are, never copied
    expect(existsSync(join(to, 'backups'))).toBe(false)
    // caches and Chromium internals stay behind; Local State only matters on Windows
    expect(existsSync(join(to, 'backup-index.json'))).toBe(false)
    expect(existsSync(join(to, 'Cache'))).toBe(false)
    expect(existsSync(join(to, 'Local State'))).toBe(false)
    // the legacy profile is untouched
    expect(existsSync(join(from, 'connections.json'))).toBe(true)

    const marker = readMigrationMarker(to)
    expect(marker).toMatchObject({
      version: 1,
      from,
      migratedAt: '2026-10-05T10:00:00.000Z',
      secrets: 'pending',
      rewrittenPaths: 1,
      backupsDir: join(from, 'backups')
    })
    expect(marker?.copied).toContain('credentials.json')
    expect(marker?.copied).not.toContain('backups/')
    expect(marker?.failed).toBeUndefined()
  })

  it('rewrites paths into the old profile except backups, and keeps credentials byte for byte', () => {
    migrateLegacyProfile({ from, to, platform: 'linux', log: silent })
    expect(read(to, 'settings.json')).toEqual({
      backupsRootDir: join(from, 'backups'),
      theme: 'light'
    })
    expect(read(to, 'connections.json')).toMatchObject({
      items: [{ backupDir: join(from, 'backups', 'Dev'), ssl: { ca: join(to, 'certs', 'ca.pem') } }]
    })
    expect(readFileSync(join(to, 'credentials.json'), 'utf8')).toBe(
      readFileSync(join(from, 'credentials.json'), 'utf8')
    )
  })

  it('pins the legacy backup folder when settings relied on the default', () => {
    write(from, 'settings.json', { theme: 'light' })
    migrateLegacyProfile({ from, to, platform: 'darwin', log: silent })
    expect(read(to, 'settings.json')).toEqual({
      theme: 'light',
      backupsRootDir: join(from, 'backups')
    })
  })

  it('writes a settings.json for the legacy backups when there was none', () => {
    rmSync(join(from, 'settings.json'))
    migrateLegacyProfile({ from, to, platform: 'darwin', log: silent })
    expect(read(to, 'settings.json')).toEqual({ backupsRootDir: join(from, 'backups') })
  })

  it('leaves settings alone when the legacy profile had no backups', () => {
    rmSync(join(from, 'backups'), { recursive: true })
    write(from, 'settings.json', { theme: 'light' })
    const result = migrateLegacyProfile({ from, to, platform: 'darwin', log: silent })
    expect(read(to, 'settings.json')).toEqual({ theme: 'light' })
    expect(result.status === 'migrated' && result.marker.backupsDir).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'records entries it could not copy and goes on with the rest',
    () => {
      const locked = join(from, 'logs', 'locked.log')
      write(from, 'logs/locked.log', 'x')
      chmodSync(locked, 0o000)
      try {
        const result = migrateLegacyProfile({ from, to, platform: 'darwin', log: silent })
        expect(result.status === 'migrated' && result.marker.failed).toEqual(['logs'])
        expect(existsSync(join(to, 'connections.json'))).toBe(true)
      } finally {
        chmodSync(locked, 0o600)
      }
    }
  )

  it('copies Local State on Windows (DPAPI-protected safeStorage key)', () => {
    migrateLegacyProfile({ from, to, platform: 'win32', log: silent })
    expect(existsSync(join(to, 'Local State'))).toBe(true)
  })

  it('never overwrites data already in the new profile', () => {
    write(to, 'settings.json', { theme: 'dark' })
    write(to, 'logs/navidog.log', 'new log\n')
    const result = migrateLegacyProfile({ from, to, platform: 'darwin', log: silent })
    expect(result.status).toBe('migrated')
    expect(read(to, 'settings.json')).toEqual({ theme: 'dark' })
    expect(readFileSync(join(to, 'logs/navidog.log'), 'utf8')).toBe('new log\n')
    if (result.status === 'migrated')
      expect(result.marker.skippedExisting).toEqual(['settings.json'])
  })

  it('skips when the new profile already has connections, a marker, or no legacy data', () => {
    write(to, 'connections.json', { version: 1, items: [] })
    expect(migrateLegacyProfile({ from, to, log: silent })).toMatchObject({ status: 'skipped' })
    rmSync(join(to, 'connections.json'))

    write(to, MIGRATION_MARKER, { version: 1 })
    expect(migrateLegacyProfile({ from, to, log: silent })).toEqual({
      status: 'skipped',
      reason: 'already migrated'
    })
    expect(existsSync(join(to, 'jobs.json'))).toBe(false)

    expect(migrateLegacyProfile({ from: join(root, 'missing'), to, log: silent })).toEqual({
      status: 'skipped',
      reason: 'no legacy profile'
    })
    expect(migrateLegacyProfile({ from, to: from, log: silent })).toMatchObject({
      status: 'skipped'
    })
  })

  it('marks secrets as none when there was no credentials.json', () => {
    rmSync(join(from, 'credentials.json'))
    const result = migrateLegacyProfile({ from, to, log: silent })
    expect(result.status === 'migrated' && result.marker.secrets).toBe('none')
  })

  it('finds the legacy folder under appData', () => {
    expect(findLegacyProfile(root)).toBe(from)
    expect(findLegacyProfile(join(root, 'nowhere'))).toBeNull()
  })
})

describe('rewriteProfilePaths', () => {
  it('folds case on macOS/Windows (Electron used package.json "navidog")', () => {
    const out = rewriteProfilePaths(
      { a: '/AppData/navidog/backups/x', b: ['/AppData/navidog'], c: '/AppData/navidogs/x', n: 3 },
      '/AppData/Navidog',
      '/AppData/ElectronDB',
      'darwin'
    )
    expect(out.value).toEqual({
      a: '/AppData/ElectronDB/backups/x',
      b: ['/AppData/ElectronDB'],
      c: '/AppData/navidogs/x',
      n: 3
    })
    expect(out.count).toBe(2)
  })

  it('leaves paths under a kept folder untouched', () => {
    const out = rewriteProfilePaths(
      { a: '/cfg/Navidog/backups/x', b: '/cfg/Navidog/backups', c: '/cfg/Navidog/certs/ca.pem' },
      '/cfg/Navidog',
      '/cfg/ElectronDB',
      'linux',
      ['/cfg/Navidog/backups']
    )
    expect(out).toEqual({
      value: {
        a: '/cfg/Navidog/backups/x',
        b: '/cfg/Navidog/backups',
        c: '/cfg/ElectronDB/certs/ca.pem'
      },
      count: 1
    })
  })

  it('is case-sensitive on Linux', () => {
    const out = rewriteProfilePaths(
      '/cfg/navidog/backups',
      '/cfg/Navidog',
      '/cfg/ElectronDB',
      'linux'
    )
    expect(out).toEqual({ value: '/cfg/navidog/backups', count: 0 })
  })
})
