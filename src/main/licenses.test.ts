import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aboutPanelOptions, licenseFilePaths, readLicenses, REPOSITORY_URL } from './licenses'

describe('licenses', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-licenses-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads both files from the resources folder when packaged', () => {
    writeFileSync(join(dir, 'LICENSE'), 'MIT License')
    writeFileSync(join(dir, 'THIRD_PARTY_LICENSES.txt'), 'vue 3')
    expect(readLicenses({ packaged: true, resourcesPath: dir, appPath: '/nope' })).toEqual({
      license: 'MIT License',
      thirdParty: 'vue 3',
      thirdPartyPath: join(dir, 'THIRD_PARTY_LICENSES.txt'),
      repositoryUrl: 'https://github.com/Y0rshB3/ElectronDB'
    })
  })

  it('uses the project LICENSE and out/ in development, null when not built yet', () => {
    writeFileSync(join(dir, 'LICENSE'), 'MIT License')
    expect(licenseFilePaths({ packaged: false, resourcesPath: '/r', appPath: dir })).toEqual({
      license: join(dir, 'LICENSE'),
      thirdParty: join(dir, 'out', 'THIRD_PARTY_LICENSES.txt')
    })
    const missing = readLicenses({ packaged: false, resourcesPath: '/r', appPath: dir })
    expect(missing).toMatchObject({
      license: 'MIT License',
      thirdParty: null,
      thirdPartyPath: null
    })
    mkdirSync(join(dir, 'out'))
    writeFileSync(join(dir, 'out', 'THIRD_PARTY_LICENSES.txt'), 'notices')
    expect(readLicenses({ packaged: false, resourcesPath: '/r', appPath: dir }).thirdParty).toBe(
      'notices'
    )
  })

  it('fills the native About panel', () => {
    expect(aboutPanelOptions({ version: '0.2.0', electron: '44.3.0' })).toMatchObject({
      applicationName: 'Vortaq',
      applicationVersion: '0.2.0',
      version: 'Electron 44.3.0',
      copyright: expect.stringContaining('MIT'),
      website: REPOSITORY_URL
    })
  })

  it('points at the project repository', () => {
    expect(REPOSITORY_URL).toBe('https://github.com/Y0rshB3/ElectronDB')
  })
})
