import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { NavicatCandidate } from '@shared/types'
import { MODAL_RETRY_MS, otherModalOpen, showWhenFree } from '@renderer/composables/useModalQueue'
import { useTourStore } from '@renderer/stores/tour'
import { useUiStore } from '@renderer/stores/ui'
import {
  createTestVuetify,
  flush,
  installBridge,
  installDomPolyfills,
  type MockBridge
} from '@renderer/__tests__/shellTestUtils'
import TourHost from './TourHost.vue'
import { WELCOME_FEATURE_STEPS } from './welcomeTour'

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)
const click = (sel: string) => q<HTMLElement>(sel)!.click()
const key = (k: string) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
const settle = async () => {
  for (let i = 0; i < 6; i++) await flush()
}

const STEPS = [
  { title: 'Uno', text: 'Primer paso.' },
  { target: 'toolbar-ai', title: 'Dos', text: 'Segundo paso.' },
  { target: 'nowhere', title: 'Tres', text: 'Tercer paso.' }
]

const NAVICAT: NavicatCandidate = {
  rootPath: '/Users/demo/Library/Application Support/PremiumSoft CyberTech/Navicat CC',
  source: 'default',
  connectionCount: 4,
  jobCount: 3,
  backupCount: 105,
  modifiedAt: '2026-10-01T10:00:00.000Z'
}

/** A visible element with `data-tour` (jsdom has no layout: rects are faked). */
function target(name: string): HTMLElement {
  const node = document.createElement('button')
  node.setAttribute('data-tour', name)
  const rect = { top: 10, left: 900, width: 32, height: 32, right: 932, bottom: 42, x: 900, y: 10 }
  node.getBoundingClientRect = () => rect as DOMRect
  node.getClientRects = () => [rect] as unknown as DOMRectList
  document.body.appendChild(node)
  return node
}

describe('TourHost + tour store', () => {
  let bridge: MockBridge
  let wrapper: VueWrapper | null = null

  function setup(handlers: Record<string, unknown> = {}) {
    bridge = installBridge({
      'tour:markWelcomeDone': {
        showWelcome: false,
        welcomeTourDone: true,
        tourSeenVersion: '0.1.7'
      },
      'navicat:findCandidates': { supportedPlatform: true, candidates: [] },
      ...handlers
    })
    wrapper = mount(TourHost, {
      global: { plugins: [createTestVuetify()] },
      attachTo: document.body
    })
    return useTourStore()
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

  it('navigates with Siguiente / Atrás and ends on Terminar', async () => {
    const tour = setup()
    const onEnd = vi.fn()
    tour.start(STEPS, { kind: 'whatsNew', onEnd })
    await settle()
    expect(q('[data-test="tour-title"]')!.textContent).toBe('Uno')
    expect(q('[data-test="tour-counter"]')!.textContent).toBe('Paso 1 de 3')
    expect(q<HTMLButtonElement>('[data-test="tour-prev"]')!.disabled).toBe(true)

    click('[data-test="tour-next"]')
    await settle()
    expect(q('[data-test="tour-title"]')!.textContent).toBe('Dos')
    click('[data-test="tour-prev"]')
    await settle()
    expect(q('[data-test="tour-title"]')!.textContent).toBe('Uno')

    click('[data-test="tour-next"]')
    click('[data-test="tour-next"]')
    await settle()
    expect(q('[data-test="tour-next"]')!.textContent).toContain('Terminar')
    click('[data-test="tour-next"]')
    await settle()
    expect(q('[data-test="tour"]')).toBeNull()
    expect(useUiStore().tourActive).toBe(false)
    expect(onEnd).toHaveBeenCalledWith('done')
  })

  it('highlights a visible target and centres the card when the target is missing', async () => {
    target('toolbar-ai')
    const tour = setup()
    tour.start(STEPS, { kind: 'whatsNew' })
    await settle()
    // Step 1 has no target: no ring, centred card.
    expect(q('[data-test="tour-spot"]')).toBeNull()
    expect(q('.tour__card--center')).not.toBeNull()
    expect(q('.tour__backdrop--dim')).not.toBeNull()

    tour.next()
    await settle()
    expect(q('[data-test="tour-spot"]')).not.toBeNull()
    expect(q('.tour__card--bottom')).not.toBeNull()

    // A target that is not on screen: the step still works, centred.
    tour.next()
    await settle()
    expect(q('[data-test="tour-title"]')!.textContent).toBe('Tres')
    expect(q('[data-test="tour-spot"]')).toBeNull()
    expect(q('.tour__card--center')).not.toBeNull()
  })

  it('keyboard: arrows navigate, Esc skips the tour', async () => {
    const tour = setup()
    const onEnd = vi.fn()
    tour.start(STEPS, { kind: 'whatsNew', onEnd })
    await settle()
    key('ArrowRight')
    await settle()
    expect(tour.index).toBe(1)
    key('ArrowLeft')
    await settle()
    expect(tour.index).toBe(0)
    key('ArrowLeft')
    expect(tour.index).toBe(0)
    key('Escape')
    await settle()
    expect(q('[data-test="tour"]')).toBeNull()
    expect(onEnd).toHaveBeenCalledWith('skipped')
  })

  it('is an accessible modal dialog that takes the focus', async () => {
    const tour = setup()
    tour.start(STEPS, { kind: 'whatsNew' })
    await settle()
    const card = q('[role="dialog"]')!
    expect(card.getAttribute('aria-modal')).toBe('true')
    expect(card.getAttribute('aria-labelledby')).toBe('tour-title')
    expect(document.activeElement).toBe(q('[data-test="tour-next"]'))
  })

  it('never opens over another modal, and other popups wait for it', async () => {
    vi.useFakeTimers()
    const tour = setup()
    const ui = useUiStore()
    ui.confirm.open = true
    tour.start(STEPS, { kind: 'whatsNew' })
    await vi.advanceTimersByTimeAsync(MODAL_RETRY_MS * 2)
    expect(ui.tourActive).toBe(false)
    expect(q('[data-test="tour"]')).toBeNull()

    ui.confirm.open = false
    await vi.advanceTimersByTimeAsync(MODAL_RETRY_MS)
    expect(ui.tourActive).toBe(true)

    // A queued popup (e.g. the novedades) waits until the tour ends.
    expect(otherModalOpen()).toBe(true)
    const show = vi.fn()
    showWhenFree(show, () => true)
    await vi.advanceTimersByTimeAsync(MODAL_RETRY_MS * 2)
    expect(show).not.toHaveBeenCalled()
    tour.skip()
    await vi.advanceTimersByTimeAsync(MODAL_RETRY_MS)
    expect(show).toHaveBeenCalledOnce()
  })

  describe('welcome tour', () => {
    it('detected Navicat: the last step asks and «Sí, importar» opens the import already detected', async () => {
      const tour = setup({
        'navicat:findCandidates': { supportedPlatform: true, candidates: [NAVICAT] }
      })
      await tour.startWelcome()
      await settle()
      expect(q('[data-test="tour-welcome"]')).not.toBeNull()
      expect(tour.steps).toHaveLength(WELCOME_FEATURE_STEPS.length + 1)
      expect(tour.steps).toHaveLength(9)
      tour.index = tour.steps.length - 1
      await settle()
      expect(q('[data-test="tour-text"]')!.textContent).toBe(
        `Se detectó Navicat en ${NAVICAT.rootPath} (4 conexiones, 3 tareas, 105 copias). ¿Es correcto?`
      )
      expect(q('.tour__code')!.textContent).toBe(NAVICAT.rootPath)
      // The last step ends through its buttons: no «Saltar tour», → does nothing.
      expect(q('[data-test="tour-skip"]')).toBeNull()
      key('ArrowRight')
      expect(tour.active).toBe(true)

      click('[data-test="tour-import-yes"]')
      await settle()
      const ui = useUiStore()
      expect(ui.tourActive).toBe(false)
      expect(ui.importDialog).toBe(true)
      expect(ui.importDialogRequest).toEqual({ rootPath: NAVICAT.rootPath })
      expect(bridge.invoke).toHaveBeenCalledWith('tour:markWelcomeDone')
    })

    it('«No es esta carpeta» opens the import on step 1 to choose the folder', async () => {
      const tour = setup({
        'navicat:findCandidates': { supportedPlatform: true, candidates: [NAVICAT] }
      })
      await tour.startWelcome()
      await settle()
      tour.index = tour.steps.length - 1
      await settle()
      click('[data-test="tour-import-other-folder"]')
      await settle()
      expect(useUiStore().importDialogRequest).toEqual({ chooseFolder: true })
    })

    it('«Ahora no» just closes it (recorded as done)', async () => {
      const tour = setup({
        'navicat:findCandidates': { supportedPlatform: true, candidates: [NAVICAT] }
      })
      await tour.startWelcome()
      await settle()
      tour.index = tour.steps.length - 1
      await settle()
      click('[data-test="tour-import-later"]')
      await settle()
      expect(useUiStore().importDialog).toBe(false)
      expect(useUiStore().tourActive).toBe(false)
      expect(bridge.invoke).toHaveBeenCalledWith('tour:markWelcomeDone')
    })

    it('nothing detected: «Crea tu primera conexión» with Nueva conexión / Importar desde otro gestor', async () => {
      const tour = setup()
      await tour.startWelcome()
      await settle()
      tour.index = tour.steps.length - 1
      await settle()
      expect(q('[data-test="tour-title"]')!.textContent).toBe('Crea tu primera conexión')
      click('[data-test="tour-new-connection"]')
      await settle()
      expect(useUiStore().connectionDialog.open).toBe(true)
      expect(useUiStore().importDialog).toBe(false)
    })

    it('a failing search still shows the tour (not detected)', async () => {
      const tour = setup({
        'navicat:findCandidates': () => {
          throw new Error('boom')
        }
      })
      await tour.startWelcome()
      await settle()
      expect(tour.active).toBe(true)
      expect(tour.steps.at(-1)?.testId).toBe('tour-import-none')
    })

    it('startup: only when main says the welcome tour is due', async () => {
      const tour = setup({
        'tour:state': { showWelcome: false, welcomeTourDone: true, tourSeenVersion: null }
      })
      expect(await tour.maybeStartWelcome()).toBe(false)
      await settle()
      expect(tour.active).toBe(false)
      expect(bridge.invoke).not.toHaveBeenCalledWith('navicat:findCandidates')
    })

    it('replay («Ver tour de bienvenida») runs it again even when already done', async () => {
      const tour = setup({
        'tour:state': { showWelcome: false, welcomeTourDone: true, tourSeenVersion: '0.1.7' }
      })
      await tour.startWelcome()
      await settle()
      expect(tour.active).toBe(true)
      expect(tour.kind).toBe('welcome')
      key('Escape')
      await settle()
      expect(bridge.invoke).toHaveBeenCalledWith('tour:markWelcomeDone')
    })
  })
})
