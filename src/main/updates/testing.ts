import type { ReleaseAsset } from './release'

/** Test data for the updates module (never the real GitHub API). */
export const RELEASES_BASE = 'https://github.com/Y0rshB3/ElectronDB/releases'

export const releaseAsset = (name: string, size = 100, tag = 'v0.1.3'): ReleaseAsset => ({
  name,
  url: `${RELEASES_BASE}/download/${tag}/${name}`,
  size
})

/** Artifact names as electron-builder publishes them (checked against the real v0.1.2 release). */
export const RELEASE_ASSETS: ReleaseAsset[] = [
  'Vortaq-0.1.3-arm64-mac.zip',
  'Vortaq-0.1.3-arm64.dmg',
  'Vortaq-0.1.3-x64-mac.zip',
  'Vortaq-0.1.3-x64-portable.exe',
  'Vortaq-0.1.3-x64-setup.exe',
  'Vortaq-0.1.3-x64.dmg',
  'Vortaq-0.1.3-x86_64.AppImage',
  'vortaq_0.1.3_amd64.deb'
].map((n) => releaseAsset(n))

/** A /releases/latest payload in GitHub's shape. */
export function apiRelease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v0.1.3',
    name: 'Vortaq v0.1.3',
    draft: false,
    prerelease: false,
    html_url: `${RELEASES_BASE}/tag/v0.1.3`,
    published_at: '2026-10-01T10:00:00Z',
    body: '## Novedades\n\n- Algo nuevo',
    assets: RELEASE_ASSETS.map((a) => ({
      name: a.name,
      size: a.size,
      browser_download_url: a.url
    })),
    ...overrides
  }
}
