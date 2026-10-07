import { describe, expect, it } from 'vitest'
import { isAllowedReleaseUrl, parseRelease, pickAssets, truncateNotes } from './release'
import { apiRelease, RELEASE_ASSETS, RELEASES_BASE } from './testing'

const BASE = RELEASES_BASE
const ASSETS = RELEASE_ASSETS

describe('isAllowedReleaseUrl', () => {
  it('accepts release pages and downloads of the repository', () => {
    expect(isAllowedReleaseUrl(`${BASE}/tag/v0.1.3`)).toBe(true)
    expect(isAllowedReleaseUrl(`${BASE}/download/v0.1.3/Vortaq-0.1.3-arm64.dmg`)).toBe(true)
    expect(isAllowedReleaseUrl('https://github.com/y0rshb3/electrondb/releases/latest')).toBe(true)
  })

  it('rejects everything else', () => {
    for (const bad of [
      'http://github.com/Y0rshB3/ElectronDB/releases/tag/v1.0.0',
      'https://github.com.evil.com/Y0rshB3/ElectronDB/releases/tag/v1',
      'https://evil.com/Y0rshB3/ElectronDB/releases/tag/v1',
      'https://user:pw@github.com/Y0rshB3/ElectronDB/releases/tag/v1',
      'https://github.com:8443/Y0rshB3/ElectronDB/releases/tag/v1',
      'https://github.com/Y0rshB3/ElectronDB/releases/',
      'https://github.com/Y0rshB3/ElectronDB/issues/1',
      'https://github.com/Other/Vortaq/releases/tag/v1',
      'https://github.com/Y0rshB3/ElectronDB/releases/../../../evil/repo/releases/x',
      'https://github.com/Y0rshB3/ElectronDBX/releases/tag/v1',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url',
      '',
      null,
      42
    ])
      expect(isAllowedReleaseUrl(bad), String(bad)).toBe(false)
  })
})

describe('parseRelease', () => {
  it('parses the GitHub payload', () => {
    const r = parseRelease(apiRelease())!
    expect(r.version).toBe('0.1.3')
    expect(r.tag).toBe('v0.1.3')
    expect(r.name).toBe('Vortaq v0.1.3')
    expect(r.htmlUrl).toBe(`${BASE}/tag/v0.1.3`)
    expect(r.publishedAt).toBe('2026-10-01T10:00:00Z')
    expect(r.assets).toHaveLength(8)
  })

  it('ignores drafts, pre-releases and invalid tags', () => {
    expect(parseRelease(apiRelease({ draft: true }))).toBeNull()
    expect(parseRelease(apiRelease({ prerelease: true }))).toBeNull()
    expect(parseRelease(apiRelease({ tag_name: 'v0.2.0-beta.1' }))).toBeNull()
    expect(parseRelease(apiRelease({ tag_name: 'nightly' }))).toBeNull()
    expect(parseRelease(apiRelease({ tag_name: undefined }))).toBeNull()
  })

  it('survives malformed payloads', () => {
    for (const bad of [null, undefined, 'x', 42, [], [apiRelease()], { message: 'Not Found' }])
      expect(parseRelease(bad)).toBeNull()
    expect(parseRelease(apiRelease({ html_url: 'https://evil.com/x' }))).toBeNull()
    const r = parseRelease(
      apiRelease({
        name: 7,
        body: { not: 'text' },
        published_at: 'yesterday',
        assets: [
          null,
          'x',
          { name: 'ok.dmg', size: -3, browser_download_url: `${BASE}/download/v0.1.3/ok.dmg` },
          { name: 'evil.dmg', size: 1, browser_download_url: 'https://evil.com/evil.dmg' },
          { name: 5, browser_download_url: `${BASE}/download/v0.1.3/x` }
        ]
      })
    )!
    expect(r.name).toBe('Vortaq v0.1.3')
    expect(r.notes).toBe('')
    expect(r.publishedAt).toBeNull()
    expect(r.assets).toEqual([{ name: 'ok.dmg', url: `${BASE}/download/v0.1.3/ok.dmg`, size: 0 }])
    expect(parseRelease(apiRelease({ assets: 'nope' }))?.assets).toEqual([])
  })

  it('truncates long notes', () => {
    const body = Array.from({ length: 400 }, (_, i) => `- línea ${i} con algo de texto`).join('\n')
    const notes = parseRelease(apiRelease({ body }))!.notes
    expect(notes.length).toBeLessThanOrEqual(4004)
    expect(notes.endsWith('…')).toBe(true)
    expect(truncateNotes('a\r\nb')).toBe('a\nb')
  })
})

describe('pickAssets', () => {
  const names = (r: ReturnType<typeof pickAssets>) => [
    r.download?.fileName ?? null,
    ...r.alternatives.map((a) => a.fileName)
  ]

  it('picks the dmg of the right architecture on macOS', () => {
    expect(names(pickAssets(ASSETS, 'darwin', 'arm64'))).toEqual([
      'Vortaq-0.1.3-arm64.dmg',
      'Vortaq-0.1.3-arm64-mac.zip'
    ])
    expect(names(pickAssets(ASSETS, 'darwin', 'x64'))).toEqual([
      'Vortaq-0.1.3-x64.dmg',
      'Vortaq-0.1.3-x64-mac.zip'
    ])
  })

  it('picks the setup on Windows and offers the portable', () => {
    const r = pickAssets(ASSETS, 'win32', 'x64')
    expect(names(r)).toEqual(['Vortaq-0.1.3-x64-setup.exe', 'Vortaq-0.1.3-x64-portable.exe'])
    expect(r.download).toMatchObject({ sizeBytes: 100, label: 'Instalador (.exe)' })
  })

  it('picks the AppImage on Linux and offers the .deb', () => {
    expect(names(pickAssets(ASSETS, 'linux', 'x64'))).toEqual([
      'Vortaq-0.1.3-x86_64.AppImage',
      'vortaq_0.1.3_amd64.deb'
    ])
  })

  it('returns no download when nothing matches (the UI falls back to the release page)', () => {
    expect(pickAssets(ASSETS, 'linux', 'arm64')).toEqual({ download: null, alternatives: [] })
    expect(pickAssets(ASSETS, 'freebsd', 'x64')).toEqual({ download: null, alternatives: [] })
    expect(pickAssets([], 'darwin', 'arm64').download).toBeNull()
  })
})
