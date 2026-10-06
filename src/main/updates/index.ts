import { app, net } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { WhatsNewInfo } from '@shared/types'
import type { AppContext } from '../context'
import { envVar } from '../env'
import { getLogger } from '../log'
import { detectRunMode, type RunModeFs } from './runMode'
import { fixtureFetch } from './fixture'
import { UpdateService, type FetchLike } from './service'

export { isAllowedReleaseUrl } from './release'
export { UpdateService } from './service'

const log = getLogger('updates')

const nodeFs: RunModeFs = {
  exists: (path) => {
    try {
      statSync(path)
      return true
    } catch {
      return false
    }
  },
  isFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  readText: (path) => readFileSync(path, 'utf8')
}

/** Electron's network stack (system proxy and certificates), never the renderer. */
const electronFetch: FetchLike = async (url, init) => {
  const res = await net.fetch(url, { ...init, redirect: 'follow', credentials: 'omit' })
  return { status: res.status, text: () => res.text() }
}

let service: UpdateService | null = null

export function getUpdateService(ctx: AppContext): UpdateService {
  if (service) return service
  const fixtureEnv = ctx.isolatedProfile ? envVar('UPDATES_FIXTURE')?.trim() : undefined
  const fixture = fixtureEnv ? resolve(fixtureEnv) : undefined
  if (fixture) log.info('updates: answering from ELECTRONDB_UPDATES_FIXTURE (test mode)')
  // ELECTRONDB_UPDATES_RUN_MODE (scratch profile only) forces the packaged/source UI in screenshots.
  const forcedMode = ctx.isolatedProfile ? envVar('UPDATES_RUN_MODE')?.trim() : undefined
  service = new UpdateService({
    stateDir: ctx.userDataPath,
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    runMode: () =>
      detectRunMode({
        isPackaged: forcedMode ? forcedMode === 'packaged' : app.isPackaged,
        appPath: app.getAppPath(),
        platform: process.platform,
        fs: nodeFs
      }),
    fetch: fixture ? fixtureFetch(fixture) : electronFetch,
    autoNetwork: envVar('SMOKE') !== '1'
  })
  return service
}

/** Profile state at start: decides between "fresh profile" and "updated from an older build". */
let profileHadData: boolean | null = null

/** Records, once and early, whether the profile already held data before this start. */
export function rememberProfileState(ctx: AppContext): void {
  profileHadData ??= ['connections.json', 'settings.json', 'jobs.json'].some((f) =>
    existsSync(join(ctx.userDataPath, f))
  )
}

/**
 * «Novedades» after an update. Smoke and screenshot runs never show it unless
 * ELECTRONDB_WHATS_NEW_FROM=<version> asks for it (scratch profile only);
 * ELECTRONDB_WHATS_NEW_VERSION=<version> pretends the running version.
 */
export function whatsNewFor(ctx: AppContext): WhatsNewInfo | null {
  rememberProfileState(ctx)
  const from = ctx.isolatedProfile ? envVar('WHATS_NEW_FROM')?.trim() : undefined
  const version = ctx.isolatedProfile ? envVar('WHATS_NEW_VERSION')?.trim() : undefined
  if (!from && (envVar('SMOKE') === '1' || envVar('SCREENSHOTS'))) return null
  return getUpdateService(ctx).whatsNew({
    profileHadData: profileHadData === true,
    ...(from ? { previousVersion: from } : {}),
    ...(version ? { currentVersion: version } : {})
  })
}
