import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { UpdateAsset, UpdateCheckResult } from '@shared/types'
import { api } from '@renderer/api'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useSettingsStore } from './settings'

/** Delay after start before the automatic check: never competes with the first paint. */
export const STARTUP_CHECK_DELAY_MS = 5000

/**
 * New-version check. Main talks to GitHub; this store keeps the last answer,
 * the startup notice and the «Buscar actualizaciones» dialog state. Nothing is
 * downloaded or run: «Descargar» opens the browser on the release asset.
 */
export const useUpdatesStore = defineStore('updates', () => {
  const notify = useNotify()
  const result = ref<UpdateCheckResult | null>(null)
  const checking = ref(false)
  const dialogOpen = ref(false)
  const noticeOpen = ref(false)
  const appVersion = ref('')

  const available = computed(() => result.value?.status === 'available')
  const latestVersion = computed(() => result.value?.latestVersion ?? '')

  async function loadAppVersion(): Promise<string> {
    if (appVersion.value) return appVersion.value
    try {
      appVersion.value = (await api.app.info()).version
    } catch {
      /* the version just stays hidden */
    }
    return appVersion.value
  }

  function remember(next: UpdateCheckResult): void {
    result.value = next
    if (next.currentVersion) appVersion.value = next.currentVersion
  }

  /** Automatic check: quiet on errors; shows the notice for a new, not skipped version. */
  async function runStartupCheck(): Promise<void> {
    let next: UpdateCheckResult
    try {
      next = await api.updates.check(false)
    } catch {
      return
    }
    // A manual check started meanwhile owns the dialog; keep its answer.
    if (checking.value) return
    if (!next || next.status === 'error') return
    remember(next)
    noticeOpen.value = next.status === 'available' && !next.dismissed && !dialogOpen.value
  }

  /**
   * Schedules the automatic check (when «Buscar actualizaciones al iniciar» is
   * on). Returns a function that cancels it.
   */
  function scheduleStartupCheck(delayMs = STARTUP_CHECK_DELAY_MS): () => void {
    if (useSettingsStore().settings.checkUpdatesOnStartup === false) return () => undefined
    const timer = setTimeout(() => void runStartupCheck(), delayMs)
    return () => clearTimeout(timer)
  }

  /** Manual check: always asks GitHub; errors are shown in the dialog. */
  async function checkNow(): Promise<void> {
    if (checking.value) return
    checking.value = true
    try {
      remember(await api.updates.check(true))
    } catch (err) {
      remember({
        status: 'error',
        currentVersion: appVersion.value,
        runMode: result.value?.runMode ?? 'packaged',
        error: errorMessage(err)
      })
    } finally {
      checking.value = false
    }
    if (result.value?.status !== 'available') noticeOpen.value = false
  }

  /** «Buscar actualizaciones…» (toolbar, app menu, settings). */
  function openDialog(): void {
    noticeOpen.value = false
    dialogOpen.value = true
    void loadAppVersion()
    void checkNow()
  }

  /** From the notice: shows the answer already in hand without asking GitHub again. */
  function showDetails(): void {
    noticeOpen.value = false
    dialogOpen.value = true
  }

  function hideNotice(): void {
    noticeOpen.value = false
  }

  async function dismissVersion(): Promise<void> {
    const version = result.value?.latestVersion
    if (!version) return
    try {
      await api.updates.dismiss(version)
    } catch {
      return // already reported by api.invoke
    }
    if (result.value) result.value = { ...result.value, dismissed: true }
    noticeOpen.value = false
    dialogOpen.value = false
    notify.info(`No se volverá a avisar de la versión ${version}.`)
  }

  async function openUrl(url: string | undefined): Promise<void> {
    if (!url) return
    try {
      await api.app.openExternal(url)
    } catch {
      /* already reported by api.invoke */
    }
  }

  const openRelease = (): Promise<void> => openUrl(result.value?.releaseUrl)

  /** Opens the asset (or, without one for this system, the release page) in the browser. */
  async function download(asset?: UpdateAsset): Promise<void> {
    const target = asset ?? result.value?.download
    await openUrl(target?.url ?? result.value?.releaseUrl)
    if (target) notify.info(`Descargando ${target.fileName} en el navegador.`)
  }

  async function copyCommands(): Promise<void> {
    const commands = result.value?.source?.commands
    if (!commands?.length) return
    try {
      await navigator.clipboard.writeText(commands.join('\n'))
      notify.success('Comandos copiados al portapapeles')
    } catch {
      notify.error('No se pudieron copiar los comandos. Selecciónalos y cópialos a mano.')
    }
  }

  return {
    result,
    checking,
    dialogOpen,
    noticeOpen,
    appVersion,
    available,
    latestVersion,
    loadAppVersion,
    runStartupCheck,
    scheduleStartupCheck,
    checkNow,
    openDialog,
    showDetails,
    hideNotice,
    dismissVersion,
    openRelease,
    download,
    copyCommands
  }
})
