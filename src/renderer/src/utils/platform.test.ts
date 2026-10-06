import { afterEach, describe, expect, it } from 'vitest'
import { applyPlatformClass, hostPlatform, isMac } from './platform'

function setBridgePlatform(platform: string | undefined): void {
  window.electronDB = { invoke: async () => undefined, on: () => () => {}, platform } as never
}

describe('platform', () => {
  afterEach(() => {
    window.electronDB = undefined as never
  })

  it('defaults to macOS when the bridge does not report a platform', () => {
    window.electronDB = undefined as never
    expect(hostPlatform()).toBe('darwin')
    expect(isMac()).toBe(true)
  })

  it('tags <html> for macOS without the window-controls class', () => {
    setBridgePlatform('darwin')
    const root = document.createElement('html')
    applyPlatformClass(root)
    expect(root.classList.contains('nd-platform-darwin')).toBe(true)
    expect(root.classList.contains('nd-window-controls')).toBe(false)
  })

  for (const os of ['win32', 'linux']) {
    it(`tags <html> on ${os} so the toolbar reserves room for the window controls`, () => {
      setBridgePlatform(os)
      expect(isMac()).toBe(false)
      const root = document.createElement('html')
      applyPlatformClass(root)
      expect(root.classList.contains(`nd-platform-${os}`)).toBe(true)
      expect(root.classList.contains('nd-window-controls')).toBe(true)
    })
  }
})
