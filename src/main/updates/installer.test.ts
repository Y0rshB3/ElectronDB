import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateInstallState } from '@shared/types'
import {
  UpdateInstaller,
  updaterErrorMessage,
  type CancelToken,
  type UpdateInstallerOptions,
  type UpdaterLike
} from './installer'
import type { StreamDownload } from './macDmg'
import { parseRelease, type ParsedRelease } from './release'
import { apiRelease, RELEASES_BASE } from './testing'

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** electron-updater stand-in: the test drives progress, completion and failures. */
class FakeUpdater implements UpdaterLike {
  progressListener:
    ((p: { transferred: number; total: number; bytesPerSecond: number }) => void) | null = null
  downloadedListener: ((info: { version: string }) => void) | null = null
  errorListener: ((err: Error) => void) | null = null
  feedVersion: string | null = '0.1.3'
  checkError: Error | null = null
  quitAndInstall = vi.fn()
  token: CancelToken | null = null
  private settle: { resolve: () => void; reject: (e: Error) => void } | null = null

  onProgress(l: FakeUpdater['progressListener'] & object) {
    this.progressListener = l
  }
  onDownloaded(l: FakeUpdater['downloadedListener'] & object) {
    this.downloadedListener = l
  }
  onError(l: FakeUpdater['errorListener'] & object) {
    this.errorListener = l
  }
  checkForUpdates = vi.fn(async () => {
    if (this.checkError) throw this.checkError
    return this.feedVersion
      ? { isUpdateAvailable: true, updateInfo: { version: this.feedVersion } }
      : null
  })
  downloadUpdate = vi.fn((token: CancelToken) => {
    this.token = token
    return new Promise<unknown>((resolve, reject) => {
      this.settle = { resolve: () => resolve(['/cache/setup.exe']), reject }
    })
  })
  progress(transferred: number, total: number, bytesPerSecond = 1000) {
    this.progressListener?.({ transferred, total, bytesPerSecond })
  }
  finish() {
    this.downloadedListener?.({ version: this.feedVersion ?? '' })
    this.settle?.resolve()
  }
  fail(err: Error) {
    this.errorListener?.(err)
    this.settle?.reject(err)
  }
}

class FakeToken implements CancelToken {
  cancelled = false
  constructor(private readonly onCancel: () => void) {}
  cancel() {
    this.cancelled = true
    this.onCancel()
  }
}

describe('UpdateInstaller (auto: Windows NSIS / Linux AppImage)', () => {
  let updater: FakeUpdater
  let events: UpdateInstallState[]
  let now: number
  let release: ParsedRelease | null

  function installer(overrides: Partial<UpdateInstallerOptions> = {}) {
    return new UpdateInstaller({
      mode: 'auto',
      currentVersion: '0.1.2',
      platform: 'win32',
      arch: 'x64',
      createUpdater: async () => updater,
      createToken: () => {
        const err = Object.assign(new Error('cancelled'), { name: 'CancellationError' })
        return new FakeToken(() => updater.fail(err))
      },
      getRelease: () => release,
      emit: (s) => events.push(s),
      log: { info: vi.fn(), warn: vi.fn() },
      now: () => now,
      ...overrides
    })
  }

  beforeEach(() => {
    updater = new FakeUpdater()
    events = []
    now = 1_000_000
    release = parseRelease(apiRelease())
  })

  it('available → downloading with progress → downloaded → quitAndInstall (silent, relaunch)', async () => {
    const inst = installer()
    const started = inst.download('0.1.3')
    expect(started).toMatchObject({
      mode: 'auto',
      phase: 'downloading',
      version: '0.1.3',
      transferred: 0
    })
    await flush()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)

    now += 1000
    updater.progress(40_000_000, 130_000_000, 4_000_000)
    expect(inst.state()).toMatchObject({
      phase: 'downloading',
      transferred: 40_000_000,
      total: 130_000_000,
      bytesPerSecond: 4_000_000
    })
    expect(events.at(-1)).toMatchObject({ transferred: 40_000_000 })

    // A second click while downloading does not start another download.
    inst.download('0.1.3')
    await flush()
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)

    updater.progress(130_000_000, 130_000_000)
    updater.finish()
    await flush()
    expect(inst.state()).toMatchObject({
      phase: 'downloaded',
      version: '0.1.3',
      transferred: 130_000_000
    })
    expect(events.at(-1)?.phase).toBe('downloaded')

    await inst.install()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('merges progress events closer than 250 ms (always emits the final one)', async () => {
    const inst = installer()
    inst.download('0.1.3')
    await flush()
    const before = events.length
    now += 10
    updater.progress(1, 100)
    now += 10
    updater.progress(2, 100)
    expect(events.length).toBe(before)
    updater.progress(100, 100)
    expect(events.length).toBe(before + 1)
    expect(inst.state().transferred).toBe(100)
  })

  it('takes the newer version latest.yml offers', async () => {
    updater.feedVersion = '0.1.4'
    const inst = installer()
    inst.download('0.1.3')
    await flush()
    expect(inst.state()).toMatchObject({ phase: 'downloading', version: '0.1.4' })
  })

  it('cancel: back to idle, the token is cancelled and late events are ignored', async () => {
    const inst = installer()
    inst.download('0.1.3')
    await flush()
    const token = updater.token!
    expect(inst.cancel()).toMatchObject({ phase: 'idle', cancelled: true })
    expect(token.cancelled).toBe(true)
    await flush()
    updater.progress(5, 10)
    updater.finish()
    await flush()
    expect(inst.state()).toMatchObject({ phase: 'idle', cancelled: true })
    await expect(inst.install()).rejects.toThrow(/todavía no se ha descargado/)
    // It can start again afterwards.
    inst.download('0.1.3')
    await flush()
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2)
  })

  it('a download error becomes a Spanish message with the manual download link', async () => {
    const inst = installer()
    inst.download('0.1.3')
    await flush()
    updater.fail(
      Object.assign(new Error('sha512 checksum mismatch, expected x, got y'), {
        code: 'ERR_CHECKSUM_MISMATCH'
      })
    )
    await flush()
    const state = inst.state()
    expect(state.phase).toBe('error')
    expect(state.error).toMatch(/no coincide con la suma sha512/)
    expect(state.manualUrl).toBe(`${RELEASES_BASE}/download/v0.1.3/ElectronDB-0.1.3-x64-setup.exe`)
    // Retry works from the error state.
    inst.download('0.1.3')
    expect(inst.state().phase).toBe('downloading')
  })

  it('a release without latest.yml (older releases) points to the manual download', async () => {
    updater.checkError = Object.assign(new Error('Cannot find latest.yml'), {
      code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
    })
    const inst = installer()
    inst.download('0.1.3')
    await flush()
    expect(inst.state()).toMatchObject({ phase: 'error' })
    expect(inst.state().error).toMatch(/falta latest\.yml/)

    updater.checkError = null
    updater.feedVersion = '0.1.2' // the feed is not newer than this copy
    inst.download('0.1.3')
    await flush()
    expect(inst.state().error).toMatch(/falta latest\.yml/)
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('refuses to quit while a restore runs, older or invalid versions and non self-updating copies', async () => {
    const inst = installer({ busyReason: () => 'Hay una restauración en curso («Nocturno»).' })
    inst.download('0.1.3')
    await flush()
    updater.finish()
    await flush()
    await expect(inst.install()).rejects.toThrow(/restauración en curso/)
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    expect(() => installer().download('0.1.2')).toThrow(/Ya tienes la versión/)
    expect(() => installer().download('latest')).toThrow(/no válida/)
    expect(() => installer({ mode: 'manual' }).download('0.1.3')).toThrow(/Descargar manualmente/)
    expect(() => installer({ mode: 'source' }).download('0.1.3')).toThrow()
  })
})

describe('updaterErrorMessage', () => {
  it('maps network, rate limit and disk errors to actionable Spanish', () => {
    expect(updaterErrorMessage(new Error('net::ERR_INTERNET_DISCONNECTED'))).toMatch(
      /conexión a Internet/
    )
    expect(updaterErrorMessage(Object.assign(new Error('x'), { code: 'HTTP_ERROR_429' }))).toMatch(
      /limitado/
    )
    expect(updaterErrorMessage(new Error('ENOSPC: no space left'))).toMatch(/espacio libre/)
    expect(updaterErrorMessage(new Error('weird'))).toMatch(/descárgala manualmente/)
  })
})

describe('UpdateInstaller (mac-dmg)', () => {
  let dir: string
  let events: UpdateInstallState[]
  const dmg = Buffer.from('dmg-bytes '.repeat(5000))
  const sum = createHash('sha256').update(dmg).digest('hex')
  const DMG = 'ElectronDB-0.1.3-arm64.dmg'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'electrondb-macupd-'))
    events = []
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function macInstaller(
    body: string,
    download: StreamDownload,
    openPath = vi.fn(async () => undefined)
  ) {
    const release = parseRelease(apiRelease({ body }))
    return {
      openPath,
      inst: new UpdateInstaller({
        mode: 'mac-dmg',
        currentVersion: '0.1.2',
        platform: 'darwin',
        arch: 'arm64',
        mac: { downloadsDir: () => dir, download, fetchText: vi.fn(), openPath },
        getRelease: () => release,
        emit: (s) => events.push(s),
        log: { info: vi.fn(), warn: vi.fn() }
      })
    }
  }

  const stream: StreamDownload = async () => ({
    status: 200,
    contentLength: dmg.length,
    body: (async function* () {
      yield dmg.subarray(0, 20000)
      yield dmg.subarray(20000)
    })()
  })

  async function until(check: () => boolean) {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 2))
  }

  it('downloads the dmg of this Mac, verifies SHA-256 and opens it', async () => {
    const { inst, openPath } = macInstaller(`${sum}  ${DMG}`, stream)
    inst.download('0.1.3')
    await until(() => inst.state().phase !== 'downloading')
    expect(inst.state()).toMatchObject({
      mode: 'mac-dmg',
      phase: 'downloaded',
      filePath: join(dir, DMG)
    })
    expect(readdirSync(dir)).toEqual([DMG])
    expect(openPath).toHaveBeenCalledWith(join(dir, DMG))
    await inst.install()
    expect(openPath).toHaveBeenCalledTimes(2)
  })

  it('refuses a release without a published checksum, and a mismatching file', async () => {
    const none = macInstaller('## Novedades', stream).inst
    none.download('0.1.3')
    await until(() => none.state().phase !== 'downloading')
    expect(none.state().phase).toBe('error')
    expect(none.state().error).toMatch(/no publica la suma SHA-256/)
    expect(none.state().manualUrl).toBe(`${RELEASES_BASE}/download/v0.1.3/${DMG}`)

    const bad = macInstaller(`${'0'.repeat(64)}  ${DMG}`, stream).inst
    bad.download('0.1.3')
    await until(() => bad.state().phase !== 'downloading')
    expect(bad.state().error).toMatch(/no coincide con la suma SHA-256/)
    expect(readdirSync(dir)).toEqual([])
  })
})
