import { describe, expect, it } from 'vitest'
import { badge, installerDownloads } from './download-badges.mjs'

describe('download badges', () => {
  it('counts installers only, not update metadata, blockmaps or checksums', () => {
    const release = {
      assets: [
        { name: 'Vortaq-2.0.1-arm64.dmg', download_count: 3 },
        { name: 'Vortaq-2.0.1-x64-setup.exe', download_count: 2 },
        { name: 'Vortaq-2.0.1-x86_64.AppImage', download_count: 1 },
        { name: 'vortaq_2.0.1_amd64.deb', download_count: 1 },
        { name: 'Vortaq-2.0.1-arm64-mac.zip', download_count: 1 },
        { name: 'latest.yml', download_count: 50 },
        { name: 'latest-mac.yml', download_count: 40 },
        { name: 'Vortaq-2.0.1-x64-setup.exe.blockmap', download_count: 9 },
        { name: 'SHA256SUMS.txt', download_count: 4 }
      ]
    }
    expect(installerDownloads(release)).toBe(8)
    expect(installerDownloads({})).toBe(0)
  })

  it('writes a shields.io endpoint badge', () => {
    expect(badge('descargas totales', 12, 'ec4899')).toEqual({
      schemaVersion: 1,
      label: 'descargas totales',
      message: '12',
      color: 'ec4899',
      cacheSeconds: 1800
    })
  })
})
