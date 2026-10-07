import type { Job, JobRun } from '@shared/types'
import { MANUAL_ROLLBACKS_JOB_ID } from '@shared/backupPackages'
import type { AppContext } from '../context'
import { getLogger, type Logger } from '../log'
import { describeNext } from './cron'
import {
  launchAgentStatus,
  nodePlatformInfo,
  syncLaunchAgents,
  wantsLaunchAgent,
  type ExecFileFn,
  type PlatformInfo
} from './launchAgent'
import { isStaleRun, markInterrupted, recoverStaleRuns } from './recovery'
import { startJob, startJobWith, type RunOptions, type RunnerDeps, type StartedJob } from './runner'
import { Scheduler } from './scheduler'

export interface ScheduleStatus {
  inApp: boolean
  launchAgent: boolean
  nextRun: string | null
}

export interface AutomationService {
  /** Starts a run and resolves with its initial `running` snapshot. */
  run(jobId: string, trigger: JobRun['trigger']): Promise<JobRun>
  /**
   * Starts a run of a job definition that is not stored as such (a rollback
   * of another run); shares cancellation and the one-run-per-job rule.
   */
  runPrepared?(job: Job, trigger: JobRun['trigger'], options: RunOptions): Promise<JobRun>
  cancel(runId: string): void
  /**
   * Active runs of this process that include restore steps (they may have
   * dropped a database already): quitting now would leave it incomplete.
   */
  activeRestores?(): { runId: string; jobName: string }[]
  /** Closes stale runs, starts in-app cron scheduling and syncs launchd agents. */
  start(): Promise<void>
  stop(): Promise<void>
  /** Re-applies scheduling (in-app + launchd) for one job or for all of them. */
  resync?(jobId?: string): Promise<void>
  /** Resolves with the final run; the initial snapshot is returned by `run`. */
  wait?(runId: string): Promise<JobRun>
  scheduleStatus?(jobId: string): ScheduleStatus
}

export interface AutomationServiceOptions {
  /** Overrides lazy resolution of backup/mysql modules (tests). */
  deps?: RunnerDeps
  platform?: PlatformInfo
  execFile?: ExecFileFn
  log?: Logger
}

interface ActiveRun {
  jobId: string
  /** Rollbacks restore another run's copies: they never block runs of the job itself. */
  rollback: boolean
  /** The run has restore steps (see activeRestores). */
  restores: boolean
  jobName: string
  controller: AbortController
  done: Promise<JobRun>
}

async function resolveRunnerDeps(ctx: AppContext): Promise<RunnerDeps> {
  const [{ getSessionFactory }, { createBackupService }] = await Promise.all([
    import('../db/manager'),
    import('../backup/index')
  ])
  const sessions = getSessionFactory(ctx)
  return { sessions, backups: createBackupService(ctx, sessions) }
}

/** Reads execPath/app args from electron when available; plain node otherwise. */
async function resolvePlatform(): Promise<PlatformInfo> {
  let appArgs: string[] = []
  try {
    const { app } = await import('electron')
    appArgs = app.isPackaged ? [] : [app.getAppPath()]
  } catch {
    /* not running inside electron (unit tests) */
  }
  return nodePlatformInfo({ appArgs })
}

export function createAutomationService(
  ctx: AppContext,
  options: AutomationServiceOptions = {}
): AutomationService {
  const log = options.log ?? getLogger('automation')
  const active = new Map<string, ActiveRun>()
  let deps: RunnerDeps | null = options.deps ?? null
  let platform: PlatformInfo | null = options.platform ?? null

  const getDeps = async (): Promise<RunnerDeps> => {
    if (!deps) deps = await resolveRunnerDeps(ctx)
    return deps
  }
  const getPlatform = async (): Promise<PlatformInfo> => {
    if (!platform) platform = await resolvePlatform()
    return platform
  }
  const launchAgentDeps = async () => ({
    platform: await getPlatform(),
    execFile: options.execFile,
    log
  })

  const isRunning = (jobId: string): boolean =>
    [...active.values()].some((r) => r.jobId === jobId && !r.rollback)
  const isRollingBack = (jobId: string): boolean =>
    [...active.values()].some((r) => r.jobId === jobId && r.rollback)

  const resolveDeps = async (): Promise<RunnerDeps> => {
    try {
      return await getDeps()
    } catch (err) {
      log.error('automation dependencies unavailable', err)
      throw new Error(
        'No se pudo iniciar el trabajo: los módulos de MySQL o copias de seguridad no están disponibles.'
      )
    }
  }

  const track = (
    job: Pick<Job, 'id' | 'name' | 'tasks'>,
    controller: AbortController,
    started: StartedJob
  ): JobRun => {
    const done = started.done.finally(() => active.delete(started.run.id))
    active.set(started.run.id, {
      jobId: job.id,
      rollback: started.run.kind === 'rollback',
      restores: job.tasks.some((t) => t.type === 'restoreschema'),
      jobName: started.run.jobName,
      controller,
      done
    })
    return started.run
  }

  const run = async (jobId: string, trigger: JobRun['trigger']): Promise<JobRun> => {
    if (isRunning(jobId))
      throw new Error('El trabajo ya se está ejecutando; espera a que termine o cancélalo.')
    const resolved = await resolveDeps()
    const controller = new AbortController()
    const started = startJob(ctx, resolved, jobId, trigger, controller.signal)
    return track(ctx.jobs.get(jobId) ?? { id: jobId, name: '', tasks: [] }, controller, started)
  }

  const runPrepared = async (
    job: Job,
    trigger: JobRun['trigger'],
    options: RunOptions
  ): Promise<JobRun> => {
    const rollback = options.kind === 'rollback'
    if (rollback ? isRollingBack(job.id) : isRunning(job.id))
      throw new Error(
        !rollback
          ? 'La tarea tiene una ejecución en curso; espera a que termine o cancélala.'
          : job.id === MANUAL_ROLLBACKS_JOB_ID
            ? 'Ya hay una restauración de copias en curso; espera a que termine o cancélala.'
            : 'Ya hay una restauración en curso de las copias de esta tarea; espera a que termine o cancélala.'
      )
    const resolved = await resolveDeps()
    const controller = new AbortController()
    return track(
      job,
      controller,
      startJobWith(ctx, resolved, job, trigger, { ...options, signal: controller.signal })
    )
  }

  const scheduler = new Scheduler(ctx, {
    log,
    // A job whose launchd agent is installed is executed by launchd only,
    // otherwise the same tick would start two runs. Outside macOS there are
    // no agents, so the in-app scheduler owns every job.
    owns: (job) =>
      !(wantsLaunchAgent(job) && launchAgentStatus(job.id, platform?.homeDir, platform?.os)),
    execute: async (jobId) => {
      if (isRunning(jobId)) {
        log.warn(`job ${jobId}: a run is already active, scheduled tick skipped`)
        return
      }
      const initial = await run(jobId, 'schedule')
      await active.get(initial.id)?.done
    }
  })

  const syncAgents = async (jobId?: string): Promise<void> => {
    if (ctx.isolatedProfile) {
      log.info('isolated profile: launch agents are not synchronised')
      return
    }
    try {
      await syncLaunchAgents(ctx, await launchAgentDeps(), jobId)
    } catch (err) {
      log.warn('launch agent sync failed', err)
    }
  }

  return {
    run,
    runPrepared,
    cancel(runId) {
      const entry = active.get(runId)
      if (entry) {
        log.info(`run ${runId} cancellation requested`)
        entry.controller.abort()
        return
      }
      // Not executed by this process: close it if nobody runs it any more.
      const stored = ctx.runs.get(runId)
      if (!stored || (stored.status !== 'running' && stored.status !== 'queued')) return
      if (!isStaleRun(stored, { isActive: (id) => active.has(id) })) {
        throw new Error(
          'Esta ejecución la está realizando otro proceso de Vortaq (agente de launchd); espera a que termine.'
        )
      }
      log.info(`run ${runId} closed as interrupted (no process executes it)`)
      markInterrupted(ctx, stored, () => new Date())
    },
    activeRestores() {
      return [...active.entries()]
        .filter(([, r]) => r.restores)
        .map(([runId, r]) => ({ runId, jobName: r.jobName }))
    },
    async wait(runId) {
      const entry = active.get(runId)
      if (entry) return entry.done
      const stored = ctx.runs.get(runId)
      if (!stored) throw new Error(`La ejecución "${runId}" no existe.`)
      return stored
    },
    async start() {
      try {
        const recovered = recoverStaleRuns(ctx, { isActive: (id) => active.has(id) })
        if (recovered.length) log.warn(`${recovered.length} interrupted run(s) closed at startup`)
      } catch (err) {
        log.warn('stale run recovery failed', err)
      }
      if (ctx.headless) return
      await syncAgents()
      scheduler.syncAll()
    },
    async stop() {
      scheduler.stop()
      for (const entry of active.values()) entry.controller.abort()
    },
    async resync(jobId) {
      if (ctx.headless) return
      await syncAgents(jobId)
      if (jobId) scheduler.syncJob(jobId)
      else scheduler.syncAll()
    },
    scheduleStatus(jobId) {
      const job = ctx.jobs.get(jobId)
      const inApp = scheduler.isScheduled(jobId)
      const launchAgent = job
        ? wantsLaunchAgent(job) && launchAgentStatus(jobId, platform?.homeDir, platform?.os)
        : false
      let nextRun = scheduler.nextRun(jobId)
      if (!nextRun && job && job.schedule.enabled && launchAgent)
        nextRun = describeNext(job.schedule.cron)
      return { inApp, launchAgent, nextRun }
    }
  }
}

const registry = new WeakMap<AppContext, AutomationService>()

/** One automation service per application context, shared by IPC and background services. */
export function getAutomationService(
  ctx: AppContext,
  options?: AutomationServiceOptions
): AutomationService {
  let service = registry.get(ctx)
  if (!service) {
    service = createAutomationService(ctx, options)
    registry.set(ctx, service)
  }
  return service
}
