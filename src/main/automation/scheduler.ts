import { Cron } from 'croner'
import type { Job } from '@shared/types'
import type { AppContext } from '../context'
import { getLogger, type Logger } from '../log'

export interface SchedulerOptions {
  /** Executes one job (schedule trigger) and resolves when it finished. */
  execute: (jobId: string) => Promise<unknown>
  /**
   * Whether the in-app scheduler owns this job. Defaults to every enabled
   * job; the service excludes jobs already handled by a launchd agent.
   */
  owns?: (job: Job) => boolean
  log?: Logger
}

/**
 * In-app cron scheduler: one croner timer per enabled job. Overlapping
 * ticks of the same job are skipped. Inert when the app runs headless.
 */
export class Scheduler {
  private readonly timers = new Map<string, Cron>()
  private readonly active = new Set<string>()
  private readonly log: Logger
  private readonly owns: (job: Job) => boolean

  constructor(
    private readonly ctx: AppContext,
    private readonly options: SchedulerOptions
  ) {
    this.log = options.log ?? getLogger('scheduler')
    this.owns = options.owns ?? (() => true)
  }

  /** Rebuilds timers for every job, dropping the ones that disappeared. */
  syncAll(): void {
    if (this.ctx.headless) return
    const jobs = this.ctx.jobs.list()
    const ids = new Set(jobs.map((j) => j.id))
    for (const id of [...this.timers.keys()]) {
      if (!ids.has(id)) this.remove(id)
    }
    for (const job of jobs) this.apply(job)
  }

  syncJob(id: string): void {
    if (this.ctx.headless) return
    const job = this.ctx.jobs.get(id)
    if (job) this.apply(job)
    else this.remove(id)
  }

  /** ISO timestamp of the next in-app execution, or null when not scheduled. */
  nextRun(id: string): string | null {
    return this.timers.get(id)?.nextRun()?.toISOString() ?? null
  }

  isScheduled(id: string): boolean {
    return this.timers.has(id)
  }

  isRunning(id: string): boolean {
    return this.active.has(id)
  }

  stop(): void {
    for (const id of [...this.timers.keys()]) this.remove(id)
  }

  private apply(job: Job): void {
    this.remove(job.id)
    if (!job.schedule.enabled || !job.schedule.cron.trim() || !this.owns(job)) return
    try {
      const timer = new Cron(job.schedule.cron, { mode: '5-part', catch: true }, () =>
        this.tick(job.id)
      )
      this.timers.set(job.id, timer)
      this.log.info(
        `job "${job.name}" scheduled in-app (${job.schedule.cron}), next ${this.nextRun(job.id)}`
      )
    } catch (err) {
      this.log.warn(`job "${job.name}" has an invalid cron expression and was not scheduled`, err)
    }
  }

  private remove(id: string): void {
    const timer = this.timers.get(id)
    if (!timer) return
    timer.stop()
    this.timers.delete(id)
  }

  private async tick(jobId: string): Promise<void> {
    if (this.active.has(jobId)) {
      this.log.warn(`job ${jobId}: previous scheduled run still active, skipping this tick`)
      return
    }
    this.active.add(jobId)
    try {
      await this.options.execute(jobId)
    } catch (err) {
      this.log.error(`job ${jobId}: scheduled run could not start`, err)
    } finally {
      this.active.delete(jobId)
    }
  }
}
