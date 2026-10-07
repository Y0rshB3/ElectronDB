import { describe, expect, it } from 'vitest'
import { detectInstallMode } from './installMode'

const base = { isPackaged: true, env: {}, isolatedProfile: false }

describe('detectInstallMode', () => {
  it('self-updates the Windows installer and the Linux AppImage', () => {
    expect(detectInstallMode({ ...base, platform: 'win32' })).toBe('auto')
    expect(
      detectInstallMode({ ...base, platform: 'linux', env: { APPIMAGE: '/home/u/E.AppImage' } })
    ).toBe('auto')
  })

  it('downloads a verified .dmg on macOS (no Developer ID for Squirrel.Mac)', () => {
    expect(detectInstallMode({ ...base, platform: 'darwin' })).toBe('mac-dmg')
  })

  it('falls back to the browser for the portable .exe, the .deb and unknown systems', () => {
    expect(
      detectInstallMode({
        ...base,
        platform: 'win32',
        env: { PORTABLE_EXECUTABLE_FILE: 'C:\\E\\ElectronDB.exe' }
      })
    ).toBe('manual')
    expect(detectInstallMode({ ...base, platform: 'linux' })).toBe('manual')
    expect(detectInstallMode({ ...base, platform: 'freebsd' })).toBe('manual')
  })

  it('never self-updates from source or with a scratch profile (smoke, screenshots)', () => {
    expect(detectInstallMode({ ...base, isPackaged: false, platform: 'win32' })).toBe('source')
    for (const platform of ['win32', 'darwin', 'linux'])
      expect(
        detectInstallMode({
          ...base,
          platform,
          env: { APPIMAGE: '/x.AppImage' },
          isolatedProfile: true
        })
      ).toBe('manual')
  })
})
