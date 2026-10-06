import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ConnectionsRepo,
  DEFAULT_SETTINGS,
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
