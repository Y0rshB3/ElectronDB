import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bundleOf, installedLegacyApps, legacyAppCandidates, legacyAppNotice } from './legacyApp'

const plist = (executable: string) =>
  `<?xml version="1.0"?><plist><dict><key>CFBundleExecutable</key>\n\t<string>${executable}</string><key>CFBundleIdentifier</key><string>dev.y0rshb3.electrondb</string></dict></plist>`

describe('installedLegacyApps', () => {
  let root: string
  const bundle = (name: string, executable = name): string => {
    const dir = join(root, `${name}.app`)
    mkdirSync(join(dir, 'Contents'), { recursive: true })
    writeFileSync(join(dir, 'Contents', 'Info.plist'), plist(executable))
    return dir
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vortaq-legacy-app-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const base = { platform: 'darwin' as const, home: '/Users/x', scratchProfile: false, execPath: '/x' }

  it('finds ElectronDB bundles among the candidates', () => {
    const app = bundle('ElectronDB')
    expect(installedLegacyApps({ ...base, candidates: [app, join(root, 'Missing.app')] })).toEqual([app])
  })

  it('skips a bundle with the shared id that is not ElectronDB (Vortaq itself)', () => {
    const vortaq = bundle('ElectronDB', 'Vortaq')
    expect(installedLegacyApps({ ...base, candidates: [vortaq] })).toEqual([])
  })

  it('never offers the running app', () => {
    const app = bundle('ElectronDB')
    const execPath = join(app, 'Contents', 'MacOS', 'ElectronDB')
    expect(installedLegacyApps({ ...base, candidates: [app], execPath })).toEqual([])
  })

  it('a scratch profile without explicit candidates checks nothing; other platforms neither', () => {
    let read = 0
    const spy = (() => {
      read++
      return plist('ElectronDB')
    }) as never
    expect(installedLegacyApps({ ...base, scratchProfile: true, read: spy })).toEqual([])
    expect(installedLegacyApps({ ...base, platform: 'win32', read: spy })).toEqual([])
    expect(read).toBe(0)
  })

  it('checks /Applications and ~/Applications by default', () => {
    expect(legacyAppCandidates('/Users/x')).toEqual([
      '/Applications/ElectronDB.app',
      '/Users/x/Applications/ElectronDB.app'
    ])
    expect(bundleOf('/Applications/Vortaq.app/Contents/MacOS/Vortaq')).toBe('/Applications/Vortaq.app')
    expect(bundleOf('/usr/bin/node')).toBeNull()
  })

  it('the notice names the paths and offers the Trash button', () => {
    const notice = legacyAppNotice(['/Applications/ElectronDB.app'])
    expect(notice.action).toEqual({ kind: 'trashLegacyApp', label: 'Mover ElectronDB a la Papelera' })
    expect(notice.message).toContain('/Applications/ElectronDB.app')
  })
})
