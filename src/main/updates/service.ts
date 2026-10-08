import { join } from 'node:path'
import type { UpdateCheckResult, UpdateInstallMode, WhatsNewInfo } from '@shared/types'
import { whatsNewBetween, whatsNewFor } from '@shared/whatsNew'
import { LEGACY_UPDATE_REPOS, UPDATE_REPO } from '../brand'
import { JsonStore } from '../storage/jsonStore'
import { isAllowedReleaseUrl, parseRelease, pickAssets, type ParsedRelease } from './release'
import type { RunModeInfo } from './runMode'
import { compareVersions, isNewer, parseVersion } from './semver'

/**
 * Checks GitHub Releases for a newer version. Only a GET of the public
 * "latest release" endpoint is made: no token, no identifiers, nothing about
 * the user's data. The last answer is cached in <profile>/updates.json so the
 * automatic check hits the API at most once every 6 hours; a manual check
 * always asks GitHub. This class never downloads anything: the in-app
 * download is UpdateInstaller (installer.ts), started only by the user.
 * Network access is injected (`fetch`) so it is unit tested without electron.
 */

export const UPDATES_FILE = 'updates.json'
const latestReleaseUrl = (r: { owner: string; name: string }): string =>
  `https://api.github.com/repos/${r.owner}/${r.name}/releases/latest`
export const LATEST_RELEASE_URL = latestReleaseUrl(UPDATE_REPO)
/**
 * Asked in order; the next one only when GitHub answers 404. Vortaq 2.0.0 is published while the
 * repository still has its earlier name (so ElectronDB 0.1.x copies, which accept only that name,
 * see it) and the repository is renamed later: until then Y0rshB3/Vortaq does not exist. After the
 * rename the first URL answers and the legacy one is never asked.
 */
export const LATEST_RELEASE_URLS = [UPDATE_REPO, ...LEGACY_UPDATE_REPOS].map(latestReleaseUrl)
export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
export const FETCH_TIMEOUT_MS = 10_000
/** A release payload is a few KB; anything far larger is not what we asked for. */
const MAX_BODY_CHARS = 2_000_000

export interface FetchResponseLike {
  status: number
  text(): Promise<string>
}

export type FetchLike = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal }
) => Promise<FetchResponseLike>

export interface UpdatesState {
  /** ISO date of the last successful answer from GitHub. */
  lastCheckedAt: string | null
  /** Version of that answer's release (null when there was no usable release). */
  latestVersion: string | null
  /** Version the user chose to skip («Omitir esta versión»). */
  dismissedVersion: string | null
  /** Release details of the last answer, to show the notice without asking again. */
  release: ParsedRelease | null
  /** «Más tarde»: no automatic popup before this ISO date. */
  snoozedUntil: string | null
  /** Last version whose «novedades» popup was shown (or that started on a fresh profile). */
  lastSeenVersion: string | null
}

const DEFAULT_STATE = (): UpdatesState => ({
  lastCheckedAt: null,
  latestVersion: null,
  dismissedVersion: null,
  release: null,
  snoozedUntil: null,
  lastSeenVersion: null
})

/** Drops anything in a hand-edited or old updates.json that does not look right. */
export function sanitizeState(raw: unknown): UpdatesState {
  const state = DEFAULT_STATE()
  if (!raw || typeof raw !== 'object') return state
  const r = raw as Record<string, unknown>
  if (typeof r.lastCheckedAt === 'string' && !Number.isNaN(Date.parse(r.lastCheckedAt)))
    state.lastCheckedAt = r.lastCheckedAt
  if (parseVersion(r.latestVersion)) state.latestVersion = r.latestVersion as string
  if (parseVersion(r.dismissedVersion)) state.dismissedVersion = r.dismissedVersion as string
  if (typeof r.snoozedUntil === 'string' && !Number.isNaN(Date.parse(r.snoozedUntil)))
    state.snoozedUntil = r.snoozedUntil
  if (parseVersion(r.lastSeenVersion)) state.lastSeenVersion = r.lastSeenVersion as string
  const rel = r.release as Partial<ParsedRelease> | null | undefined
  if (
    rel &&
    typeof rel === 'object' &&
    parseVersion(rel.version) &&
    typeof rel.tag === 'string' &&
    typeof rel.name === 'string' &&
    isAllowedReleaseUrl(rel.htmlUrl) &&
    typeof rel.notes === 'string' &&
    Array.isArray(rel.assets)
  ) {
    state.release = {
      version: rel.version as string,
      tag: rel.tag,
      name: rel.name,
      htmlUrl: rel.htmlUrl,
      publishedAt: typeof rel.publishedAt === 'string' ? rel.publishedAt : null,
      notes: rel.notes,
      assets: rel.assets.filter(
        (a) =>
          a &&
          typeof a.name === 'string' &&
          typeof a.size === 'number' &&
          isAllowedReleaseUrl(a.url)
      )
    }
  }
  return state
}

/** Why a check failed; mapped to a Spanish message for the manual check. */
export type CheckFailure =
  | { kind: 'network' }
  | { kind: 'timeout' }
  | { kind: 'rate-limited' }
  | { kind: 'not-found' }
  | { kind: 'http'; status: number }
  | { kind: 'malformed' }

export function failureMessage(failure: CheckFailure): string {
  switch (failure.kind) {
    case 'network':
      return 'No se pudo contactar con GitHub para buscar actualizaciones. Comprueba la conexión a Internet (o el proxy) e inténtalo de nuevo.'
    case 'timeout':
      return 'GitHub no respondió en 10 segundos. Comprueba la conexión e inténtalo de nuevo más tarde.'
    case 'rate-limited':
      return 'GitHub ha limitado temporalmente las consultas desde tu red. Vuelve a intentarlo dentro de un rato (el límite se renueva cada hora).'
    case 'not-found':
      return 'No hay ninguna versión publicada en GitHub todavía.'
    case 'http':
      return `GitHub respondió con un error (HTTP ${failure.status}). Inténtalo de nuevo más tarde.`
    case 'malformed':
      return 'La respuesta de GitHub no tiene el formato esperado. Inténtalo de nuevo más tarde o revisa la página de versiones.'
  }
}

class CheckError extends Error {
  constructor(readonly failure: CheckFailure) {
    super(failure.kind)
  }
}

export interface UpdateServiceOptions {
  /** Profile folder (updates.json lives there). */
  stateDir: string
  currentVersion: string
  platform: string
  arch: string
  /** Resolved lazily: only needed when a check runs. */
  runMode: () => RunModeInfo
  /** How this copy installs updates (see installMode.ts); reported to the UI. */
  installMode?: () => UpdateInstallMode
  fetch: FetchLike
  now?: () => number
  timeoutMs?: number
  /** False skips the network on automatic checks (smoke tests); the cache is still used. */
  autoNetwork?: boolean
}

export interface WhatsNewOptions {
  /** The profile already had connections or settings before this start. */
  profileHadData: boolean
  /** Test switches (scratch profile only): pretend these versions. */
  currentVersion?: string
  previousVersion?: string
}

export class UpdateService {
  private readonly store: JsonStore<UpdatesState>
  private readonly now: () => number
  private inFlight: Promise<ParsedRelease | null> | null = null
  private mode: RunModeInfo | null = null

  constructor(private readonly options: UpdateServiceOptions) {
    this.store = new JsonStore(join(options.stateDir, UPDATES_FILE), DEFAULT_STATE, sanitizeState)
    this.now = options.now ?? Date.now
  }

  get state(): UpdatesState {
    return this.store.get()
  }

  /**
   * Automatic (`manual` false): answers from the cache when it is younger than
   * 6 hours; failures fall back to the cache, else an 'error' result the UI
   * keeps quiet about. Manual: always asks GitHub.
   */
  async check(manual: boolean): Promise<UpdateCheckResult> {
    const state = this.store.get()
    if (!manual && (this.isFresh(state) || this.options.autoNetwork === false)) {
      return this.result(state.release, state.lastCheckedAt)
    }
    try {
      const release = await this.fetchOnce()
      return this.result(release, this.store.get().lastCheckedAt)
    } catch (err) {
      const failure: CheckFailure =
        err instanceof CheckError ? err.failure : { kind: 'malformed' as const }
      if (!manual && state.release) return this.result(state.release, state.lastCheckedAt)
      return { ...this.base(), status: 'error', error: failureMessage(failure) }
    }
  }

  /** «Omitir esta versión»: no automatic notice for `version` (a newer one shows again). */
  dismiss(version: string): void {
    if (!parseVersion(version)) throw new Error(`Versión no válida: ${String(version)}`)
    this.store.update((s) => {
      s.dismissedVersion = version
    })
  }

  /** «Más tarde»: the automatic popup stays quiet for the next 6 hours. */
  snooze(): void {
    this.store.update((s) => {
      s.snoozedUntil = new Date(this.now() + AUTO_CHECK_INTERVAL_MS).toISOString()
    })
  }

  /**
   * «Novedades» to show once after an update, or null. Never shown on a fresh
   * profile (the version is just recorded), for the same version or after a
   * downgrade. A profile with data but no recorded version (it ran a build
   * older than this feature) gets the highlights of the current version only.
   * The version is recorded as seen by markSeen() when the popup closes.
   */
  whatsNew(options: WhatsNewOptions): WhatsNewInfo | null {
    const current = options.currentVersion ?? this.options.currentVersion
    if (!parseVersion(current)) return null
    const previous = options.previousVersion ?? this.store.get().lastSeenVersion
    // The repository's earlier name: GitHub serves it before the rename to
    // Vortaq and redirects it afterwards, so the link works in both states
    // (and isAllowedReleaseUrl accepts it).
    const repo = LEGACY_UPDATE_REPOS[0] ?? UPDATE_REPO
    const releaseUrl = `https://github.com/${repo.owner}/${repo.name}/releases/tag/v${current}`
    if (!previous) {
      const entry = options.profileHadData ? whatsNewFor(current) : null
      if (!entry) {
        this.markSeen(current)
        return null
      }
      return { currentVersion: current, previousVersion: null, entries: [entry], releaseUrl }
    }
    const entries = whatsNewBetween(previous, current)
    if (!entries.length) {
      // Downgrade, unknown versions or nothing curated: remember the running version quietly.
      if (compareVersions(current, previous) !== 0) this.markSeen(current)
      return null
    }
    return { currentVersion: current, previousVersion: previous, entries, releaseUrl }
  }

  markSeen(version: string): void {
    if (!parseVersion(version)) throw new Error(`Versión no válida: ${String(version)}`)
    this.store.update((s) => {
      s.lastSeenVersion = version
    })
  }

  private isSnoozed(): boolean {
    const until = this.store.get().snoozedUntil
    return !!until && Date.parse(until) > this.now()
  }

  private isFresh(state: UpdatesState): boolean {
    if (!state.lastCheckedAt) return false
    const age = this.now() - Date.parse(state.lastCheckedAt)
    // A clock moved backwards also counts as stale.
    return age >= 0 && age < AUTO_CHECK_INTERVAL_MS
  }

  /** Concurrent checks (startup + menu) share one request. */
  private fetchOnce(): Promise<ParsedRelease | null> {
    if (!this.inFlight) {
      this.inFlight = this.fetchLatest().finally(() => {
        this.inFlight = null
      })
    }
    return this.inFlight
  }

  private async fetchLatest(): Promise<ParsedRelease | null> {
    let response: FetchResponseLike | null = null
    for (const url of LATEST_RELEASE_URLS) {
      response = await this.request(url)
      if (response.status !== 404) break
    }
    if (!response) throw new CheckError({ kind: 'not-found' })
    if (response.status === 403 || response.status === 429)
      throw new CheckError({ kind: 'rate-limited' })
    if (response.status === 404) throw new CheckError({ kind: 'not-found' })
    if (response.status !== 200) throw new CheckError({ kind: 'http', status: response.status })

    let payload: unknown
    try {
      const text = await response.text()
      if (text.length > MAX_BODY_CHARS) throw new Error('too large')
      payload = JSON.parse(text)
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      if (name === 'TimeoutError' || name === 'AbortError')
        throw new CheckError({ kind: 'timeout' })
      throw new CheckError({ kind: 'malformed' })
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new CheckError({ kind: 'malformed' })

    // A draft, pre-release or invalid tag is ignored: "no newer usable release".
    const release = parseRelease(payload)
    this.store.update((s) => {
      s.lastCheckedAt = new Date(this.now()).toISOString()
      s.latestVersion = release?.version ?? null
      s.release = release
    })
    return release
  }

  private async request(url: string): Promise<FetchResponseLike> {
    try {
      return await this.options.fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `Vortaq/${this.options.currentVersion}`,
          'X-GitHub-Api-Version': '2022-11-28'
        },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? FETCH_TIMEOUT_MS)
      })
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      throw new CheckError({
        kind: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network'
      })
    }
  }

  private runMode(): RunModeInfo {
    this.mode ??= this.options.runMode()
    return this.mode
  }

  /** The cached release of the last answer (used for the .dmg download and manual links). */
  latestRelease(): ParsedRelease | null {
    return this.store.get().release
  }

  private base(): Pick<UpdateCheckResult, 'currentVersion' | 'runMode' | 'source' | 'installMode'> {
    const mode = this.runMode()
    const installMode = this.options.installMode?.()
    return {
      currentVersion: this.options.currentVersion,
      runMode: mode.runMode,
      ...(installMode ? { installMode } : {}),
      ...(mode.source ? { source: mode.source } : {})
    }
  }

  private result(release: ParsedRelease | null, checkedAt: string | null): UpdateCheckResult {
    const base = { ...this.base(), ...(checkedAt ? { checkedAt } : {}) }
    if (!release) return { ...base, status: 'up-to-date' }
    const summary = {
      latestVersion: release.version,
      releaseName: release.name,
      releaseUrl: release.htmlUrl,
      ...(release.publishedAt ? { publishedAt: release.publishedAt } : {})
    }
    if (!isNewer(release.version, this.options.currentVersion))
      return { ...base, ...summary, status: 'up-to-date' }
    const { download, alternatives } = pickAssets(
      release.assets,
      this.options.platform,
      this.options.arch
    )
    return {
      ...base,
      ...summary,
      status: 'available',
      notes: release.notes,
      ...(download ? { download } : {}),
      alternatives,
      dismissed: this.store.get().dismissedVersion === release.version,
      ...(this.isSnoozed() ? { snoozed: true } : {})
    }
  }
}
