import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { INTERRUPTED_MESSAGE } from '@shared/jobLog'
import type { JobRun } from '@shared/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAutomationService, getAutomationService, type AutomationService } from './index'
import { launchAgentStatus, type PlatformInfo } from './launchAgent'
import {
  backupTask,
  connectionInput,
  fakeBackupService,
  fakeSessionFactory,
  jobInput,
  makeContext,
  silentLogger,
  type FakeBackupService,
  type TestContext
} from './testSupport'

describe('automation service', () => {
  let t: TestContext
  let backups: FakeBackupService
  let service: AutomationService
  let platform: PlatformInfo
  let connectionId: string
  const launchctl: string[][] = []

  beforeEach(() => {
    t = makeContext()
    backups = fakeBackupService(t.dir)
    platform = {
      os: 'darwin',
      execPath: '/bin/electrondb',
      appArgs: [],
      uid: 501,
      homeDir: join(t.dir, 'home')
    }
    launchctl.length = 0
    service = createAutomationService(t.ctx, {
      deps: { backups, sessions: fakeSessionFactory() },
      platform,
      execFile: async (_file, args) => {
        launchctl.push(args)
        return { stdout: '', stderr: '' }
      },
      log: silentLogger
    })
    connectionId = t.ctx.connections.save(connectionInput('Local')).id
  })
  afterEach(async () => {
    await service.stop()
    t.cleanup()
  })

  it('run returns the initial snapshot and wait resolves the final run', async () => {
    const job = t.ctx.jobs.save(jobInput('Manual', [backupTask('t1', connectionId, 'shop')]))
    const initial = await service.run(job.id, 'manual')
    expect(initial.status).toBe('running')
    const final = await service.wait!(initial.id)
    expect(final.status).toBe('success')
    expect(final.id).toBe(initial.id)
    // finished runs are served from the repo afterwards
    expect((await service.wait!(initial.id)).status).toBe('success')
    await expect(service.wait!('missing')).rejects.toThrow(/no existe/)
  })

  it("a running rollback of a job's copies does not block the job, and is reported as an active restore", async () => {
    const local = t.ctx.connections.get(connectionId)!
    const job = t.ctx.jobs.save(jobInput('Backup', [backupTask('t1', connectionId, 'shop')]))
    // A rollback whose safety copy hangs: it stays active.
    backups.hangOn = 'shop'
    backups.files.set('/b/shop.nb3', 'shop')
    const sessions = fakeSessionFactory()
    sessions.schemas.set(local.id, new Set(['shop']))
    service = createAutomationService(t.ctx, {
      deps: { backups, sessions, backupCharset: async () => null },
      platform,
      log: silentLogger
    })
    const rollbackJob = {
      ...job,
      name: 'Rollback a Local · Backup',
      tasks: [
        {
          id: 'rollback-t1',
          type: 'restoreschema' as const,
          connectionId: local.id,
          schema: 'shop',
          referenceName: 'Base de datos shop: Local -> Local',
          restoreSource: {
            kind: 'file' as const,
            path: '/b/shop.nb3',
            schema: 'shop',
            connectionId: null
          },
          safetyBackup: true
        }
      ]
    }
    const rb = await service.runPrepared!(rollbackJob, 'manual', {
      kind: 'rollback',
      rollbackOf: 'x'
    })
    expect(service.activeRestores!()).toEqual([
      { runId: rb.id, jobName: 'Rollback a Local · Backup' }
    ])
    await expect(
      service.runPrepared!(rollbackJob, 'manual', { kind: 'rollback', rollbackOf: 'x' })
    ).rejects.toThrow(/Ya hay una restauración en curso/)
    // Wait until the rollback hangs in its safety copy, then run the backup job itself.
    for (let i = 0; i < 100 && backups.calls.length === 0; i++)
      await new Promise((r) => setTimeout(r, 5))
    expect(backups.calls).toHaveLength(1)
    backups.hangOn = null
    const own = await service.run(job.id, 'manual')
    expect((await service.wait!(own.id)).status).toBe('success')
    service.cancel(rb.id)
    expect((await service.wait!(rb.id)).status).toBe('cancelled')
    expect(service.activeRestores!()).toEqual([])
  })

  it('rejects a second concurrent run of the same job and supports cancel', async () => {
    backups.hangOn = 'shop'
    const job = t.ctx.jobs.save(jobInput('Long', [backupTask('t1', connectionId, 'shop')]))
    const initial = await service.run(job.id, 'manual')
    await expect(service.run(job.id, 'manual')).rejects.toThrow(/ya se está ejecutando/)
    service.cancel(initial.id)
    const final = await service.wait!(initial.id)
    expect(final.status).toBe('cancelled')
    // job is free again
    backups.hangOn = null
    const again = await service.run(job.id, 'manual')
    expect((await service.wait!(again.id)).status).toBe('success')
  })

  it('outside macOS the in-app scheduler owns launchAgent jobs and launchd is never touched', async () => {
    await service.stop()
    const linux: PlatformInfo = { ...platform, os: 'linux' }
    service = createAutomationService(t.ctx, {
      deps: { backups, sessions: fakeSessionFactory() },
      platform: linux,
      execFile: async (_file, args) => {
        launchctl.push(args)
        return { stdout: '', stderr: '' }
      },
      log: silentLogger
    })
    const job = t.ctx.jobs.save(
      jobInput('Copied from a Mac', [backupTask('t1', connectionId, 'shop')], {
        schedule: { enabled: true, cron: '0 4 * * *', launchAgent: true }
      })
    )
    await service.start()
    expect(service.scheduleStatus!(job.id)).toMatchObject({ inApp: true, launchAgent: false })
    expect(new Date(service.scheduleStatus!(job.id).nextRun!).getHours()).toBe(4)
    await service.resync!(job.id)
    expect(launchctl).toHaveLength(0)
    expect(existsSync(join(linux.homeDir, 'Library'))).toBe(false)
  })

  it('start/resync keep launch agents and in-app timers coherent', async () => {
    const inApp = t.ctx.jobs.save(
      jobInput('In app', [backupTask('t1', connectionId, 'shop')], {
        schedule: { enabled: true, cron: '0 3 * * *', launchAgent: false }
      })
    )
    const delegated = t.ctx.jobs.save(
      jobInput('Delegated', [backupTask('t1', connectionId, 'shop')], {
        schedule: { enabled: true, cron: '0 4 * * *', launchAgent: true }
      })
    )
    await service.start()
    expect(service.scheduleStatus!(inApp.id)).toMatchObject({ inApp: true, launchAgent: false })
    expect(new Date(service.scheduleStatus!(inApp.id).nextRun!).getHours()).toBe(3)
    // delegated job: launchd owns it, the in-app scheduler stays out
    expect(service.scheduleStatus!(delegated.id)).toMatchObject({ inApp: false, launchAgent: true })
    expect(new Date(service.scheduleStatus!(delegated.id).nextRun!).getHours()).toBe(4)
    expect(launchAgentStatus(delegated.id, platform.homeDir, platform.os)).toBe(true)
    expect(launchctl.map((a) => a[0])).toEqual(['bootout', 'bootstrap'])

    // turning launchAgent off moves the job back in-app and removes the plist
    t.ctx.jobs.save({ ...delegated, schedule: { ...delegated.schedule, launchAgent: false } })
    await service.resync!(delegated.id)
    expect(service.scheduleStatus!(delegated.id)).toMatchObject({ inApp: true, launchAgent: false })
    expect(launchAgentStatus(delegated.id, platform.homeDir, platform.os)).toBe(false)

    // deleting a job clears everything
    t.ctx.jobs.delete(inApp.id)
    await service.resync!(inApp.id)
    expect(service.scheduleStatus!(inApp.id)).toEqual({
      inApp: false,
      launchAgent: false,
      nextRun: null
    })
  })

  it('closes runs left "running" by a dead process at start and on cancel', async () => {
    const job = t.ctx.jobs.save(
      jobInput('Nocturno', [
        backupTask('t1', connectionId, 'accounts'),
        backupTask('t2', connectionId, 'crm'),
        backupTask('t3', connectionId, 'erp')
      ])
    )
    const logPath = join(t.dir, 'logs', 'jobs', 'stale.log')
    mkdirSync(dirname(logPath), { recursive: true })
    writeFileSync(logPath, '[10:00:00] Paso 2/3 · Base de datos crm (Local)\n')
    const task = (id: string, status: JobRun['status']): JobRun['tasks'][number] => ({
      taskId: id,
      referenceName: id,
      status,
      startedAt: null,
      finishedAt: null,
      message: null,
      outputPath: null
    })
    const stale = (id: string, pid: number | undefined): JobRun => ({
      id,
      jobId: job.id,
      jobName: job.name,
      status: 'running',
      trigger: 'manual',
      startedAt: '2026-10-05T10:00:00.000Z',
      finishedAt: null,
      tasks: [task('t1', 'success'), task('t2', 'running'), task('t3', 'queued')],
      logPath: id === 'stale' ? logPath : join(t.dir, 'logs', 'jobs', `${id}.log`),
      pid
    })
    t.ctx.runs.upsert(stale('stale', 999_999_999)) // crashed process
    t.ctx.runs.upsert(stale('legacy', undefined)) // written before runs recorded their pid
    t.ctx.runs.upsert(stale('launchd', process.ppid)) // another live ElectronDB process

    await service.start()

    const closed = t.ctx.runs.get('stale')!
    expect(closed.status).toBe('failed')
    expect(closed.finishedAt).not.toBeNull()
    expect(closed.tasks.map((x) => x.status)).toEqual(['success', 'failed', 'cancelled'])
    expect(closed.tasks[1].message).toBe(INTERRUPTED_MESSAGE)
    const text = readFileSync(logPath, 'utf8')
    expect(text).toContain(`Resultado: ERROR · ${INTERRUPTED_MESSAGE}`)
    expect(text).toContain('Pasos: 3 · Correctos: 1 · Con error: 1 · Cancelados: 1')
    expect(text.trimEnd().endsWith('Ejecución interrumpida: 1 de 3 pasos completados.')).toBe(true)
    expect(t.ctx.runs.get('legacy')!.status).toBe('failed')
    expect(
      t.events.filter((e) => e.channel === 'event:jobRun').map((e) => (e.payload as JobRun).id)
    ).toEqual(expect.arrayContaining(['stale', 'legacy']))
    // A run of another live process is not touched and cannot be cancelled from here.
    expect(t.ctx.runs.get('launchd')!.status).toBe('running')
    expect(() => service.cancel('launchd')).toThrow(/otro proceso/)

    // Cancel on a stale run (Cancelar in the history) closes it instead of doing nothing.
    t.ctx.runs.upsert(stale('later', 999_999_999))
    service.cancel('later')
    expect(t.ctx.runs.get('later')!.status).toBe('failed')

    // The job runs again normally; its runs now record the owning process.
    const initial = await service.run(job.id, 'manual')
    expect(initial.pid).toBe(process.pid)
    expect((await service.wait!(initial.id)).status).toBe('success')
  })

  it('getAutomationService returns one instance per context', () => {
    const other = makeContext()
    try {
      const a = getAutomationService(t.ctx, {
        deps: { backups, sessions: fakeSessionFactory() },
        platform,
        log: silentLogger
      })
      expect(getAutomationService(t.ctx)).toBe(a)
      expect(getAutomationService(other.ctx, { platform, log: silentLogger })).not.toBe(a)
    } finally {
      other.cleanup()
    }
  })
})
