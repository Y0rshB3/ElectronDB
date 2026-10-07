import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { UpdateCheckResult, UpdateInstallState } from '@shared/types'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore } from '@renderer/stores/ui'
import { useUpdatesStore } from '@renderer/stores/updates'
import { MODAL_RETRY_MS } from '@renderer/composables/useModalQueue'
import { useNotify } from '@renderer/composables/useNotify'
import {
  createTestVuetify,
  flush,
  installBridge,
  installDomPolyfills,
  type MockBridge
} from '@renderer/__tests__/shellTestUtils'
import UpdateDialog from './UpdateDialog.vue'
import UpdateNotice from './UpdateNotice.vue'

const RELEASE = 'https://github.com/Y0rshB3/ElectronDB/releases'
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)
const text = (sel: string) => q(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

function available(overrides: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  return {
    status: 'available',
    currentVersion: '0.1.2',
    latestVersion: '0.1.3',
    releaseName: 'Vortaq v0.1.3',
    releaseUrl: `${RELEASE}/tag/v0.1.3`,
    publishedAt: '2026-10-01T10:00:00Z',
    notes: '## Novedades\n\n- Filtro **visual**\n- <b>sin html</b>',
    download: {
      url: `${RELEASE}/download/v0.1.3/Vortaq-0.1.3-arm64.dmg`,
      fileName: 'Vortaq-0.1.3-arm64.dmg',
      sizeBytes: 149_062_782,
      label: 'Imagen de disco (.dmg)'
    },
    alternatives: [
      {
        url: `${RELEASE}/download/v0.1.3/Vortaq-0.1.3-arm64-mac.zip`,
        fileName: 'Vortaq-0.1.3-arm64-mac.zip',
        sizeBytes: 149_224_720,
        label: 'Archivo .zip'
      }
    ],
    runMode: 'packaged',
    dismissed: false,
    ...overrides
  }
}

const SOURCE: UpdateCheckResult['source'] = {
  dir: '/Users/me/Vortaq',
  isGit: true,
  branch: 'main',
  commands: ['cd /Users/me/Vortaq', 'git pull', 'npm install', 'npm run dev']
}

describe('updates UI', () => {
  let bridge: MockBridge
  let check: ReturnType<typeof vi.fn>
  let wrappers: VueWrapper[] = []

  async function setup(
    answer: UpdateCheckResult | (() => UpdateCheckResult),
    settings = {},
    extra: Record<string, unknown> = {}
  ) {
    check = vi.fn(async () => (typeof answer === 'function' ? answer() : answer))
    bridge = installBridge({
      'updates:check': check,
      'updates:dismiss': undefined,
      'updates:snooze': undefined,
      'updates:installState': { mode: 'manual', phase: 'idle' },
      'app:openExternal': undefined,
      'app:info': { version: '0.1.2' },
      'settings:get': { checkUpdatesOnStartup: true, ...settings },
      ...extra
    })
    await useSettingsStore().load()
    useUpdatesStore().listen()
    for (const C of [UpdateNotice, UpdateDialog])
      wrappers.push(
        mount(C, { global: { plugins: [createTestVuetify()] }, attachTo: document.body })
      )
    return useUpdatesStore()
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) await flush()
  }

  beforeEach(() => {
    installDomPolyfills()
    setActivePinia(createPinia())
    document.body.innerHTML = ''
    wrappers = []
    useNotify().queue.forEach((n) => useNotify().dismiss(n.id))
  })
  afterEach(() => {
    wrappers.forEach((w) => w.unmount())
    vi.useRealTimers()
  })

  describe('startup popup', () => {
    it('checks automatically after the delay and shows the centered popup with the highlights', async () => {
      vi.useFakeTimers()
      const store = await setup(
        available({
          notes:
            '## Novedades\n\n- **Buscar actualizaciones**: aviso al iniciar.\n- Filtro **visual**\n\n## Correcciones\n\n- Arreglo'
        })
      )
      store.scheduleStartupCheck()
      expect(check).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(5000)
      vi.useRealTimers()
      await settle()
      expect(check).toHaveBeenCalledWith(false)
      expect(text('[data-test="update-notice"] h2')).toBe('Hay una nueva actualización')
      expect(text('[data-test="update-notice-subtitle"]')).toBe(
        'Vortaq 0.1.3 ya está disponible (tienes 0.1.2)'
      )
      const items = [...document.querySelectorAll('[data-test="update-highlights"] li')].map((li) =>
        li.textContent!.trim()
      )
      expect(items).toEqual(['Buscar actualizaciones', 'Filtro visual'])
      expect(q('[data-test="update-notice-download"]')).not.toBeNull()
      expect(q('[data-test="update-notice-howto"]')).toBeNull()
    })

    it('does not check when the setting is off', async () => {
      vi.useFakeTimers()
      const store = await setup(available(), { checkUpdatesOnStartup: false })
      store.scheduleStartupCheck()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(check).not.toHaveBeenCalled()
    })

    it('stays hidden for a dismissed or snoozed version, when up to date and on errors', async () => {
      for (const answer of [
        available({ dismissed: true }),
        available({ snoozed: true }),
        { status: 'up-to-date', currentVersion: '0.1.2', runMode: 'packaged' } as UpdateCheckResult,
        {
          status: 'error',
          currentVersion: '0.1.2',
          runMode: 'packaged',
          error: 'x'
        } as UpdateCheckResult
      ]) {
        setActivePinia(createPinia())
        document.body.innerHTML = ''
        const store = await setup(answer)
        await store.runStartupCheck()
        await settle()
        expect(store.noticeOpen).toBe(false)
        expect(q('[data-test="update-notice"]')).toBeNull()
        expect(useNotify().queue).toHaveLength(0)
      }
    })

    it('appears only once per app start', async () => {
      const store = await setup(available())
      await store.runStartupCheck()
      await settle()
      expect(store.noticeOpen).toBe(true)
      store.hideNotice()
      await store.runStartupCheck()
      await settle()
      expect(store.noticeOpen).toBe(false)
      expect(store.noticePending).toBe(false)
    })

    it('waits while another modal is open and opens once it closes', async () => {
      vi.useFakeTimers()
      const store = await setup(available())
      const ui = useUiStore()
      const answer = ui.ask({ title: 'Otra cosa', message: '…' })
      await store.runStartupCheck()
      expect(store.noticePending).toBe(true)
      expect(store.noticeOpen).toBe(false)
      await vi.advanceTimersByTimeAsync(MODAL_RETRY_MS * 3)
      expect(store.noticeOpen).toBe(false)
      ui.answer(false)
      await answer
      await vi.advanceTimersByTimeAsync(MODAL_RETRY_MS)
      expect(store.noticeOpen).toBe(true)
      expect(store.noticePending).toBe(false)
    })

    it('«Más tarde» closes and snoozes; «Omitir esta versión» remembers the version', async () => {
      const store = await setup(available())
      await store.runStartupCheck()
      await settle()
      q<HTMLButtonElement>('[data-test="update-notice-later"]')!.click()
      await settle()
      expect(store.noticeOpen).toBe(false)
      expect(bridge.invoke).toHaveBeenCalledWith('updates:snooze')
      expect(bridge.invoke).not.toHaveBeenCalledWith('updates:dismiss', '0.1.3')

      setActivePinia(createPinia())
      document.body.innerHTML = ''
      const again = await setup(available())
      await again.runStartupCheck()
      await settle()
      q<HTMLButtonElement>('[data-test="update-notice-skip"]')!.click()
      await settle()
      expect(bridge.invoke).toHaveBeenCalledWith('updates:dismiss', '0.1.3')
      expect(bridge.invoke).not.toHaveBeenCalledWith('updates:snooze')
      expect(again.noticeOpen).toBe(false)
    })

    it('«Descargar» opens the asset; «Ver todas las novedades» opens the full dialog', async () => {
      const store = await setup(available())
      await store.runStartupCheck()
      await settle()
      q<HTMLButtonElement>('[data-test="update-notice-download"]')!.click()
      await settle()
      expect(bridge.invoke).toHaveBeenCalledWith(
        'app:openExternal',
        `${RELEASE}/download/v0.1.3/Vortaq-0.1.3-arm64.dmg`
      )
      q<HTMLButtonElement>('[data-test="update-notice-notes"]')!.click()
      await settle()
      expect(store.noticeOpen).toBe(false)
      expect(store.dialogOpen).toBe(true)
      expect(check).toHaveBeenCalledTimes(1)
    })

    it('in source mode «Cómo actualizar» shows the commands inline with «Copiar comandos»', async () => {
      const store = await setup(available({ runMode: 'source', source: SOURCE }))
      await store.runStartupCheck()
      await settle()
      expect(q('[data-test="update-notice-commands"]')).toBeNull()
      q<HTMLButtonElement>('[data-test="update-notice-howto"]')!.click()
      await settle()
      expect(store.dialogOpen).toBe(false)
      expect(text('[data-test="update-notice-commands"]')).toContain('git pull')
      expect(q('[data-test="update-notice-copy"]')).not.toBeNull()
      expect(check).toHaveBeenCalledTimes(1)
    })
  })

  describe('dialog', () => {
    it('up to date', async () => {
      const store = await setup({
        status: 'up-to-date',
        currentVersion: '0.1.2',
        latestVersion: '0.1.2',
        releaseUrl: `${RELEASE}/tag/v0.1.2`,
        runMode: 'packaged'
      })
      store.openDialog()
      await settle()
      expect(check).toHaveBeenCalledWith(true)
      expect(text('[data-test="update-uptodate"]')).toBe('Estás en la última versión (0.1.2).')
      expect(text('[data-test="update-current"]')).toBe('0.1.2')
      expect(text('[data-test="update-latest"]')).toBe('0.1.2')
      expect(q('[data-test="update-skip"]')).toBeNull()
    })

    it('available, packaged: notes rendered as text, download and alternatives', async () => {
      const store = await setup(available())
      store.openDialog()
      await settle()
      expect(q('[data-test="update-dialog"]')!.getAttribute('data-status')).toBe('available')
      expect(text('[data-test="update-latest"]')).toBe('0.1.3')
      const notes = q('[data-test="release-notes"]')!
      expect(notes.querySelector('h4')?.textContent).toBe('Novedades')
      expect(notes.querySelector('strong')?.textContent).toBe('visual')
      expect(notes.querySelector('b')).toBeNull()
      expect(notes.textContent).toContain('<b>sin html</b>')
      expect(text('[data-test="update-packaged"]')).toContain('Vortaq-0.1.3-arm64.dmg')
      expect(text('[data-test="update-packaged"]')).toContain('142 MB')
      expect(q('[data-test="update-source"]')).toBeNull()

      q<HTMLButtonElement>('[data-test="update-alternative"]')!.click()
      await settle()
      expect(bridge.invoke).toHaveBeenCalledWith(
        'app:openExternal',
        `${RELEASE}/download/v0.1.3/Vortaq-0.1.3-arm64-mac.zip`
      )
      q<HTMLButtonElement>('[data-test="update-release-page"]')!.click()
      await settle()
      expect(bridge.invoke).toHaveBeenCalledWith('app:openExternal', `${RELEASE}/tag/v0.1.3`)
    })

    it('available, packaged without an asset for this OS points to the release page', async () => {
      const store = await setup(available({ download: undefined, alternatives: [] }))
      store.openDialog()
      await settle()
      expect(q('[data-test="update-no-asset"]')).not.toBeNull()
      expect(q('[data-test="update-download"]')).toBeNull()
    })

    it('available, source: commands for this folder and «Copiar comandos»', async () => {
      const writeText = vi.fn(async () => undefined)
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
      const store = await setup(available({ runMode: 'source', source: SOURCE }))
      store.openDialog()
      await settle()
      expect(q('[data-test="update-packaged"]')).toBeNull()
      expect(text('[data-test="update-source"]')).toContain('/Users/me/Vortaq')
      expect(q('[data-test="update-commands"]')!.textContent).toBe(SOURCE!.commands.join('\n'))
      expect(q('[data-test="update-branch"]')).toBeNull()
      q<HTMLButtonElement>('[data-test="update-copy"]')!.click()
      await settle()
      expect(writeText).toHaveBeenCalledWith(SOURCE!.commands.join('\n'))
    })

    it('source on another branch or without git shows a warning', async () => {
      const store = await setup(
        available({ runMode: 'source', source: { ...SOURCE!, branch: 'dev' } })
      )
      store.openDialog()
      await settle()
      expect(text('[data-test="update-branch"]')).toContain('dev')
      store.result = available({
        runMode: 'source',
        source: { ...SOURCE!, isGit: false, branch: null }
      })
      await settle()
      expect(q('[data-test="update-not-git"]')).not.toBeNull()
    })

    it('error: message and retry', async () => {
      let calls = 0
      const store = await setup(() =>
        ++calls === 1
          ? {
              status: 'error',
              currentVersion: '0.1.2',
              runMode: 'packaged',
              error: 'GitHub ha limitado temporalmente las consultas desde tu red.'
            }
          : available()
      )
      store.openDialog()
      await settle()
      expect(text('[data-test="update-error"]')).toContain('GitHub ha limitado')
      expect(text('[data-test="update-latest"]')).toBe('—')
      q<HTMLButtonElement>('[data-test="update-recheck"]')!.click()
      await settle()
      expect(q('[data-test="update-dialog"]')!.getAttribute('data-status')).toBe('available')
    })

    it('a rejected IPC call becomes an error state instead of throwing', async () => {
      const store = await setup(available())
      check.mockRejectedValueOnce(new Error('El puente IPC no está disponible'))
      await store.checkNow()
      await settle()
      expect(store.result?.status).toBe('error')
      expect(store.result?.error).toMatch(/puente IPC/)
    })
  })
  describe('in-app update (Windows/Linux «Descargar y actualizar», Mac .dmg)', () => {
    const WIN_SETUP = `${RELEASE}/download/v0.1.3/Vortaq-0.1.3-x64-setup.exe`
    const winAvailable = () =>
      available({
        installMode: 'auto',
        download: {
          url: WIN_SETUP,
          fileName: 'Vortaq-0.1.3-x64-setup.exe',
          sizeBytes: 130_000_000,
          label: 'Instalador (.exe)'
        },
        alternatives: []
      })
    const downloading = (transferred: number): UpdateInstallState => ({
      mode: 'auto',
      phase: 'downloading',
      version: '0.1.3',
      transferred,
      total: 130 * 1024 * 1024,
      bytesPerSecond: 4 * 1024 * 1024
    })

    it('download → progress → «Reiniciar y actualizar»; «Más tarde» keeps it for the next quit', async () => {
      const download = vi.fn(async () => downloading(0))
      const store = await setup(
        winAvailable(),
        {},
        {
          'updates:download': download,
          'updates:install': undefined
        }
      )
      store.openDialog()
      await settle()
      expect(q('[data-test="update-install"]')!.getAttribute('data-phase')).toBe('idle')
      expect(text('[data-test="update-start"]')).toBe('Descargar y actualizar')
      expect(q('[data-test="update-download"]')).toBeNull()

      q<HTMLButtonElement>('[data-test="update-start"]')!.click()
      await settle()
      expect(download).toHaveBeenCalledWith('0.1.3')
      expect(q('[data-test="update-install"]')!.getAttribute('data-phase')).toBe('downloading')

      bridge.emit('event:updateInstall', downloading(52 * 1024 * 1024))
      await settle()
      expect(text('[data-test="update-progress-text"]')).toBe('52.0 MB de 130 MB · 4.0 MB/s')
      expect(q('[data-test="update-progress"]')!.getAttribute('aria-valuenow')).toBe('40')
      expect(q('[data-test="update-cancel"]')).not.toBeNull()

      bridge.emit('event:updateInstall', {
        ...downloading(130 * 1024 * 1024),
        phase: 'downloaded',
        bytesPerSecond: 0
      })
      await settle()
      expect(text('[data-test="update-ready"]')).toContain(
        'Vortaq 0.1.3 está listo para instalarse'
      )
      q<HTMLButtonElement>('[data-test="update-restart"]')!.click()
      await settle()
      expect(bridge.invoke).toHaveBeenCalledWith('updates:install')

      q<HTMLButtonElement>('[data-test="update-install-later"]')!.click()
      await settle()
      expect(store.dialogOpen).toBe(false)
    })

    it('cancel goes back to the start button', async () => {
      const store = await setup(
        winAvailable(),
        {},
        {
          'updates:download': async () => downloading(0),
          'updates:cancelDownload': { mode: 'auto', phase: 'idle', cancelled: true }
        }
      )
      store.openDialog()
      await settle()
      q<HTMLButtonElement>('[data-test="update-start"]')!.click()
      await settle()
      q<HTMLButtonElement>('[data-test="update-cancel"]')!.click()
      await settle()
      expect(bridge.invoke).toHaveBeenCalledWith('updates:cancelDownload')
      expect(q('[data-test="update-install"]')!.getAttribute('data-phase')).toBe('idle')
      expect(text('[data-test="update-install"]')).toContain('Descarga cancelada')
    })

    it('errors show the Spanish message, «Reintentar» and «Descargar manualmente»', async () => {
      const store = await setup(
        winAvailable(),
        {},
        {
          'updates:download': async () => downloading(0)
        }
      )
      store.openDialog()
      await settle()
      q<HTMLButtonElement>('[data-test="update-start"]')!.click()
      await settle()
      bridge.emit('event:updateInstall', {
        mode: 'auto',
        phase: 'error',
        version: '0.1.3',
        error:
          'No se pudo descargar la actualización: comprueba la conexión a Internet (o el proxy) e inténtalo de nuevo.',
        manualUrl: WIN_SETUP
      })
      await settle()
      expect(text('[data-test="update-install-error"]')).toContain('comprueba la conexión')
      expect(text('[data-test="update-start"]')).toBe('Reintentar')
      q<HTMLButtonElement>('[data-test="update-manual"]')!.click()
      await settle()
      expect(bridge.invoke).toHaveBeenCalledWith('app:openExternal', WIN_SETUP)
    })

    it('a rejected download call becomes an error state with the manual link', async () => {
      const store = await setup(
        winAvailable(),
        {},
        {
          'updates:download': async () => {
            throw new Error('Esta copia de Vortaq no puede actualizarse desde la app.')
          }
        }
      )
      store.openDialog()
      await settle()
      await store.startDownload()
      await settle()
      expect(store.install).toMatchObject({ phase: 'error', manualUrl: WIN_SETUP })
      expect(text('[data-test="update-install-error"]')).toContain('no puede actualizarse')
    })

    it('Mac: explains why it cannot self-install, then the drag-to-Applications steps', async () => {
      const store = await setup(
        available({ installMode: 'mac-dmg' }),
        {},
        {
          'updates:download': async () => ({ ...downloading(0), mode: 'mac-dmg' }),
          'updates:install': undefined
        }
      )
      store.openDialog()
      await settle()
      expect(text('[data-test="update-start"]')).toBe('Descargar instalador')
      expect(text('[data-test="update-mac-why"]')).toContain(
        'certificado de desarrollador de Apple'
      )
      q<HTMLButtonElement>('[data-test="update-start"]')!.click()
      await settle()
      bridge.emit('event:updateInstall', {
        mode: 'mac-dmg',
        phase: 'downloaded',
        version: '0.1.3',
        filePath: '/Users/me/Downloads/Vortaq-0.1.3-arm64.dmg'
      })
      await settle()
      expect(text('[data-test="update-mac-ready"]')).toContain('Vortaq-0.1.3-arm64.dmg')
      expect(text('[data-test="update-mac-steps"]')).toContain(
        'arrastra Vortaq a Aplicaciones y reemplaza'
      )
      q<HTMLButtonElement>('[data-test="update-open-dmg"]')!.click()
      await settle()
      expect(bridge.invoke).toHaveBeenCalledWith('updates:install')
    })

    it('the startup popup offers «Descargar y actualizar» and opens the dialog with the progress', async () => {
      const download = vi.fn(async () => downloading(0))
      const store = await setup(winAvailable(), {}, { 'updates:download': download })
      await store.runStartupCheck()
      await settle()
      expect(q('[data-test="update-notice-download"]')).toBeNull()
      expect(text('[data-test="update-notice-update"]')).toBe('Descargar y actualizar')
      q<HTMLButtonElement>('[data-test="update-notice-update"]')!.click()
      await settle()
      expect(download).toHaveBeenCalledWith('0.1.3')
      expect(store.dialogOpen).toBe(true)
      expect(store.noticeOpen).toBe(false)
    })

    it('downloads automatically only with the opt-in setting, never for skipped or snoozed versions', async () => {
      const download = vi.fn(async () => downloading(0))
      let store = await setup(winAvailable(), {}, { 'updates:download': download })
      await store.runStartupCheck()
      await settle()
      expect(download).not.toHaveBeenCalled()

      for (const answer of [
        { ...winAvailable(), dismissed: true },
        { ...winAvailable(), snoozed: true }
      ]) {
        setActivePinia(createPinia())
        document.body.innerHTML = ''
        store = await setup(answer, { autoDownloadUpdates: true }, { 'updates:download': download })
        await store.runStartupCheck()
        await settle()
      }
      expect(download).not.toHaveBeenCalled()

      setActivePinia(createPinia())
      document.body.innerHTML = ''
      store = await setup(
        winAvailable(),
        { autoDownloadUpdates: true },
        { 'updates:download': download }
      )
      await store.runStartupCheck()
      await settle()
      expect(download).toHaveBeenCalledWith('0.1.3')
    })
  })
})
