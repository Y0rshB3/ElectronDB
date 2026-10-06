import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Scheduler } from './scheduler'
import { backupTask, jobInput, makeContext, silentLogger, type TestContext } from './testSupport'

const MINUTE = 60_000

describe('Scheduler', () => {
  let t: TestContext

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-02T10:00:30.000Z'))
    t = makeContext()
  })
  afterEach(() => {
    vi.useRealTimers()
    t.cleanup()
  })

  it('triggers enabled jobs on their cron and skips overlapping ticks', async () => {
    const job = t.ctx.jobs.save(
      jobInput('Every minute', [backupTask('t1', 'c1', 'shop')], {
        schedule: { enabled: true, cron: '* * * * *', launchAgent: false }
      })
    )
    t.ctx.jobs.save(
      jobInput('Disabled', [backupTask('t1', 'c1', 'shop')], {
        schedule: { enabled: false, cron: '* * * * *', launchAgent: false }
      })
    )
    const warnings: string[] = []
    let finish: (() => void) | null = null
    const executions: string[] = []
    const scheduler = new Scheduler(t.ctx, {
      log: { ...silentLogger, warn: (m) => warnings.push(m) },
      execute: (jobId) => {
        executions.push(jobId)
        return new Promise<void>((resolve) => {
          finish = resolve
        })
      }
    })
    scheduler.syncAll()
    expect(scheduler.isScheduled(job.id)).toBe(true)
    expect(scheduler.nextRun(job.id)).toBe('2026-03-02T10:01:00.000Z')
    expect(t.ctx.jobs.list().filter((j) => scheduler.isScheduled(j.id))).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(executions).toEqual([job.id])
    expect(scheduler.isRunning(job.id)).toBe(true)

    // second tick while the first run is still active: skipped with a log line
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(executions).toEqual([job.id])
    expect(warnings.some((w) => w.includes('skipping'))).toBe(true)

    finish!()
    await vi.advanceTimersByTimeAsync(0)
    expect(scheduler.isRunning(job.id)).toBe(false)

    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(executions).toEqual([job.id, job.id])
    scheduler.stop()
    expect(scheduler.isScheduled(job.id)).toBe(false)
  })

  it('syncJob removes timers of deleted or disabled jobs', () => {
    const job = t.ctx.jobs.save(
      jobInput('Hourly', [backupTask('t1', 'c1', 'shop')], {
        schedule: { enabled: true, cron: '0 * * * *', launchAgent: false }
      })
    )
    const scheduler = new Scheduler(t.ctx, { log: silentLogger, execute: async () => {} })
    scheduler.syncJob(job.id)
    expect(scheduler.nextRun(job.id)).toBe('2026-03-02T11:00:00.000Z')
    t.ctx.jobs.save({ ...job, schedule: { ...job.schedule, enabled: false } })
    scheduler.syncJob(job.id)
    expect(scheduler.nextRun(job.id)).toBeNull()
    t.ctx.jobs.save({ ...job, schedule: { ...job.schedule, enabled: true } })
    scheduler.syncJob(job.id)
    expect(scheduler.isScheduled(job.id)).toBe(true)
    t.ctx.jobs.delete(job.id)
    scheduler.syncAll()
    expect(scheduler.isScheduled(job.id)).toBe(false)
    scheduler.stop()
  })

  it('honours the owns predicate and ignores invalid cron', () => {
    const delegated = t.ctx.jobs.save(
      jobInput('Delegated', [], {
        schedule: { enabled: true, cron: '0 * * * *', launchAgent: true }
      })
    )
    const broken = t.ctx.jobs.save(
      jobInput('Broken', [], { schedule: { enabled: true, cron: 'nope', launchAgent: false } })
    )
    const scheduler = new Scheduler(t.ctx, {
      log: silentLogger,
      execute: async () => {},
      owns: (j) => !j.schedule.launchAgent
    })
    scheduler.syncAll()
    expect(scheduler.isScheduled(delegated.id)).toBe(false)
    expect(scheduler.isScheduled(broken.id)).toBe(false)
  })

  it('is inert when headless', () => {
    t.cleanup()
    t = makeContext({ headless: true })
    const job = t.ctx.jobs.save(
      jobInput('Hourly', [], { schedule: { enabled: true, cron: '0 * * * *', launchAgent: false } })
    )
    const scheduler = new Scheduler(t.ctx, { log: silentLogger, execute: async () => {} })
    scheduler.syncAll()
    scheduler.syncJob(job.id)
    expect(scheduler.isScheduled(job.id)).toBe(false)
  })
})
