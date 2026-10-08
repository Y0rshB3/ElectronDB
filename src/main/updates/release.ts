import type { UpdateAsset } from '@shared/types'
import { LEGACY_UPDATE_REPOS, UPDATE_REPO } from '../brand'
import { formatVersion, parseVersion } from './semver'

/**
 * Parsing of the GitHub "latest release" response and choice of the download
 * for this machine. Everything coming from the network is treated as
 * untrusted: unknown shapes are dropped, URLs are checked against the
 * repository's release URLs and texts are length-bounded.
 * Pure (no electron) so it is unit tested.
 */

export const NOTES_MAX_CHARS = 4000
const NAME_MAX_CHARS = 200

export interface ReleaseAsset {
  name: string
  url: string
  size: number
}

export interface ParsedRelease {
  /** Normalised version (no "v"). */
  version: string
  tag: string
  name: string
  htmlUrl: string
  publishedAt: string | null
  notes: string
  assets: ReleaseAsset[]
}

const KNOWN_REPOS = [UPDATE_REPO, ...LEGACY_UPDATE_REPOS]
/** /<owner>/<repo>/releases/ of the repository, under its current and earlier names. */
const REPO_PATHS = KNOWN_REPOS.map((r) => `/${r.owner}/${r.name}/releases/`.toLowerCase())

/**
 * True for https://github.com/<owner>/<repo>/releases/... (release pages and
 * asset downloads of this repository, Y0rshB3/Vortaq or its earlier name
 * Y0rshB3/ElectronDB). The only URLs main opens in the browser.
 */
export function isAllowedReleaseUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 2048) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === 'github.com' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    REPO_PATHS.some(
      (path) => url.pathname.toLowerCase().startsWith(path) && url.pathname.length > path.length
    )
  )
}

/**
 * The repository name a release URL uses (current or earlier name), for electron-updater's feed:
 * a release found under the earlier name (published before the rename) is downloaded from there.
 * UPDATE_REPO for anything else.
 */
export function releaseRepo(htmlUrl: string | null | undefined): { owner: string; name: string } {
  if (!isAllowedReleaseUrl(htmlUrl)) return UPDATE_REPO
  const path = new URL(htmlUrl).pathname.toLowerCase()
  return KNOWN_REPOS.find((_, i) => path.startsWith(REPO_PATHS[i])) ?? UPDATE_REPO
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** Cuts `text` to `max` characters on a line break when possible, marking the cut. */
export function truncateNotes(text: string, max = NOTES_MAX_CHARS): string {
  const clean = text.replace(/\r\n?/g, '\n').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max)
  const lastBreak = cut.lastIndexOf('\n')
  return `${(lastBreak > max * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd()}\n\n…`
}

/**
 * Release from the /releases/latest payload, or null when it is not usable
 * (draft, pre-release, invalid tag, missing/foreign release URL, not an object).
 */
export function parseRelease(payload: unknown): ParsedRelease | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const r = payload as Record<string, unknown>
  if (r.draft === true || r.prerelease === true) return null
  const tag = str(r.tag_name)
  const parsed = parseVersion(tag)
  if (!tag || !parsed) return null
  // A tag like v1.0.0-rc.1 published as a full release is still a pre-release.
  if (parsed.prerelease.length) return null
  const htmlUrl = str(r.html_url)
  if (!isAllowedReleaseUrl(htmlUrl)) return null

  const assets: ReleaseAsset[] = []
  if (Array.isArray(r.assets)) {
    for (const a of r.assets) {
      if (!a || typeof a !== 'object') continue
      const asset = a as Record<string, unknown>
      const name = str(asset.name)
      const url = str(asset.browser_download_url)
      if (!name || name.length > NAME_MAX_CHARS || !isAllowedReleaseUrl(url)) continue
      const size = typeof asset.size === 'number' && asset.size >= 0 ? asset.size : 0
      assets.push({ name, url, size })
    }
  }

  const name = (str(r.name) ?? '').trim().slice(0, NAME_MAX_CHARS)
  const published = str(r.published_at)
  return {
    version: formatVersion(parsed),
    tag,
    name: name || `Vortaq ${tag}`,
    htmlUrl,
    publishedAt: published && !Number.isNaN(Date.parse(published)) ? published : null,
    notes: truncateNotes(str(r.body) ?? ''),
    assets
  }
}

interface AssetRule {
  test: RegExp
  label: string
}

/** Preferred download first, then alternatives, per OS (electron-builder artifact names). */
function rulesFor(platform: string, arch: string): AssetRule[] {
  switch (platform) {
    case 'darwin':
      return arch === 'arm64'
        ? [
            { test: /-arm64\.dmg$/i, label: 'Imagen de disco (.dmg)' },
            { test: /-arm64-mac\.zip$/i, label: 'Archivo .zip' }
          ]
        : [
            { test: /-x64\.dmg$/i, label: 'Imagen de disco (.dmg)' },
            { test: /-x64-mac\.zip$/i, label: 'Archivo .zip' }
          ]
    case 'win32':
      // Only x64 builds are published; Windows on ARM runs them emulated.
      return [
        { test: /-x64-setup\.exe$/i, label: 'Instalador (.exe)' },
        { test: /-x64-portable\.exe$/i, label: 'Portable (.exe)' }
      ]
    case 'linux':
      return arch === 'arm64'
        ? [
            { test: /-arm64\.AppImage$/i, label: 'AppImage' },
            { test: /_arm64\.deb$/i, label: 'Paquete .deb' }
          ]
        : [
            { test: /-x86_64\.AppImage$/i, label: 'AppImage' },
            { test: /_amd64\.deb$/i, label: 'Paquete .deb' }
          ]
    default:
      return []
  }
}

const toUpdateAsset = (a: ReleaseAsset, label: string): UpdateAsset => ({
  url: a.url,
  fileName: a.name,
  sizeBytes: a.size,
  label
})

/**
 * The download for this OS/architecture and its alternatives. `download` is
 * null when nothing matches (the UI then offers the release page).
 */
export function pickAssets(
  assets: ReleaseAsset[],
  platform: string,
  arch: string
): { download: UpdateAsset | null; alternatives: UpdateAsset[] } {
  const found: UpdateAsset[] = []
  for (const rule of rulesFor(platform, arch)) {
    const match = assets.find((a) => rule.test.test(a.name))
    if (match) found.push(toUpdateAsset(match, rule.label))
  }
  return { download: found[0] ?? null, alternatives: found.slice(1) }
}
