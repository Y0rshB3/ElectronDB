import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AppSettings } from '@shared/types'
import { api } from '@renderer/api'

const DEFAULTS: AppSettings = {
  navicatRootPath: '',
  backupsRootDir: '',
  defaultRowLimit: 1000,
  theme: 'dark',
  confirmProductionWrites: true,
  confirmDestructiveEverywhere: true,
  checkUpdatesOnStartup: true
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>({ ...DEFAULTS })
  const loaded = ref(false)

  async function load(): Promise<void> {
    settings.value = { ...DEFAULTS, ...(await api.settings.get()) }
    loaded.value = true
  }

  async function update(patch: Partial<AppSettings>): Promise<void> {
    settings.value = { ...DEFAULTS, ...(await api.settings.update(patch)) }
  }

  const rowLimit = computed(() =>
    Math.max(1, settings.value.defaultRowLimit || DEFAULTS.defaultRowLimit)
  )
  const themeName = computed(() =>
    settings.value.theme === 'light' ? 'electrondbLight' : 'electrondbDark'
  )

  return { settings, loaded, rowLimit, themeName, load, update }
})
