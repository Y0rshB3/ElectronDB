import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import type { StartupNotice } from '@shared/types'
import { useUiStore } from '@renderer/stores/ui'
import { mockBridge } from '@renderer/views/__tests__/helpers'
import { showStartupNotices } from './useAppBootstrap'

const trashNotice: StartupNotice = {
  id: 'legacy-app-installed',
  level: 'info',
  title: 'ElectronDB sigue instalado',
  message: 'La aplicación ElectronDB sigue en /Applications/ElectronDB.app.',
  action: { kind: 'trashLegacyApp', label: 'Mover ElectronDB a la Papelera' }
}

describe('«ElectronDB sigue instalado» startup notice', () => {
  beforeEach(() => setActivePinia(createPinia()))

  const run = async (answer: boolean) => {
    const invoke = mockBridge({
      'app:startupNotices': () => [trashNotice],
      'app:dismissStartupNotice': () => undefined,
      'app:trashLegacyApp': () => ({ trashed: ['/Applications/ElectronDB.app'] })
    })
    const done = showStartupNotices()
    await flushPromises()
    const ui = useUiStore()
    expect(ui.confirm).toMatchObject({
      open: true,
      title: 'ElectronDB sigue instalado',
      confirmText: 'Mover ElectronDB a la Papelera',
      cancelText: 'Ahora no'
    })
    ui.answer(answer)
    await done
    return invoke.mock.calls.map((c) => c[0])
  }

  it('moves the app to the Trash only after the click, and shows the notice once', async () => {
    const channels = await run(true)
    expect(channels).toContain('app:dismissStartupNotice')
    expect(channels).toContain('app:trashLegacyApp')
  })

  it('«Ahora no» dismisses the notice without touching the app', async () => {
    const channels = await run(false)
    expect(channels).toContain('app:dismissStartupNotice')
    expect(channels).not.toContain('app:trashLegacyApp')
  })
})
