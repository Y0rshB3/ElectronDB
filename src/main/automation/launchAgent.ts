import { execFile as nodeExecFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { build as buildPlist, type PlistValue } from 'plist'
import type { Job, StartupNotice } from '@shared/types'
import type { AppContext } from '../context'
import { getLogger, type Logger } from '../log'
import { raiseNotice } from '../notices'
import { cronToCalendarIntervals } from './cron'

export const LAUNCH_AGENT_PREFIX = 'dev.y0rshb3.electrondb.job.'
/** Label prefix used before the Navidog -> ElectronDB rename; such agents are removed at start. */
export const LEGACY_LAUNCH_AGENT_PREFIX = 'dev.y0rshb3.navidog.job.'

/** Host facts the agent writer needs; injectable so tests never touch electron. */
export interface PlatformInfo {
  /** Operating system (process.platform). Launch agents only exist on macOS. */
  os: NodeJS.Platform
  /** Binary launchd will execute (process.execPath). */
  execPath: string
  /** Extra arguments before --run-job (the app path in dev, none when packaged). */
  appArgs: string[]
  uid: number
  homeDir: string
}

export type ExecFileFn = (
  file: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>

export interface LaunchAgentDeps {
  platform: PlatformInfo
  execFile?: ExecFileFn
  log?: Logger
}

export const defaultExecFile: ExecFileFn = (file, args) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err)
        reject(new Error(`${file} ${args.join(' ')} failed: ${stderr?.trim() || err.message}`))
      else resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })

/** PlatformInfo for a plain Node process (no electron). Used as fallback and in tests. */
export function nodePlatformInfo(overrides: Partial<PlatformInfo> = {}): PlatformInfo {
  return {
    os: process.platform,
    execPath: process.execPath,
    appArgs: [],
    uid: process.getuid?.() ?? 0,
    homeDir: homedir(),
    ...overrides
  }
}

/**
 * launchd is macOS-only. Everywhere else the in-app scheduler owns every job
 * and nothing is ever written to ~/Library/LaunchAgents.
 */
export function supportsLaunchAgents(os: NodeJS.Platform = process.platform): boolean {
  return os === 'darwin'
}

export const LAUNCH_AGENT_UNSUPPORTED =
  'Ejecutar un trabajo con la app cerrada solo está disponible en macOS (launchd). En Windows usa el Programador de tareas y en Linux cron, con el argumento --run-job=<id>.'

export function launchAgentLabel(jobId: string): string {
  return `${LAUNCH_AGENT_PREFIX}${jobId}`
}

export function launchAgentsDir(homeDir: string): string {
  return join(homeDir, 'Library', 'LaunchAgents')
}

export function launchAgentPath(homeDir: string, jobId: string): string {
  return join(launchAgentsDir(homeDir), `${launchAgentLabel(jobId)}.plist`)
}

export function launchdLogDir(ctx: Pick<AppContext, 'logDir'>): string {
  return join(ctx.logDir, 'launchd')
}

/** True when the job wants launchd to run it. */
export function wantsLaunchAgent(job: Job): boolean {
  return job.schedule.enabled && job.schedule.launchAgent && job.schedule.cron.trim().length > 0
}

export function buildLaunchAgentPlist(
  job: Job,
  ctx: Pick<AppContext, 'logDir'>,
  platform: PlatformInfo
): string {
  const label = launchAgentLabel(job.id)
  const logDir = launchdLogDir(ctx)
  return buildPlist({
    Label: label,
    ProgramArguments: [platform.execPath, ...platform.appArgs, `--run-job=${job.id}`],
    StartCalendarInterval: cronToCalendarIntervals(job.schedule.cron).map(
      (i) => ({ ...i }) as PlistValue
    ),
    StandardOutPath: join(logDir, `${label}.out.log`),
    StandardErrorPath: join(logDir, `${label}.err.log`),
    RunAtLoad: false
  })
}

/** Whether a launch agent plist exists for the job (always false outside macOS). */
export function launchAgentStatus(
  jobId: string,
  homeDir: string = homedir(),
  os: NodeJS.Platform = process.platform
): boolean {
  return supportsLaunchAgents(os) && existsSync(launchAgentPath(homeDir, jobId))
}

async function bootout(plistPath: string, deps: LaunchAgentDeps): Promise<void> {
  const exec = deps.execFile ?? defaultExecFile
  try {
    await exec('launchctl', ['bootout', `gui/${deps.platform.uid}`, plistPath])
  } catch {
    /* not loaded yet: expected on first install and after reboots */
  }
}

/** Writes the plist and (re)registers it with launchd. */
export async function installLaunchAgent(
  job: Job,
  ctx: Pick<AppContext, 'logDir'>,
  deps: LaunchAgentDeps
): Promise<void> {
  if (!supportsLaunchAgents(deps.platform.os)) throw new Error(LAUNCH_AGENT_UNSUPPORTED)
  const exec = deps.execFile ?? defaultExecFile
  const plistPath = launchAgentPath(deps.platform.homeDir, job.id)
  const xml = buildLaunchAgentPlist(job, ctx, deps.platform)
  mkdirSync(launchAgentsDir(deps.platform.homeDir), { recursive: true })
  mkdirSync(launchdLogDir(ctx), { recursive: true })
  writeFileSync(plistPath, xml, { mode: 0o644 })
  await bootout(plistPath, deps)
  await exec('launchctl', ['bootstrap', `gui/${deps.platform.uid}`, plistPath])
}

/** Unregisters the agent (if loaded) and deletes its plist. */
export async function removeLaunchAgent(jobId: string, deps: LaunchAgentDeps): Promise<void> {
  if (!supportsLaunchAgents(deps.platform.os)) return
  const plistPath = launchAgentPath(deps.platform.homeDir, jobId)
  if (!existsSync(plistPath)) return
  await bootout(plistPath, deps)
  unlinkSync(plistPath)
}

function installedJobIds(homeDir: string, prefix = LAUNCH_AGENT_PREFIX): string[] {
  const dir = launchAgentsDir(homeDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.plist'))
    .map((f) => f.slice(prefix.length, -'.plist'.length))
}

export const LEGACY_LAUNCH_AGENTS_NOTICE = 'legacy-launch-agents'

/**
 * Unloads and deletes the agents written before the rename
 * (dev.y0rshb3.navidog.job.*) whose job exists in `knownJobIds` (the
 * ElectronDB jobs repo): the following sync installs them again under the new
 * label when the job still wants one. Agents of jobs ElectronDB does not know
 * (profile not migrated, jobs.json missing) are left alone, since deleting
 * them would silently stop those schedules. Returns both lists of job ids.
 */
export async function removeLegacyLaunchAgents(
  deps: LaunchAgentDeps,
  knownJobIds: ReadonlySet<string>
): Promise<{ removed: string[]; unknown: string[] }> {
  if (!supportsLaunchAgents(deps.platform.os)) return { removed: [], unknown: [] }
  const log = deps.log ?? getLogger('launchd')
  const removed: string[] = []
  const unknown: string[] = []
  for (const id of installedJobIds(deps.platform.homeDir, LEGACY_LAUNCH_AGENT_PREFIX)) {
    if (!knownJobIds.has(id)) {
      unknown.push(id)
      continue
    }
    const plistPath = join(
      launchAgentsDir(deps.platform.homeDir),
      `${LEGACY_LAUNCH_AGENT_PREFIX}${id}.plist`
    )
    try {
      await bootout(plistPath, deps)
      unlinkSync(plistPath)
      removed.push(id)
      log.info(`legacy launch agent removed for job ${id}`)
    } catch (err) {
      log.warn(`could not remove legacy launch agent for job ${id}`, err)
    }
  }
  if (unknown.length)
    log.warn(
      `legacy launch agent(s) kept for job(s) missing from ElectronDB: ${unknown.join(', ')}`
    )
  return { removed, unknown }
}

/** Startup notice for legacy agents left in place (shown once per set of ids). */
export function legacyLaunchAgentsNotice(ids: string[], homeDir: string): StartupNotice {
  const sorted = [...ids].sort()
  return {
    id: `${LEGACY_LAUNCH_AGENTS_NOTICE}:${sorted.join(',')}`,
    level: 'warning',
    title: 'Trabajos programados de Navidog sin migrar',
    message:
      `En ${launchAgentsDir(homeDir)} hay ${sorted.length === 1 ? 'un trabajo programado' : `${sorted.length} trabajos programados`} ` +
      `de Navidog que no existe${sorted.length === 1 ? '' : 'n'} en ElectronDB (${sorted
        .map((id) => `${LEGACY_LAUNCH_AGENT_PREFIX}${id}.plist`)
        .join(', ')}). ` +
      'No se han borrado: siguen lanzando Navidog y dejan de ejecutarse si lo desinstalas. ' +
      'Crea esos trabajos en Automatización y borra después esos archivos, o bórralos si ya no los necesitas.'
  }
}

/**
 * Reconciles launch agents with the jobs repo: installs one per job that
 * wants it and removes agents of disabled or deleted jobs. Failures are
 * logged per job and never thrown, so the app keeps starting. A no-op outside
 * macOS: there the in-app scheduler runs every job.
 */
export async function syncLaunchAgents(
  ctx: Pick<AppContext, 'logDir' | 'jobs'>,
  deps: LaunchAgentDeps,
  jobId?: string
): Promise<void> {
  const log = deps.log ?? getLogger('launchd')
  if (!supportsLaunchAgents(deps.platform.os)) {
    log.debug(`launch agents are macOS-only: nothing to sync on ${deps.platform.os}`)
    return
  }
  const jobs = ctx.jobs.list()
  const known = new Map(jobs.map((j) => [j.id, j]))
  if (!jobId) {
    const legacy = await removeLegacyLaunchAgents({ ...deps, log }, new Set(known.keys()))
    if (legacy.unknown.length)
      raiseNotice(legacyLaunchAgentsNotice(legacy.unknown, deps.platform.homeDir))
  }
  const candidates = jobId
    ? [jobId]
    : [...new Set([...known.keys(), ...installedJobIds(deps.platform.homeDir)])]
  for (const id of candidates) {
    const job = known.get(id)
    try {
      if (job && wantsLaunchAgent(job)) {
        await installLaunchAgent(job, ctx, deps)
        log.info(`launch agent installed for job "${job.name}"`)
      } else if (launchAgentStatus(id, deps.platform.homeDir, deps.platform.os)) {
        await removeLaunchAgent(id, deps)
        log.info(`launch agent removed for job ${id}`)
      }
    } catch (err) {
      log.warn(`launch agent sync failed for job ${id}`, err)
    }
  }
}
