import type { UpdateInstallMode, UpdateInstallState } from '@shared/types'
import {
  downloadVerified,
  findExpectedSha256,
  MacUpdateError,
  type StreamDownload,
  type TextFetch
} from './macDmg'
import { isAllowedReleaseUrl, pickAssets, type ParsedRelease } from './release'
import { isNewer, parseVersion } from './semver'

/**
 * In-app download and installation of a new version («Descargar y actualizar»).
 *
 * - 'auto' (Windows NSIS installer, Linux AppImage): electron-updater reads latest.yml /
 *   latest-linux.yml of the GitHub release, downloads the file and checks its sha512 before
 *   anything runs. «Reiniciar y actualizar» quits and installs silently, then starts the new
 *   version; otherwise the update is installed when the app quits (autoInstallOnAppQuit).
 * - 'mac-dmg': downloads the .dmg of this Mac's architecture, checks its SHA-256 against the
 *   published SHA256SUMS.txt and opens it (see macDmg.ts for why macOS cannot self-install).
 *
 * Nothing starts without a call to download() (a click, or the opt-in automatic download).
 * electron-updater and the network are injected, so the state machine is unit tested.
 */

/** Subset of electron-updater's AppUpdater used here (index.ts adapts the real one). */
export interface UpdaterLike {
  onProgress(
    listener: (p: { transferred: number; total: number; bytesPerSecond: number }) => void
  ): void
  onDownloaded(listener: (info: { version: string }) => void): void
  /** electron-updater also emits failures as events; an unhandled 'error' would crash main. */
  onError(listener: (err: Error) => void): void
  checkForUpdates(): Promise<{
    isUpdateAvailable?: boolean
    updateInfo: { version: string }
  } | null>
  downloadUpdate(token: CancelToken): Promise<unknown>
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void
}

export interface CancelToken {
  cancel(): void
  readonly cancelled: boolean
}

export interface InstallerLog {
  info(message: string): void
  warn(message: string): void
}

export interface UpdateInstallerOptions {
  mode: UpdateInstallMode
  currentVersion: string
  platform: string
  arch: string
  /** 'auto' only: builds the configured electron-updater instance (lazily, on first download). */
  createUpdater?: () => Promise<UpdaterLike>
  createToken?: () => CancelToken
  /** 'mac-dmg' only. */
  mac?: {
    downloadsDir: () => string
    download: StreamDownload
    fetchText: TextFetch
    openPath: (path: string) => Promise<void>
  }
  /** Last release seen by UpdateService (GitHub API), for the .dmg and the manual link. */
  getRelease: () => ParsedRelease | null
  /** Pushes every state change to the renderer (event:updateInstall). */
  emit: (state: UpdateInstallState) => void
  /** Reason not to quit right now (a restore is running), or null. */
  busyReason?: () => string | null
  log: InstallerLog
  now?: () => number
}

/** Progress events closer than this are merged (the .dmg stream reports every chunk). */
const PROGRESS_EMIT_MS = 250

const FEED_MISSING_CODES = new Set([
  'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
  'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
  'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
  'ERR_UPDATER_RELEASE_NOT_FOUND',
  'ERR_UPDATER_ASSET_NOT_FOUND',
  'ERR_UPDATER_NO_FILES_PROVIDED',
  'ERR_UPDATER_INVALID_UPDATE_INFO',
  'ERR_UPDATER_INVALID_RELEASE_FEED'
])

class FeedMissingError extends Error {
  readonly code = 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
}

const isAbort = (err: unknown): boolean => {
  const name = (err as { name?: string } | null)?.name
  return name === 'AbortError' || name === 'CancellationError'
}

/** Spanish, actionable message for an electron-updater failure (never the raw text). */
export function updaterErrorMessage(err: unknown): string {
  const code = String((err as { code?: unknown } | null)?.code ?? '')
  const message = err instanceof Error ? err.message : String(err)
  if (FEED_MISSING_CODES.has(code))
    return 'Esta versión no incluye la actualización integrada para tu sistema (falta latest.yml en GitHub). Descárgala manualmente.'
  if (code === 'ERR_CHECKSUM_MISMATCH' || /sha512 checksum mismatch/i.test(message))
    return 'La descarga no coincide con la suma sha512 publicada y se ha descartado. Vuelve a intentarlo o descárgala manualmente.'
  if (code === 'ERR_UPDATER_OLD_FILE_NOT_FOUND')
    return 'No se encuentra el archivo AppImage que está en ejecución, así que no se puede reemplazar. Descarga la nueva versión manualmente.'
  if (code === 'HTTP_ERROR_403' || code === 'HTTP_ERROR_429')
    return 'GitHub ha limitado temporalmente las descargas desde tu red. Vuelve a intentarlo dentro de un rato o descárgala manualmente.'
  if (/ENOSPC/.test(code) || /ENOSPC/.test(message))
    return 'No hay espacio libre suficiente en el disco para descargar la actualización.'
  if (/EACCES|EPERM/.test(code) || /EACCES|EPERM/.test(message))
    return 'No hay permiso para escribir la actualización. Descárgala manualmente e instálala.'
  if (/net::|ENOTFOUND|ECONNRE|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(`${code} ${message}`))
    return 'No se pudo descargar la actualización: comprueba la conexión a Internet (o el proxy) e inténtalo de nuevo.'
  return 'No se pudo descargar la actualización. Vuelve a intentarlo o descárgala manualmente.'
}

export class UpdateInstaller {
  private current: UpdateInstallState
  private readonly now: () => number
  /** Incremented by every download() and cancel(): late events of an older run are ignored. */
  private runId = 0
  private token: CancelToken | null = null
  private abort: AbortController | null = null
  private updater: Promise<UpdaterLike> | null = null
  private lastEmit = 0
  private startedAt = 0

  constructor(private readonly options: UpdateInstallerOptions) {
    this.current = { mode: options.mode, phase: 'idle' }
    this.now = options.now ?? Date.now
  }

  state(): UpdateInstallState {
    return { ...this.current }
  }

  /** «Descargar y actualizar». Returns once the download has started (progress comes as events). */
  download(version: string): UpdateInstallState {
    if (!parseVersion(version)) throw new Error(`Versión no válida: ${String(version)}`)
    const mode = this.options.mode
    if (mode !== 'auto' && mode !== 'mac-dmg')
      throw new Error(
        'Esta copia de ElectronDB no puede actualizarse desde la app. Usa «Descargar manualmente».'
      )
    if (!isNewer(version, this.options.currentVersion))
      throw new Error(`Ya tienes la versión ${this.options.currentVersion} o una más nueva.`)
    const { phase } = this.current
    if (phase === 'downloading') return this.state()
    if (phase === 'downloaded' && this.current.version && !isNewer(version, this.current.version))
      return this.state()

    const run = ++this.runId
    this.token = null
    this.abort = null
    this.startedAt = this.now()
    this.set(
      { mode, phase: 'downloading', version, transferred: 0, total: 0, bytesPerSecond: 0 },
      true
    )
    const task = mode === 'auto' ? this.runAuto(run, version) : this.runMac(run, version)
    void task.catch((err) => this.fail(run, err))
    return this.state()
  }

  /** Cancels a running download; the state goes back to 'idle' with `cancelled`. */
  cancel(): UpdateInstallState {
    if (this.current.phase !== 'downloading') return this.state()
    this.runId++
    this.token?.cancel()
    this.abort?.abort()
    this.token = null
    this.abort = null
    this.options.log.info(`updates: download of ${this.current.version} cancelled by the user`)
    this.set({ mode: this.options.mode, phase: 'idle', cancelled: true }, true)
    return this.state()
  }

  /**
   * «Reiniciar y actualizar» (auto): quits, installs silently and starts the new version.
   * mac-dmg: opens the verified .dmg again.
   */
  async install(): Promise<void> {
    if (this.current.phase !== 'downloaded')
      throw new Error('La actualización todavía no se ha descargado.')
    if (this.options.mode === 'mac-dmg') {
      const file = this.current.filePath
      if (!file || !this.options.mac) throw new Error('No se encuentra el instalador descargado.')
      await this.options.mac.openPath(file)
      return
    }
    const busy = this.options.busyReason?.()
    if (busy) throw new Error(busy)
    const updater = await this.getUpdater()
    this.options.log.info(`updates: quit and install ${this.current.version}`)
    // Silent install (no wizard) and start the new version afterwards.
    updater.quitAndInstall(true, true)
  }

  private async getUpdater(): Promise<UpdaterLike> {
    const create = this.options.createUpdater
    if (!create) throw new Error('La actualización integrada no está disponible en esta copia.')
    this.updater ??= create().then((updater) => {
      updater.onProgress((p) => this.progress(this.runId, p.transferred, p.total, p.bytesPerSecond))
      updater.onDownloaded((info) => {
        if (this.current.phase === 'downloading' && info.version === this.current.version)
          this.downloaded(this.runId, {})
      })
      updater.onError((err) => this.options.log.warn(`updates: updater error: ${err.message}`))
      return updater
    })
    try {
      return await this.updater
    } catch (err) {
      this.updater = null
      throw err
    }
  }

  private async runAuto(run: number, version: string): Promise<void> {
    const updater = await this.getUpdater()
    const check = await updater.checkForUpdates()
    if (run !== this.runId) return
    const offered = check?.updateInfo?.version
    if (!check || !offered || check.isUpdateAvailable === false) throw new FeedMissingError()
    if (!isNewer(offered, this.options.currentVersion)) throw new FeedMissingError()
    // latest.yml may already point to a newer version than the one in the dialog: take it.
    if (offered !== version) this.set({ version: offered })
    this.options.log.info(`updates: downloading ${offered}`)
    const token = this.options.createToken?.()
    if (!token) throw new Error('missing cancellation token factory')
    this.token = token
    await updater.downloadUpdate(token)
    if (run !== this.runId) return
    this.downloaded(run, {})
  }

  private async runMac(run: number, version: string): Promise<void> {
    const mac = this.options.mac
    if (!mac) throw new MacUpdateError('La descarga del instalador no está disponible.')
    const release = this.options.getRelease()
    if (!release || release.version !== version)
      throw new MacUpdateError(
        'Vuelve a buscar actualizaciones: la información de la versión ya no está disponible.'
      )
    const { download } = pickAssets(release.assets, this.options.platform, this.options.arch)
    if (!download || !/\.dmg$/i.test(download.fileName))
      throw new MacUpdateError(
        `La versión ${version} no tiene un .dmg para este Mac. Descárgala manualmente.`
      )
    const abort = new AbortController()
    this.abort = abort
    const expected = await findExpectedSha256(
      release,
      download.fileName,
      mac.fetchText,
      abort.signal
    )
    if (run !== this.runId) return
    if (!expected)
      throw new MacUpdateError(
        `La versión ${version} no publica la suma SHA-256 del instalador, así que no se puede comprobar. Descárgala manualmente.`
      )
    this.options.log.info(`updates: downloading ${download.fileName}`)
    const filePath = await downloadVerified({
      url: download.url,
      fileName: download.fileName,
      expectedSha256: expected,
      expectedSize: download.sizeBytes,
      dir: mac.downloadsDir(),
      download: mac.download,
      signal: abort.signal,
      onProgress: (transferred, total) => this.progress(run, transferred, total)
    })
    if (run !== this.runId) return
    this.options.log.info(`updates: ${download.fileName} downloaded and verified (SHA-256)`)
    this.downloaded(run, { filePath })
    await mac.openPath(filePath).catch((err: unknown) => {
      this.options.log.warn(`updates: could not open the dmg: ${(err as Error).message}`)
    })
  }

  private progress(run: number, transferred: number, total: number, bytesPerSecond?: number): void {
    if (run !== this.runId || this.current.phase !== 'downloading') return
    const elapsed = (this.now() - this.startedAt) / 1000
    const speed = bytesPerSecond ?? (elapsed > 0 ? Math.round(transferred / elapsed) : 0)
    const t = this.now()
    const force = total > 0 && transferred >= total
    this.current = { ...this.current, transferred, total, bytesPerSecond: speed }
    if (force || t - this.lastEmit >= PROGRESS_EMIT_MS) this.emit()
  }

  private downloaded(run: number, extra: Partial<UpdateInstallState>): void {
    if (run !== this.runId || this.current.phase !== 'downloading') return
    this.token = null
    this.abort = null
    const total = this.current.total || this.current.transferred || 0
    this.options.log.info(`updates: ${this.current.version} ready to install`)
    this.set({ phase: 'downloaded', transferred: total, total, bytesPerSecond: 0, ...extra })
  }

  private fail(run: number, err: unknown): void {
    if (run !== this.runId) return
    this.token = null
    this.abort = null
    if (isAbort(err)) {
      this.set({ mode: this.options.mode, phase: 'idle', cancelled: true }, true)
      return
    }
    const message = err instanceof MacUpdateError ? err.message : updaterErrorMessage(err)
    this.options.log.warn(
      `updates: download failed: ${err instanceof Error ? `${(err as { code?: string }).code ?? err.name}: ${err.message}` : String(err)}`
    )
    const manualUrl = this.manualUrl()
    this.set(
      {
        mode: this.options.mode,
        phase: 'error',
        version: this.current.version,
        error: message,
        ...(manualUrl ? { manualUrl } : {})
      },
      true
    )
  }

  /** «Descargar manualmente»: this OS's asset, else the release page. */
  private manualUrl(): string | undefined {
    const release = this.options.getRelease()
    if (!release) return undefined
    const { download } = pickAssets(release.assets, this.options.platform, this.options.arch)
    const url = download?.url ?? release.htmlUrl
    return isAllowedReleaseUrl(url) ? url : undefined
  }

  private set(next: Partial<UpdateInstallState>, replace = false): void {
    this.current = replace
      ? ({ mode: this.options.mode, ...next } as UpdateInstallState)
      : { ...this.current, ...next }
    this.emit()
  }

  private emit(): void {
    this.lastEmit = this.now()
    this.options.emit(this.state())
  }
}
