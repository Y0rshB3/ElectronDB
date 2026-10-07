import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { WhatsNewInfo } from '@shared/types'
import { whatsNewBetween } from '@shared/whatsNew'
import { MODAL_RETRY_MS } from '@renderer/composables/useModalQueue'
import { useUiStore } from '@renderer/stores/ui'
import { useWhatsNewStore } from '@renderer/stores/whatsNew'
import { useTourStore } from '@renderer/stores/tour'
import {
  createTestVuetify,
  flush,
  installBridge,
  installDomPolyfills,
  type MockBridge
} from '@renderer/__tests__/shellTestUtils'
import WhatsNewDialog from './WhatsNewDialog.vue'

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)
const URL = 'https://github.com/Y0rshB3/ElectronDB/releases/tag/v0.1.4'

const info = (): WhatsNewInfo => ({
  currentVersion: '0.1.4',
  previousVersion: '0.1.2',
  entries: whatsNewBetween('0.1.2', '0.1.4'),
  releaseUrl: URL
})

describe('WhatsNewDialog', () => {
  let bridge: MockBridge
  let wrapper: VueWrapper | null = null

  async function setup(answer: WhatsNewInfo | null = info()) {
    bridge = installBridge({
      'updates:whatsNew': answer,
      'updates:markSeen': undefined,
      'app:openExternal': undefined
    })
    wrapper = mount(WhatsNewDialog, {
      global: { plugins: [createTestVuetify()] },
      attachTo: document.body
    })
    return useWhatsNewStore()
  }
  const settle = async () => {
    for (let i = 0; i < 6; i++) await flush()
  }

  beforeEach(() => {
    installDomPolyfills()
    setActivePinia(createPinia())
    document.body.innerHTML = ''
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    vi.useRealTimers()
  })

  it('lists the highlights of every version in the range, grouped by version', async () => {
    const store = await setup()
    await store.load()
    await settle()
    expect(store.open).toBe(true)
    expect(q('[data-test="whats-new"] h2')!.textContent).toContain('Vortaq se actualizó a 0.1.4')
    expect(q('[data-test="whats-new-0.1.4"]')).not.toBeNull()
    expect(q('[data-test="whats-new-0.1.3"]')).not.toBeNull()
    expect(q('[data-test="whats-new-0.1.2"]')).toBeNull()
    expect(q('[data-test="whats-new-important"]')!.textContent).toContain('Ajustes › Seguridad')
  })

  it('«Entendido» closes it and records the version as seen', async () => {
    const store = await setup()
    await store.load()
    await settle()
    q<HTMLButtonElement>('[data-test="whats-new-ok"]')!.click()
    await settle()
    expect(store.open).toBe(false)
    expect(bridge.invoke).toHaveBeenCalledWith('updates:markSeen', '0.1.4')
  })

  it('dismissing it (Escape) also records the version as seen', async () => {
    const store = await setup()
    await store.load()
    await settle()
    q('.v-overlay__content')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    )
    await settle()
    expect(store.open).toBe(false)
    expect(bridge.invoke).toHaveBeenCalledWith('updates:markSeen', '0.1.4')
  })

  it('opens the release page through the allowlisted channel', async () => {
    const store = await setup()
    await store.load()
    await settle()
    q<HTMLButtonElement>('[data-test="whats-new-github"]')!.click()
    await settle()
    expect(bridge.invoke).toHaveBeenCalledWith('app:openExternal', URL)
  })

  it('shows nothing when main has nothing to show', async () => {
    const store = await setup(null)
    await store.load()
    await settle()
    expect(store.open).toBe(false)
    expect(q('[data-test="whats-new"]')).toBeNull()
    expect(bridge.invoke).not.toHaveBeenCalledWith('updates:markSeen', expect.anything())
  })

  it('waits for another modal to close and loads only once per start', async () => {
    vi.useFakeTimers()
    const store = await setup()
    const ui = useUiStore()
    const pending = ui.ask({ title: 'Aviso', message: '…', notice: true })
    await store.load()
    await vi.advanceTimersByTimeAsync(MODAL_RETRY_MS * 2)
    expect(store.open).toBe(false)
    ui.answer(true)
    await pending
    await vi.advanceTimersByTimeAsync(MODAL_RETRY_MS)
    expect(store.open).toBe(true)
    await store.load()
    expect(bridge.invoke.mock.calls.filter((c) => c[0] === 'updates:whatsNew')).toHaveLength(1)
  })

  it('«Mostrarme cómo» only appears when the versions shown have tour steps', async () => {
    const store = await setup()
    await store.load()
    await settle()
    // 0.1.3–0.1.4 have no steps.
    expect(q('[data-test="whats-new-show-me"]')).toBeNull()
  })

  it('«Mostrarme cómo» closes the popup (seen) and runs only those steps', async () => {
    vi.useFakeTimers()
    const store = await setup({
      currentVersion: '0.1.7',
      previousVersion: '0.1.6',
      entries: whatsNewBetween('0.1.6', '0.1.7'),
      releaseUrl: URL
    })
    await store.load()
    await vi.advanceTimersByTimeAsync(10)
    const button = q<HTMLButtonElement>('[data-test="whats-new-show-me"]')
    expect(button?.textContent).toContain('Mostrarme cómo')
    button!.click()
    await vi.advanceTimersByTimeAsync(10)
    expect(store.open).toBe(false)
    expect(bridge.invoke).toHaveBeenCalledWith('updates:markSeen', '0.1.7')
    // The dialog's closing overlay may still be in the DOM: the tour waits for it.
    await vi.advanceTimersByTimeAsync(MODAL_RETRY_MS * 3)
    const tour = useTourStore()
    expect(tour.active).toBe(true)
    expect(tour.kind).toBe('whatsNew')
    expect(tour.steps.map((s) => s.title)).toEqual([
      'Tour de bienvenida',
      'Detección automática de Navicat'
    ])
  })
})
