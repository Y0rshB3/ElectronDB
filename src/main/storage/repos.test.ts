import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ConnectionsRepo,
  DEFAULT_SETTINGS,
  ENGINE_CHANGE_MESSAGE,
  defaultNavicatRootPath,
  JobsRepo,
  RunsRepo,
  SettingsRepo
} from './repos'
import { JsonStore } from './jsonStore'
import type { ConnectionInput } from '@shared/types'

const connInput = (name: string): ConnectionInput => ({
  name,
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
  backupDir: '/tmp/x',
  extraBackupDirs: []
})

describe('repos', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'electrondb-repos-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('persists connections atomically and reloads them', () => {
    const repo = new ConnectionsRepo(dir)
    const saved = repo.save(connInput('Local'))
    expect(saved.id).toBeTruthy()
    const again = new ConnectionsRepo(dir)
    expect(again.list().map((c) => c.name)).toEqual(['Local'])
    again.save({ ...saved, name: 'Local 2' })
    expect(again.get(saved.id)?.name).toBe('Local 2')
    expect(again.get(saved.id)?.createdAt).toBe(saved.createdAt)
    again.delete(saved.id)
    expect(again.list()).toHaveLength(0)
  })

  it('recovers from a corrupt file by moving it aside', () => {
    const path = join(dir, 'broken.json')
    new JsonStore(path, () => ({ a: 1 })).save()
    writeFileSync(path, '{ not json')
    const store = new JsonStore(path, () => ({ a: 1 }))
    expect(store.get()).toEqual({ a: 1 })
  })

  it('caps job runs at 500 newest', () => {
    const runs = new RunsRepo(dir)
    for (let i = 0; i < 520; i++) {
      runs.upsert({
        id: `r${i}`,
        jobId: 'j',
        jobName: 'J',
        status: 'success',
        trigger: 'manual',
        startedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        finishedAt: null,
        tasks: [],
        logPath: ''
      })
    }
    const all = runs.list('j', 1000)
    expect(all).toHaveLength(500)
    expect(all[0].id).toBe('r519')
  })

  it('stores settings with defaults and jobs with lastRunAt', () => {
    const settings = new SettingsRepo(dir, '/Users/test', 'darwin')
    expect(settings.get().navicatRootPath).toBe(
      join('/Users/test', 'Library', 'Application Support', 'PremiumSoft CyberTech', 'Navicat CC')
    )
    settings.update({ defaultRowLimit: 5 })
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).defaultRowLimit).toBe(5)

    const jobs = new JobsRepo(dir)
    const job = jobs.save({
      name: 'Backup Local',
      continueOnError: true,
      tasks: [],
      schedule: { enabled: false, cron: '0 3 * * *', launchAgent: false }
    })
    jobs.touchLastRun(job.id, '2026-09-14T00:00:00.000Z')
    expect(jobs.get(job.id)?.lastRunAt).toBe('2026-09-14T00:00:00.000Z')
  })

  it('confirms destructive operations everywhere by default, also for older profiles', () => {
    expect(DEFAULT_SETTINGS('/data', '/home/test', 'linux').confirmDestructiveEverywhere).toBe(true)
    expect(
      new SettingsRepo(join(dir, 'fresh'), '/home/test').get().confirmDestructiveEverywhere
    ).toBe(true)
    // settings.json written before the option existed: missing means on
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ defaultRowLimit: 50, theme: 'light', confirmProductionWrites: false })
    )
    const old = new SettingsRepo(dir, '/home/test')
    expect(old.get().confirmDestructiveEverywhere).toBe(true)
    // production can no longer be turned off: the old false maps to ['production']
    expect(old.get().typedConfirmEnvironments).toEqual(['production'])
    expect('confirmProductionWrites' in old.get()).toBe(false)
    expect(old.get().defaultRowLimit).toBe(50)
    // an invalid value is not taken as "off"
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ confirmDestructiveEverywhere: 'no' })
    )
    expect(new SettingsRepo(dir, '/home/test').get().confirmDestructiveEverywhere).toBe(true)
    // an explicit false sticks across restarts
    new SettingsRepo(dir, '/home/test').update({ confirmDestructiveEverywhere: false })
    expect(new SettingsRepo(dir, '/home/test').get().confirmDestructiveEverywhere).toBe(false)
  })

  describe('typed-name confirmation environments', () => {
    const write = (value: object) =>
      writeFileSync(join(dir, 'settings.json'), JSON.stringify(value))
    const read = () => new SettingsRepo(dir, '/home/test').get().typedConfirmEnvironments
    const stored = () => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))

    it('defaults to production only (new profile and DEFAULT_SETTINGS)', () => {
      expect(DEFAULT_SETTINGS('/data', '/home/test', 'linux').typedConfirmEnvironments).toEqual([
        'production'
      ])
      expect(
        new SettingsRepo(join(dir, 'fresh'), '/home/test').get().typedConfirmEnvironments
      ).toEqual(['production'])
    })

    it('migrates the old boolean: true, false and missing all give production', () => {
      write({ confirmProductionWrites: true })
      expect(read()).toEqual(['production'])
      write({ confirmProductionWrites: false })
      expect(read()).toEqual(['production'])
      write({ theme: 'light' })
      expect(read()).toEqual(['production'])
    })

    it('keeps a new list, adds production back and drops unknown values', () => {
      write({ typedConfirmEnvironments: ['staging', 'production'] })
      expect(read()).toEqual(['production', 'staging'])
      // hand-edited file without production
      write({ typedConfirmEnvironments: ['other', 'local', 'local', 'bogus', 3] })
      expect(read()).toEqual(['production', 'local', 'other'])
      write({ typedConfirmEnvironments: 'staging' })
      expect(read()).toEqual(['production'])
      // the new key wins over the old one
      write({ confirmProductionWrites: false, typedConfirmEnvironments: ['production', 'staging'] })
      expect(read()).toEqual(['production', 'staging'])
    })

    it('settings:update stores the normalised list, never without production, and drops the old key', () => {
      write({ confirmProductionWrites: false })
      const repo = new SettingsRepo(dir, '/home/test')
      expect(
        repo.update({ typedConfirmEnvironments: ['staging'] as never }).typedConfirmEnvironments
      ).toEqual(['production', 'staging'])
      expect(stored().typedConfirmEnvironments).toEqual(['production', 'staging'])
      expect('confirmProductionWrites' in stored()).toBe(false)
      expect(repo.update({ typedConfirmEnvironments: [] }).typedConfirmEnvironments).toEqual([
        'production'
      ])
      // an old renderer sending the boolean cannot turn production off either
      repo.update({ confirmProductionWrites: false } as never)
      expect(stored().typedConfirmEnvironments).toEqual(['production'])
      expect('confirmProductionWrites' in stored()).toBe(false)
      expect(read()).toEqual(['production'])
    })
  })

  it('defaults the Navicat folder to the macOS path only on macOS', () => {
    expect(defaultNavicatRootPath('/Users/test', 'darwin')).toContain('Navicat CC')
    for (const os of ['win32', 'linux'] as const) {
      expect(defaultNavicatRootPath('/home/test', os)).toBe('')
      expect(DEFAULT_SETTINGS('/data', '/home/test', os).navicatRootPath).toBe('')
      const osDir = join(dir, os)
      expect(new SettingsRepo(osDir, '/home/test', os).get().navicatRootPath).toBe('')
    }
  })

  it('ignores the macOS default saved by older builds on Windows/Linux but keeps real paths', () => {
    const home = '/home/test'
    const stale = join(
      home,
      'Library',
      'Application Support',
      'PremiumSoft CyberTech',
      'Navicat CC'
    )
    const settings = new SettingsRepo(dir, home, 'linux')
    settings.update({ navicatRootPath: stale })
    expect(settings.get().navicatRootPath).toBe('')
    settings.update({ navicatRootPath: '/home/test/navicat-cc' })
    expect(new SettingsRepo(dir, home, 'linux').get().navicatRootPath).toBe('/home/test/navicat-cc')
    // on macOS the same path is the real default
    expect(new SettingsRepo(join(dir, 'mac'), home, 'darwin').get().navicatRootPath).toBe(stale)
  })
})

describe('ConnectionsRepo engine model', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'electrondb-repos-engine-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const file = (): string => join(dir, 'connections.json')
  const writeLegacy = (): void => {
    const legacy = {
      ...connInput('Legacy'),
      id: 'legacy-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
    writeFileSync(file(), JSON.stringify({ version: 1, items: [legacy] }, null, 2))
  }

  it('reads records without engine as MySQL and never rewrites the file for it', () => {
    writeLegacy()
    const before = readFileSync(file(), 'utf8')
    const repo = new ConnectionsRepo(dir)
    expect(repo.list()[0]).toMatchObject({ id: 'legacy-1', engine: 'mysql' })
    expect(repo.get('legacy-1')?.engine).toBe('mysql')
    expect(repo.findByName('Legacy')?.engine).toBe('mysql')
    // only engine is added: no engine blocks for MySQL
    const { engine: _engine, ...rest } = repo.get('legacy-1')!
    expect(rest).toEqual(JSON.parse(before).items[0])
    expect(readFileSync(file(), 'utf8')).toBe(before)

    // saving another record does not stamp the untouched legacy one
    repo.save(connInput('Other'))
    const items = JSON.parse(readFileSync(file(), 'utf8')).items
    expect(items.find((c: { id: string }) => c.id === 'legacy-1')).not.toHaveProperty('engine')
    expect(items.find((c: { name: string }) => c.name === 'Other').engine).toBe('mysql')
  })

  it('saves new records as MySQL unless an engine is given', () => {
    const repo = new ConnectionsRepo(dir)
    expect(repo.save(connInput('A')).engine).toBe('mysql')
    const pg = repo.save({ ...connInput('B'), engine: 'postgresql' })
    expect(pg.engine).toBe('postgresql')
    expect(pg.postgres).toEqual({
      initialDatabase: 'postgres',
      showSystemSchemas: false,
      timeZone: ''
    })
    expect(new ConnectionsRepo(dir).get(pg.id)?.engine).toBe('postgresql')
  })

  it('keeps the stored engine when the input has none and refuses a different one', () => {
    writeLegacy()
    const repo = new ConnectionsRepo(dir)
    const pg = repo.save({ ...connInput('PG'), engine: 'postgresql' })

    const { engine: _e, ...withoutEngine } = repo.get(pg.id)!
    expect(repo.save({ ...withoutEngine, name: 'PG 2' })).toMatchObject({
      engine: 'postgresql',
      name: 'PG 2'
    })
    expect(() => repo.save({ ...connInput('PG'), id: pg.id, engine: 'mysql' })).toThrow(
      ENGINE_CHANGE_MESSAGE
    )
    expect(ENGINE_CHANGE_MESSAGE).toBe(
      'No se puede cambiar el motor de una conexión existente; crea una conexión nueva.'
    )
    expect(repo.get(pg.id)?.name).toBe('PG 2')

    // a legacy record (no stored engine) is MySQL: saving it as MySQL works, as SQLite does not
    expect(repo.save({ ...connInput('Legacy'), id: 'legacy-1', engine: 'mysql' }).engine).toBe(
      'mysql'
    )
    expect(() => repo.save({ ...connInput('Legacy'), id: 'legacy-1', engine: 'sqlite' })).toThrow(
      ENGINE_CHANGE_MESSAGE
    )
  })

  it('refuses unknown engines', () => {
    const repo = new ConnectionsRepo(dir)
    expect(() => repo.save({ ...connInput('X'), engine: 'oracle' as never })).toThrow(
      'Motor de base de datos desconocido: "oracle".'
    )
    expect(repo.list()).toEqual([])
  })
})

describe('SettingsRepo previewEngines', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'electrondb-repos-settings-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is off by default, also for settings files written before it existed', () => {
    expect(DEFAULT_SETTINGS('/data', '/home/test', 'darwin').previewEngines).toBe(false)
    expect(new SettingsRepo(dir, '/home/test', 'darwin').get().previewEngines).toBe(false)
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ defaultRowLimit: 50, theme: 'light', confirmProductionWrites: true })
    )
    const settings = new SettingsRepo(dir, '/home/test', 'darwin')
    expect(settings.get()).toMatchObject({ defaultRowLimit: 50, previewEngines: false })
    expect(settings.update({ previewEngines: true }).previewEngines).toBe(true)
    expect(new SettingsRepo(dir, '/home/test', 'darwin').get().previewEngines).toBe(true)
  })
})
