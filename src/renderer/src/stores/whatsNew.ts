import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { WhatsNewInfo } from '@shared/types'
import { tourStepsOf } from '@shared/whatsNew'
import { api } from '@renderer/api'
import { showWhenFree } from '@renderer/composables/useModalQueue'
import { useTourStore } from './tour'

/**
 * «ElectronDB se actualizó a x.y.z»: shown once on the first start of a new
 * version, with the curated highlights of every version in between (main
 * decides what to show, see src/shared/whatsNew.ts). Waits for other modals.
 * Closing it in any way records the version as seen.
 */
export const useWhatsNewStore = defineStore('whatsNew', () => {
  const info = ref<WhatsNewInfo | null>(null)
  const open = ref(false)
  let pending = false

  async function load(): Promise<void> {
    if (info.value) return
    let next: WhatsNewInfo | null
    try {
      next = await api.updates.whatsNew()
    } catch {
      return
    }
    if (!next?.entries.length) return
    info.value = next
    pending = true
    showWhenFree(
      () => {
        pending = false
        open.value = true
      },
      () => pending
    )
  }

  async function close(): Promise<void> {
    const version = info.value?.currentVersion
    open.value = false
    pending = false
    if (!version) return
    try {
      await api.updates.markSeen(version)
    } catch {
      /* best effort: it would show again on the next start */
    }
  }

  /** «Mostrarme cómo» steps of the versions shown (empty: no button). */
  const tourSteps = computed(() => (info.value ? tourStepsOf(info.value.entries) : []))

  /** «Mostrarme cómo»: closes the popup (seen) and runs only those steps. */
  async function showMe(): Promise<void> {
    const steps = tourSteps.value
    await close()
    if (steps.length) useTourStore().startSteps(steps)
  }

  async function openRelease(): Promise<void> {
    const url = info.value?.releaseUrl
    if (!url) return
    try {
      await api.app.openExternal(url)
    } catch {
      /* already reported by api.invoke */
    }
  }

  return { info, open, tourSteps, load, close, showMe, openRelease }
})
