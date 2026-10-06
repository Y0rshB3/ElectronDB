import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it } from 'vitest'
import { buildAppMenuTemplate, RENDERER_ACCELERATORS } from './menu'

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])
  ])
}

describe('buildAppMenuTemplate', () => {
  for (const dev of [false, true]) {
    it(`never binds Cmd+W or Cmd+R (dev=${dev})`, () => {
      const items = flatten(buildAppMenuTemplate({ appName: 'ElectronDB', dev }))
      const accelerators = items.map((i) => i.accelerator).filter(Boolean)
      for (const forbidden of RENDERER_ACCELERATORS) expect(accelerators).not.toContain(forbidden)
      // roles with a default Cmd+W / Cmd+R accelerator must carry an explicit other one
      for (const item of items) {
        if (item.role === 'close' || item.role === 'reload' || item.role === 'forceReload') {
          expect(item.accelerator).toBeTruthy()
        }
      }
    })
  }

  it('keeps reload and devtools out of production builds', () => {
    const roles = flatten(buildAppMenuTemplate({ appName: 'ElectronDB', dev: false })).map(
      (i) => i.role
    )
    expect(roles).not.toContain('reload')
    expect(roles).not.toContain('forceReload')
    expect(roles).not.toContain('toggleDevTools')
    expect(roles).toContain('copy')
    expect(roles).toContain('paste')
    expect(roles).toContain('quit')
  })
})
