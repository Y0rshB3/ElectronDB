import { execFile as nodeExecFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { build as buildPlist, type PlistValue } from 'plist'
import type { Job, StartupNotice } from '@shared/types'
import { APP_NAME, LEGACY_APPS, LEGACY_NAVIDOG } from '../brand'
import type { AppContext } from '../context'
import { getLogger, type Logger } from '../log'
import { raiseNotice } from '../notices'
import { cronToCalendarIntervals } from './cron'

export const LAUNCH_AGENT_PREFIX = 'dev.y0rshb3.vortaq.job.'
/**
 * Label prefixes of earlier product names (ElectronDB, Navidog), newest first;
 * their agents are moved to LAUNCH_AGENT_PREFIX at start.
 */
export const LEGACY_LAUNCH_AGENT_PREFIXES: readonly string[] = LEGACY_APPS.map(
  (a) => a.launchAgentPrefix
)
/** The Navidog prefix (kept for code written before the Vortaq rename). */
export const LEGACY_LAUNCH_AGENT_PREFIX = LEGACY_NAVIDOG.launchAgentPrefix

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

/** A launch agent written under an earlier product name. */
export interface LegacyAgent {
  jobId: string
  /** Its plist file name (`<prefix><jobId>.plist`). */
  file: string
}

/**
 * Unloads and deletes the agents written under earlier product names
 * (dev.y0rshb3.electrondb.job.*, dev.y0rshb3.navidog.job.*) whose job exists
 * in `knownJobIds` (the Vortaq jobs repo): the following sync installs them
 * again under the new label when the job still wants one. Agents of jobs
 * Vortaq does not know (profile not migrated, jobs.json missing) are left
 * alone, since deleting them would silently stop those schedules. Returns the
 * removed job ids and the agents kept.
 */
export async function removeLegacyLaunchAgents(
  deps: LaunchAgentDeps,
  knownJobIds: ReadonlySet<string>
): Promise<{ removed: string[]; unknown: string[]; unknownAgents: LegacyAgent[] }> {
  if (!supportsLaunchAgents(deps.platform.os))
    return { removed: [], unknown: [], unknownAgents: [] }
  const log = deps.log ?? getLogger('launchd')
  const removed: string[] = []
  const unknownAgents: LegacyAgent[] = []
  for (const prefix of LEGACY_LAUNCH_AGENT_PREFIXES) {
    for (const id of installedJobIds(deps.platform.homeDir, prefix)) {
      const file = `${prefix}${id}.plist`
      if (!knownJobIds.has(id)) {
        unknownAgents.push({ jobId: id, file })
        continue
      }
      try {
        await bootout(join(launchAgentsDir(deps.platform.homeDir), file), deps)
        unlinkSync(join(launchAgentsDir(deps.platform.homeDir), file))
        if (!removed.includes(id)) removed.push(id)
        log.info(`legacy launch agent ${prefix}* removed for job ${id}`)
      } catch (err) {
        log.warn(`could not remove legacy launch agent for job ${id}`, err)
      }
    }
  }
  const unknown = [...new Set(unknownAgents.map((a) => a.jobId))]
  if (unknown.length)
    log.warn(
      `legacy launch agent(s) kept for job(s) missing from ${APP_NAME}: ${unknown.join(', ')}`
    )
  return { removed, unknown, unknownAgents }
}

/**
 * Startup notice for legacy agents left in place. Its id lists the job ids, so
 * it shows once per set of jobs (a set already dismissed in an earlier
 * profile, copied with notices.json, stays dismissed).
 */
export function legacyLaunchAgentsNotice(
  agents: Array<LegacyAgent | string>,
  homeDir: string
): StartupNotice {
  const list = agents.map((a) =>
    typeof a === 'string' ? { jobId: a, file: `${LEGACY_LAUNCH_AGENT_PREFIX}${a}.plist` } : a
  )
  const ids = [...new Set(list.map((a) => a.jobId))].sort()
  const files = list.map((a) => a.file).sort()
  const one = ids.length === 1
  return {
    id: `${LEGACY_LAUNCH_AGENTS_NOTICE}:${ids.join(',')}`,
    level: 'warning',
    title: 'Trabajos programados de una versión anterior sin migrar',
    message:
      `En ${launchAgentsDir(homeDir)} hay ${one ? 'un trabajo programado' : `${ids.length} trabajos programados`} ` +
      `de una versión anterior de la app (ElectronDB o Navidog) que no existe${one ? '' : 'n'} en ${APP_NAME} (${files.join(', ')}). ` +
      'No se han borrado: siguen lanzando la versión anterior y dejan de ejecutarse si la desinstalas. ' +
      `Crea esos trabajos en Automatización y borra después esos archivos, o bórralos si ya no los necesitas.`
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
    if (legacy.unknownAgents.length)
      raiseNotice(legacyLaunchAgentsNotice(legacy.unknownAgents, deps.platform.homeDir))
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
