import { app, net } from 'electron'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
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
