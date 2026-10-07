import { app, net, shell } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { UpdateInstallMode, WhatsNewInfo } from '@shared/types'
import { UPDATE_REPO } from '../brand'
import type { AppContext } from '../context'
import { envVar } from '../env'
import { getLogger } from '../log'
import { detectRunMode, type RunModeFs } from './runMode'
import { fixtureFetch } from './fixture'
import { detectInstallMode } from './installMode'
import { UpdateInstaller, type UpdaterLike } from './installer'
import type { DownloadStream } from './macDmg'
import { isAllowedReleaseUrl } from './release'
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
let installMode: UpdateInstallMode | null = null

/** Decided once per start: packaged or not, OS, portable/AppImage, scratch profile. */
function installModeFor(ctx: AppContext): UpdateInstallMode {
  installMode ??= detectInstallMode({
    isPackaged: app.isPackaged,
    platform: process.platform,
    env: process.env,
    isolatedProfile: ctx.isolatedProfile === true
  })
  return installMode
}

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
    autoNetwork: envVar('SMOKE') !== '1',
    installMode: () => installModeFor(ctx)
  })
  return service
}

/** Reads a web stream chunk by chunk (net.fetch bodies). */
async function* chunksOf(stream: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (!stream) return
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/** Only this repository's release downloads (GitHub then redirects to its CDN). */
function assertReleaseUrl(url: string): void {
  if (!isAllowedReleaseUrl(url))
    throw new Error('Solo se descargan archivos de las versiones de ElectronDB en GitHub.')
}

let CancellationTokenClass: (new () => import('electron-updater').CancellationToken) | null = null

/** electron-updater for this OS, restricted to the GitHub releases of UPDATE_REPO. */
async function createElectronUpdater(): Promise<UpdaterLike> {
  const { NsisUpdater, AppImageUpdater, CancellationToken } = await import('electron-updater')
  // The token class electron-updater checks for (re-exported from builder-util-runtime).
  CancellationTokenClass = CancellationToken
  const feed = {
    provider: 'github' as const,
    owner: UPDATE_REPO.owner,
    repo: UPDATE_REPO.name,
    releaseType: 'release' as const
  }
  const updater = process.platform === 'win32' ? new NsisUpdater(feed) : new AppImageUpdater(feed)
  const ulog = getLogger('updater')
  // electron-updater logs versions, URLs of release files and cache paths: no user data.
  updater.logger = {
    info: (m?: unknown) => ulog.info(String(m)),
    warn: (m?: unknown) => ulog.warn(String(m)),
    error: (m?: unknown) => ulog.error(String(m)),
    debug: () => undefined
  }
  updater.autoDownload = false // only after «Descargar y actualizar» (or the opt-in setting)
  updater.autoInstallOnAppQuit = true // «Más tarde»: installed when the app quits
  updater.allowDowngrade = false
  updater.allowPrerelease = false
  updater.disableWebInstaller = true
  updater.fullChangelog = false
  return {
    onProgress: (listener) => void updater.on('download-progress', listener),
    onDownloaded: (listener) => void updater.on('update-downloaded', listener),
    onError: (listener) => void updater.on('error', listener),
    checkForUpdates: async () => {
      const result = await updater.checkForUpdates()
      return result
        ? { isUpdateAvailable: result.isUpdateAvailable, updateInfo: result.updateInfo }
        : null
    },
    downloadUpdate: (token) =>
      updater.downloadUpdate(token as import('electron-updater').CancellationToken),
    quitAndInstall: (isSilent, isForceRunAfter) => updater.quitAndInstall(isSilent, isForceRunAfter)
  }
}

let installer: UpdateInstaller | null = null
/** Loaded on first use: a quit-and-install must not cut a running restore. */
let automationModule: typeof import('../automation/index') | null = null

/** In-app download/installation of updates (UpdateInstaller), one per app start. */
export function getUpdateInstaller(ctx: AppContext): UpdateInstaller {
  if (installer) return installer
  const mode = installModeFor(ctx)
  const ilog = getLogger('updates')
  if (mode === 'auto' || mode === 'mac-dmg')
    void import('../automation/index').then((m) => (automationModule = m))
  installer = new UpdateInstaller({
    mode,
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    ...(mode === 'auto'
      ? {
          createUpdater: createElectronUpdater,
          createToken: () => {
            if (!CancellationTokenClass) throw new Error('electron-updater is not loaded')
            return new CancellationTokenClass()
          }
        }
      : {}),
    ...(mode === 'mac-dmg'
      ? {
          mac: {
            downloadsDir: () => app.getPath('downloads'),
            download: async (url: string, signal: AbortSignal): Promise<DownloadStream> => {
              assertReleaseUrl(url)
              const res = await net.fetch(url, { redirect: 'follow', credentials: 'omit', signal })
              const length = Number(res.headers.get('content-length'))
              return {
                status: res.status,
                contentLength: Number.isFinite(length) && length > 0 ? length : null,
                body: chunksOf(res.body)
              }
            },
            fetchText: async (url: string, signal: AbortSignal): Promise<string> => {
              assertReleaseUrl(url)
              const res = await net.fetch(url, { redirect: 'follow', credentials: 'omit', signal })
              if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
              return res.text()
            },
            openPath: async (path: string): Promise<void> => {
              const error = await shell.openPath(path)
              if (error) throw new Error(error)
            }
          }
        }
      : {}),
    getRelease: () => getUpdateService(ctx).latestRelease(),
    emit: (state) => ctx.emit('event:updateInstall', state),
    busyReason: () => {
      const restores = automationModule?.getAutomationService(ctx).activeRestores?.() ?? []
      if (!restores.length) return null
      const names = [...new Set(restores.map((r) => `«${r.jobName}»`))].join(', ')
      return `Hay una restauración en curso (${names}). Espera a que termine antes de reiniciar para actualizar; la actualización también se instalará al cerrar ElectronDB.`
    },
    log: ilog
  })
  return installer
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
