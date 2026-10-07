import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { NavicatCandidate } from '@shared/types'
import type { TourStep } from '@shared/tour'
import { api } from '@renderer/api'
import { showWhenFree } from '@renderer/composables/useModalQueue'
import { welcomeSteps, type ActiveTourStep } from '@renderer/components/tour/welcomeTour'
import { useUiStore } from './ui'

export type TourKind = 'welcome' | 'whatsNew'
/** How a tour ended: last step reached, «Saltar tour» / Esc, or an action of the last step. */
export type TourEnd = 'done' | 'skipped'

interface StartOptions {
  kind: TourKind
  onEnd?: (how: TourEnd) => void
}

/**
 * Guided tours (welcome tour and «Mostrarme cómo» of the novedades), shown by
 * components/tour/TourHost.vue. A tour waits until no modal is open and, while
 * it runs, other queued popups wait for it (ui.tourActive).
 */
export const useTourStore = defineStore('tour', () => {
  const ui = useUiStore()
  const steps = ref<ActiveTourStep[]>([])
  const index = ref(0)
  const kind = ref<TourKind | null>(null)
  const active = computed(() => ui.tourActive)
  const step = computed<ActiveTourStep | null>(() =>
    active.value ? (steps.value[index.value] ?? null) : null
  )
  const isFirst = computed(() => index.value === 0)
  const isLast = computed(() => index.value === steps.value.length - 1)

  let onEnd: ((how: TourEnd) => void) | null = null
  let cancelWait: (() => void) | null = null
  let pending = false

  /** Shows `list` as soon as the screen is free. Replaces a tour that is waiting or running. */
  function start(list: readonly ActiveTourStep[], options: StartOptions): void {
    if (!list.length) return
    cancelWait?.()
    if (ui.tourActive) end('skipped')
    pending = true
    cancelWait = showWhenFree(
      () => {
        pending = false
        cancelWait = null
        steps.value = [...list]
        index.value = 0
        kind.value = options.kind
        onEnd = options.onEnd ?? null
        ui.tourActive = true
      },
      () => pending
    )
  }

  function end(how: TourEnd): void {
    if (!ui.tourActive) return
    ui.tourActive = false
    const callback = onEnd
    onEnd = null
    kind.value = null
    callback?.(how)
  }

  function next(): void {
    if (!active.value) return
    if (isLast.value) {
      // The last step of the welcome tour ends through its own buttons.
      if (!step.value?.actions?.length) end('done')
      return
    }
    index.value++
  }

  function prev(): void {
    if (active.value && index.value > 0) index.value--
  }

  function skip(): void {
    end('skipped')
  }

  /** Runs a button of the current step: the tour closes first, then the action opens its dialog. */
  function runAction(run: () => void): void {
    end('done')
    run()
  }

  /** Best first candidate of the automatic Navicat search, null when none or on failure. */
  async function detectNavicat(): Promise<NavicatCandidate | null> {
    try {
      return (await api.navicat.findCandidates()).candidates[0] ?? null
    } catch {
      return null
    }
  }

  /** The welcome tour (first run, or «Ver tour de bienvenida»). Finishing or skipping it is recorded. */
  async function startWelcome(): Promise<void> {
    const navicat = await detectNavicat()
    const list = welcomeSteps(navicat, {
      importFrom: (rootPath) => ui.openImportDialog({ rootPath }),
      chooseFolder: () => ui.openImportDialog({ chooseFolder: true }),
      newConnection: () => ui.openConnectionDialog(null),
      importOther: () => ui.openImportDialog(),
      later: () => undefined
    })
    start(list, {
      kind: 'welcome',
      onEnd: () => {
        void api.tour.markWelcomeDone().catch(() => undefined)
      }
    })
  }

  /** Startup: the welcome tour on the first run of a fresh profile only. */
  async function maybeStartWelcome(): Promise<boolean> {
    let due = false
    try {
      due = (await api.tour.state()).showWelcome
    } catch {
      return false
    }
    if (due) await startWelcome()
    return due
  }

  /** «Mostrarme cómo» of the novedades: just those steps, nothing recorded. */
  function startSteps(list: readonly TourStep[]): void {
    start(list, { kind: 'whatsNew' })
  }

  return {
    steps,
    index,
    kind,
    active,
    step,
    isFirst,
    isLast,
    start,
    startSteps,
    startWelcome,
    maybeStartWelcome,
    next,
    prev,
    skip,
    runAction,
    end
  }
})
