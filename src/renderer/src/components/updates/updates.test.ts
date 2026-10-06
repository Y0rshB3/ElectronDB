import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { UpdateCheckResult } from '@shared/types'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUpdatesStore } from '@renderer/stores/updates'
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
    releaseName: 'ElectronDB v0.1.3',
    releaseUrl: `${RELEASE}/tag/v0.1.3`,
    publishedAt: '2026-10-01T10:00:00Z',
    notes: '## Novedades\n\n- Filtro **visual**\n- <b>sin html</b>',
    download: {
      url: `${RELEASE}/download/v0.1.3/ElectronDB-0.1.3-arm64.dmg`,
      fileName: 'ElectronDB-0.1.3-arm64.dmg',
      sizeBytes: 149_062_782,
      label: 'Imagen de disco (.dmg)'
    },
    alternatives: [
      {
        url: `${RELEASE}/download/v0.1.3/ElectronDB-0.1.3-arm64-mac.zip`,
        fileName: 'ElectronDB-0.1.3-arm64-mac.zip',
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
  dir: '/Users/me/ElectronDB',
  isGit: true,
  branch: 'main',
  commands: ['cd /Users/me/ElectronDB', 'git pull', 'npm install', 'npm run dev']
}

describe('updates UI', () => {
  let bridge: MockBridge
  let check: ReturnType<typeof vi.fn>
  let wrappers: VueWrapper[] = []

  async function setup(answer: UpdateCheckResult | (() => UpdateCheckResult), settings = {}) {
    check = vi.fn(async () => (typeof answer === 'function' ? answer() : answer))
    bridge = installBridge({
      'updates:check': check,
      'updates:dismiss': undefined,
      'app:openExternal': undefined,
      'app:info': { version: '0.1.2' },
      'settings:get': { checkUpdatesOnStartup: true, ...settings }
    })
    await useSettingsStore().load()
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

  describe('startup notice', () => {
    it('checks automatically after the delay and shows the notice', async () => {
      vi.useFakeTimers()
      const store = await setup(available())
      store.scheduleStartupCheck()
      expect(check).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(5000)
      vi.useRealTimers()
      await settle()
      expect(check).toHaveBeenCalledWith(false)
      expect(text('[data-test="update-notice"] h2')).toBe('Nueva versión 0.1.3 disponible')
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

    it('stays hidden for a dismissed version, when up to date and on errors', async () => {
      for (const answer of [
        available({ dismissed: true }),
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
        expect(q('[data-test="update-notice"]')).toBeNull()
        expect(useNotify().queue).toHaveLength(0)
      }
    })

    it('«Descargar» opens the asset; «Omitir esta versión» remembers it', async () => {
      const store = await setup(available())
      await store.runStartupCheck()
      await settle()
      q<HTMLButtonElement>('[data-test="update-notice-download"]')!.click()
      await settle()
      expect(bridge.invoke).toHaveBeenCalledWith(
        'app:openExternal',
        `${RELEASE}/download/v0.1.3/ElectronDB-0.1.3-arm64.dmg`
      )
      q<HTMLButtonElement>('[data-test="update-notice-skip"]')!.click()
      await settle()
      expect(bridge.invoke).toHaveBeenCalledWith('updates:dismiss', '0.1.3')
      expect(q('[data-test="update-notice"]')).toBeNull()
    })

    it('in source mode offers «Cómo actualizar», which opens the dialog without asking again', async () => {
      const store = await setup(available({ runMode: 'source', source: SOURCE }))
      await store.runStartupCheck()
      await settle()
      q<HTMLButtonElement>('[data-test="update-notice-howto"]')!.click()
      await settle()
      expect(store.dialogOpen).toBe(true)
      expect(check).toHaveBeenCalledTimes(1)
      expect(q('[data-test="update-source"]')).not.toBeNull()
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
      expect(text('[data-test="update-packaged"]')).toContain('ElectronDB-0.1.3-arm64.dmg')
      expect(text('[data-test="update-packaged"]')).toContain('142 MB')
      expect(q('[data-test="update-source"]')).toBeNull()

      q<HTMLButtonElement>('[data-test="update-alternative"]')!.click()
      await settle()
      expect(bridge.invoke).toHaveBeenCalledWith(
        'app:openExternal',
        `${RELEASE}/download/v0.1.3/ElectronDB-0.1.3-arm64-mac.zip`
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
      expect(text('[data-test="update-source"]')).toContain('/Users/me/ElectronDB')
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
})
