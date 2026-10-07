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
      const items = flatten(buildAppMenuTemplate({ appName: 'Vortaq', dev }))
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
    const roles = flatten(buildAppMenuTemplate({ appName: 'Vortaq', dev: false })).map(
      (i) => i.role
    )
    expect(roles).not.toContain('reload')
    expect(roles).not.toContain('forceReload')
    expect(roles).not.toContain('toggleDevTools')
    expect(roles).toContain('copy')
    expect(roles).toContain('paste')
    expect(roles).toContain('quit')
  })
  it('offers «Buscar actualizaciones…» in the app menu when a handler is given', () => {
    let calls = 0
    const items = flatten(
      buildAppMenuTemplate({ appName: 'Vortaq', dev: false, onCheckUpdates: () => calls++ })
    )
    const item = items.find((i) => i.label === 'Buscar actualizaciones…')
    expect(item).toBeTruthy()
    ;(item!.click as () => void)()
    expect(calls).toBe(1)
    const without = flatten(buildAppMenuTemplate({ appName: 'Vortaq', dev: false }))
    expect(without.some((i) => i.label === 'Buscar actualizaciones…')).toBe(false)
  })
})
