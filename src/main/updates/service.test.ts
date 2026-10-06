import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunModeInfo } from './runMode'
import {
  AUTO_CHECK_INTERVAL_MS,
  LATEST_RELEASE_URL,
  sanitizeState,
  UPDATES_FILE,
  UpdateService,
  type FetchLike
} from './service'
import { apiRelease } from './testing'

const HOUR = 60 * 60 * 1000
const T0 = Date.parse('2026-10-06T09:00:00Z')

const PACKAGED: RunModeInfo = { runMode: 'packaged' }
const SOURCE: RunModeInfo = {
  runMode: 'source',
  source: { dir: '/w/ElectronDB', isGit: true, branch: 'main', commands: ['git pull'] }
}

function okFetch(payload: unknown = apiRelease()): ReturnType<typeof vi.fn> & FetchLike {
  return vi.fn(async () => ({
    status: 200,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload))
  })) as never
}

describe('UpdateService', () => {
  let dir: string
  let now: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'electrondb-updates-'))
    now = T0
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function service(
    fetch: FetchLike,
    extra: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}
  ) {
    return new UpdateService({
      stateDir: dir,
      currentVersion: '0.1.2',
      platform: 'darwin',
      arch: 'arm64',
      runMode: () => PACKAGED,
      fetch,
      now: () => now,
      ...extra
    })
  }

  it('sends a plain GET with the GitHub headers and no identifiers', async () => {
    const fetch = okFetch()
    await service(fetch).check(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as Parameters<FetchLike>
    expect(url).toBe(LATEST_RELEASE_URL)
    expect(url).toBe('https://api.github.com/repos/Y0rshB3/ElectronDB/releases/latest')
    expect(init.method).toBe('GET')
    expect(init.headers).toEqual({
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ElectronDB/0.1.2',
      'X-GitHub-Api-Version': '2022-11-28'
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('reports an available version with the download for this machine', async () => {
    const result = await service(okFetch()).check(true)
    expect(result).toMatchObject({
      status: 'available',
      currentVersion: '0.1.2',
      latestVersion: '0.1.3',
      releaseName: 'ElectronDB v0.1.3',
      releaseUrl: 'https://github.com/Y0rshB3/ElectronDB/releases/tag/v0.1.3',
      publishedAt: '2026-10-01T10:00:00Z',
      notes: '## Novedades\n\n- Algo nuevo',
      runMode: 'packaged',
      dismissed: false,
      checkedAt: new Date(T0).toISOString()
    })
    expect(result.download?.fileName).toBe('ElectronDB-0.1.3-arm64.dmg')
    expect(result.alternatives?.map((a) => a.fileName)).toEqual(['ElectronDB-0.1.3-arm64-mac.zip'])
    expect(result.source).toBeUndefined()
  })

  it('includes the folder and commands in source mode', async () => {
    const result = await service(okFetch(), { runMode: () => SOURCE }).check(true)
    expect(result).toMatchObject({ status: 'available', runMode: 'source', source: SOURCE.source })
  })

  it('is up to date when the release is not newer or not usable', async () => {
    expect(await service(okFetch(apiRelease({ tag_name: 'v0.1.2' }))).check(true)).toMatchObject({
      status: 'up-to-date',
      latestVersion: '0.1.2'
    })
    expect((await service(okFetch(apiRelease({ tag_name: 'v0.1.1' }))).check(true)).status).toBe(
      'up-to-date'
    )
    const draft = await service(okFetch(apiRelease({ draft: true }))).check(true)
    expect(draft.status).toBe('up-to-date')
    expect(draft.latestVersion).toBeUndefined()
    const pre = await service(okFetch(apiRelease({ tag_name: 'v0.2.0-beta.1' }))).check(true)
    expect(pre.status).toBe('up-to-date')
  })

  it('caches the answer in updates.json', async () => {
    await service(okFetch()).check(true)
    const doc = JSON.parse(readFileSync(join(dir, UPDATES_FILE), 'utf8'))
    expect(doc).toMatchObject({
      lastCheckedAt: new Date(T0).toISOString(),
      latestVersion: '0.1.3',
      dismissedVersion: null
    })
    expect(doc.release.version).toBe('0.1.3')
  })

  describe('6-hour throttle', () => {
    it('answers automatic checks from the cache for 6 hours, then asks again', async () => {
      const fetch = okFetch()
      const svc = service(fetch)
      expect((await svc.check(false)).status).toBe('available')
      expect(fetch).toHaveBeenCalledTimes(1)
      now = T0 + 5 * HOUR
      const cached = await svc.check(false)
      expect(cached).toMatchObject({ status: 'available', latestVersion: '0.1.3' })
      expect(cached.checkedAt).toBe(new Date(T0).toISOString())
      expect(fetch).toHaveBeenCalledTimes(1)
      now = T0 + AUTO_CHECK_INTERVAL_MS
      await svc.check(false)
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('survives restarts (state read from disk)', async () => {
      const fetch = okFetch()
      await service(fetch).check(false)
      now = T0 + HOUR
      expect((await service(fetch).check(false)).status).toBe('available')
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('always fetches on a manual check', async () => {
      const fetch = okFetch()
      const svc = service(fetch)
      await svc.check(false)
      now = T0 + 1000
      await svc.check(true)
      await svc.check(true)
      expect(fetch).toHaveBeenCalledTimes(3)
    })

    it('treats a clock moved backwards as stale', async () => {
      const fetch = okFetch()
      const svc = service(fetch)
      await svc.check(false)
      now = T0 - HOUR
      await svc.check(false)
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('skips the network on automatic checks when autoNetwork is off', async () => {
      const fetch = okFetch()
      const result = await service(fetch, { autoNetwork: false }).check(false)
      expect(fetch).not.toHaveBeenCalled()
      expect(result.status).toBe('up-to-date')
    })

    it('shares one request between concurrent checks', async () => {
      const fetch = okFetch()
      const svc = service(fetch)
      await Promise.all([svc.check(false), svc.check(true)])
      expect(fetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('dismissed version', () => {
    it('marks the dismissed version and shows a newer one again', async () => {
      const svc = service(okFetch())
      svc.dismiss('0.1.3')
      expect((await svc.check(true)).dismissed).toBe(true)
      const newer = service(okFetch(apiRelease({ tag_name: 'v0.1.4' })))
      expect(await newer.check(true)).toMatchObject({ latestVersion: '0.1.4', dismissed: false })
      expect(JSON.parse(readFileSync(join(dir, UPDATES_FILE), 'utf8')).dismissedVersion).toBe(
        '0.1.3'
      )
    })

    it('rejects invalid versions', () => {
      expect(() => service(okFetch()).dismiss('latest')).toThrow(/no válida/)
    })
  })

  describe('failures', () => {
    const failing = (impl: FetchLike) => service(impl)

    it.each([
      [403, /limitado/],
      [429, /limitado/],
      [404, /ninguna versión publicada/],
      [500, /HTTP 500/]
    ])('HTTP %i gives a clear message on a manual check', async (status, message) => {
      const result = await failing(async () => ({ status, text: async () => '{}' })).check(true)
      expect(result.status).toBe('error')
      expect(result.error).toMatch(message)
      expect(result.currentVersion).toBe('0.1.2')
    })

    it('reports offline and timeouts', async () => {
      const offline = await failing(async () => {
        throw new TypeError('net::ERR_INTERNET_DISCONNECTED')
      }).check(true)
      expect(offline.error).toMatch(/No se pudo contactar con GitHub/)
      const timeout = await failing(async () => {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
      }).check(true)
      expect(timeout.error).toMatch(/10 segundos/)
    })

    it.each(['not json', '[]', 'null', '"text"', '{"tag_name": '])(
      'never crashes on a malformed body (%s)',
      async (body) => {
        const result = await failing(okFetch(body)).check(true)
        expect(result.status).toBe('error')
        expect(result.error).toMatch(/formato esperado/)
      }
    )

    it('does not record a failed check, so the next start retries', async () => {
      const svc = failing(async () => ({ status: 429, text: async () => '' }))
      expect((await svc.check(false)).status).toBe('error')
      expect(svc.state.lastCheckedAt).toBeNull()
    })

    it('falls back to the cached release on an automatic check', async () => {
      await service(okFetch()).check(true)
      now = T0 + 7 * HOUR
      const result = await failing(async () => {
        throw new TypeError('offline')
      }).check(false)
      expect(result).toMatchObject({ status: 'available', latestVersion: '0.1.3' })
    })
  })

  it('ignores a corrupt or hand-edited updates.json', async () => {
    writeFileSync(
      join(dir, UPDATES_FILE),
      JSON.stringify({
        lastCheckedAt: 'never',
        latestVersion: 'x',
        dismissedVersion: 3,
        release: {
          version: '9.9.9',
          tag: 'v9.9.9',
          name: 'x',
          htmlUrl: 'https://evil.com',
          notes: '',
          assets: []
        }
      })
    )
    const fetch = okFetch()
    const svc = service(fetch)
    expect(svc.state).toEqual({
      lastCheckedAt: null,
      latestVersion: null,
      dismissedVersion: null,
      release: null,
      snoozedUntil: null,
      lastSeenVersion: null
    })
    await svc.check(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(sanitizeState('nope').release).toBeNull()
  })

  describe('«Más tarde»', () => {
    it('marks automatic answers as snoozed for 6 hours, then shows again', async () => {
      const fetch = okFetch()
      const svc = service(fetch, { currentVersion: '0.1.2' })
      expect((await svc.check(false)).snoozed).toBeUndefined()
      svc.snooze()
      expect((await svc.check(false)).snoozed).toBe(true)
      expect(JSON.parse(readFileSync(join(dir, UPDATES_FILE), 'utf8')).snoozedUntil).toBe(
        new Date(T0 + AUTO_CHECK_INTERVAL_MS).toISOString()
      )
      now = T0 + AUTO_CHECK_INTERVAL_MS + 1
      const later = await service(fetch, { currentVersion: '0.1.2' }).check(false)
      expect(later.status).toBe('available')
      expect(later.snoozed).toBeUndefined()
    })
  })

  describe('«novedades» after an update', () => {
    const svcAt = (version: string) => service(okFetch(), { currentVersion: version })
    const stored = () => JSON.parse(readFileSync(join(dir, UPDATES_FILE), 'utf8')).lastSeenVersion

    it('fresh profile: records the version and shows nothing', () => {
      expect(svcAt('0.1.4').whatsNew({ profileHadData: false })).toBeNull()
      expect(stored()).toBe('0.1.4')
      expect(svcAt('0.1.4').whatsNew({ profileHadData: false })).toBeNull()
    })

    it('profile from a build without the feature: highlights of the current version only', () => {
      const info = svcAt('0.1.4').whatsNew({ profileHadData: true })
      expect(info?.previousVersion).toBeNull()
      expect(info?.entries.map((e) => e.version)).toEqual(['0.1.4'])
      expect(info?.releaseUrl).toBe('https://github.com/Y0rshB3/ElectronDB/releases/tag/v0.1.4')
    })

    it('upgrade over several versions lists each one, newest first, until marked seen', () => {
      svcAt('0.1.2').markSeen('0.1.2')
      const svc = svcAt('0.1.4')
      const info = svc.whatsNew({ profileHadData: true })
      expect(info?.previousVersion).toBe('0.1.2')
      expect(info?.entries.map((e) => e.version)).toEqual(['0.1.4', '0.1.3'])
      // not seen yet: a restart before closing the popup shows it again
      expect(svcAt('0.1.4').whatsNew({ profileHadData: true })).not.toBeNull()
      svc.markSeen('0.1.4')
      expect(stored()).toBe('0.1.4')
      expect(svcAt('0.1.4').whatsNew({ profileHadData: true })).toBeNull()
    })

    it('same version, downgrade and versions without curated notes show nothing', () => {
      svcAt('0.1.3').markSeen('0.1.3')
      expect(svcAt('0.1.3').whatsNew({ profileHadData: true })).toBeNull()
      expect(svcAt('0.1.2').whatsNew({ profileHadData: true })).toBeNull()
      expect(stored()).toBe('0.1.2')
      // 0.1.2 -> 9.0.0 has curated entries (0.1.3, 0.1.4) in between
      expect(svcAt('9.0.0').whatsNew({ profileHadData: true })?.entries.length).toBeGreaterThan(0)
      svcAt('9.0.0').markSeen('9.0.0')
      expect(svcAt('9.0.1').whatsNew({ profileHadData: true })).toBeNull()
      expect(stored()).toBe('9.0.1')
    })

    it('accepts test overrides and rejects invalid versions', () => {
      const info = svcAt('0.1.3').whatsNew({
        profileHadData: true,
        currentVersion: '0.1.4',
        previousVersion: '0.1.2'
      })
      expect(info?.currentVersion).toBe('0.1.4')
      expect(info?.entries.map((e) => e.version)).toEqual(['0.1.4', '0.1.3'])
      expect(() => svcAt('0.1.3').markSeen('nope')).toThrow(/no válida/)
      writeFileSync(
        join(dir, UPDATES_FILE),
        JSON.stringify({ lastSeenVersion: 'x', snoozedUntil: 5 })
      )
      expect(
        sanitizeState(JSON.parse(readFileSync(join(dir, UPDATES_FILE), 'utf8')))
      ).toMatchObject({
        lastSeenVersion: null,
        snoozedUntil: null
      })
    })
  })
})
