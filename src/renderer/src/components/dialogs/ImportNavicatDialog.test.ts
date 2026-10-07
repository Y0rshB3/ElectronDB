import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mock } from 'vitest'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore } from '@renderer/stores/ui'
import ImportNavicatDialog from './ImportNavicatDialog.vue'
import { calls, freshPinia, mockVortaq, mountWith, settle } from './testing'

const ssh = {
  enabled: false,
  host: '',
  port: 22,
  username: '',
  authType: 'password' as const,
  savePassword: false
}
const ssl = { enabled: false, verifyServer: true }
const preview = (name: string, alreadyImported: boolean) => ({
  name,
  host: '127.0.0.1',
  port: 13306,
  username: 'root',
  color: '#69f0ae',
  environment: 'local',
  ssh,
  ssl,
  savePath: null,
  customDatabases: [],
  initialQueries: '',
  backupCount: 2,
  alreadyImported
})

describe('ImportNavicatDialog', () => {
  let invoke: Mock
  let wrapper: ReturnType<typeof mountWith> | null = null

  beforeEach(() => {
    invoke = mockVortaq({
      'navicat:detect': (root) => ({
        found: true,
        rootPath: root ?? '/nav',
        connPlistPath: '/nav/Common/conn.plist',
        prefPlistPath: null,
        profilesDir: null,
        connectionCount: 2,
        jobCount: 1,
        backupCount: 4
      }),
      'navicat:previewConnections': () => [preview('Local', false), preview('Staging', true)],
      'navicat:previewJobs': () => [
        {
          fileName: 'Nightly.nbatmysql',
          name: 'Nightly',
          continueOnError: true,
          tasks: [],
          alreadyImported: false
        }
      ],
      'navicat:import': () => ({
        connections: [{ id: 'x' }],
        jobs: [{ id: 'j' }],
        warnings: ['Aviso de prueba']
      }),
      'connections:list': () => [],
      'jobs:list': () => [],
      'jobs:runs': () => []
    })
  })
  afterEach(() => wrapper?.unmount())

  it('invalidates the detection when the path is edited afterwards', async () => {
    const pinia = freshPinia()
    useSettingsStore().settings.navicatRootPath = '/nav'
    useUiStore().importDialog = true
    wrapper = mountWith(ImportNavicatDialog, pinia)
    await settle()
    expect(wrapper.find('[data-test="import-detection"]').exists()).toBe(true)
    expect(wrapper.get('[data-test="import-next"]').attributes('disabled')).toBeUndefined()

    await wrapper.get('[data-test="import-root"] input').setValue('/otra/carpeta')
    await settle()
    expect(wrapper.find('[data-test="import-detection"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="import-next"]').attributes('disabled')).toBeDefined()
  })

  it('runs detect -> preview -> import with the selected items and refreshes stores', async () => {
    const pinia = freshPinia()
    useSettingsStore().settings.navicatRootPath = '/nav'
    useUiStore().importDialog = true
    wrapper = mountWith(ImportNavicatDialog, pinia)
    await settle()

    expect(calls(invoke, 'navicat:detect')).toEqual([['/nav']])
    expect(wrapper.get('[data-test="import-detection"]').text()).toContain('2 conexiones')

    await wrapper.get('[data-test="import-next"]').trigger('click')
    await settle()
    expect(calls(invoke, 'navicat:previewConnections')).toEqual([['/nav']])
    expect(calls(invoke, 'navicat:previewJobs')).toEqual([['/nav']])
    expect(wrapper.get('[data-test="import-connections"]').text()).toContain('ya importado')

    await wrapper.get('[data-test="import-run"]').trigger('click')
    await settle()
    expect(calls(invoke, 'navicat:import')).toEqual([
      [{ connections: ['Local'], jobs: ['Nightly.nbatmysql'] }, '/nav']
    ])
    expect(wrapper.get('[data-test="import-result"]').text()).toContain('1 conexiones')
    expect(calls(invoke, 'connections:list')).toHaveLength(1)
    expect(calls(invoke, 'jobs:list')).toHaveLength(1)

    // Passwords are typed by hand: no keychain access of any kind is offered.
    expect(wrapper.find('[data-test="import-recover"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="import-passwords-manual"]').text()).toContain(
      'Navicat no guarda las contraseñas'
    )
  })

  it('does not show the copied-folder notice on macOS', async () => {
    const pinia = freshPinia()
    useSettingsStore().settings.navicatRootPath = '/nav'
    useUiStore().importDialog = true
    wrapper = mountWith(ImportNavicatDialog, pinia)
    await settle()
    expect(wrapper.find('[data-test="import-non-mac"]').exists()).toBe(false)
  })

  for (const os of ['win32', 'linux']) {
    describe(`on ${os}`, () => {
      beforeEach(() => {
        ;(window.vortaq as { platform?: string }).platform = os
      })

      it('explains the copied macOS folder and does not probe an empty path', async () => {
        const pinia = freshPinia()
        useSettingsStore().settings.navicatRootPath = ''
        useUiStore().importDialog = true
        wrapper = mountWith(ImportNavicatDialog, pinia)
        await settle()
        expect(wrapper.get('[data-test="import-non-mac"]').text()).toContain('Navicat CC')
        expect(calls(invoke, 'navicat:detect')).toHaveLength(0)

        await wrapper.get('[data-test="import-detect"]').trigger('click')
        await settle()
        expect(calls(invoke, 'navicat:detect')).toHaveLength(0)
        expect(wrapper.get('[data-test="import-error"]').text()).toContain('copiada desde un Mac')

        await wrapper.get('[data-test="import-root"] input').setValue('C:\\Datos\\Navicat CC')
        await wrapper.get('[data-test="import-detect"]').trigger('click')
        await settle()
        expect(calls(invoke, 'navicat:detect')).toEqual([['C:\\Datos\\Navicat CC']])
        expect(wrapper.find('[data-test="import-error"]').exists()).toBe(false)
      })

      it('hides the Keychain recovery button after importing', async () => {
        const pinia = freshPinia()
        useSettingsStore().settings.navicatRootPath = '/copia/Navicat CC'
        useUiStore().importDialog = true
        wrapper = mountWith(ImportNavicatDialog, pinia)
        await settle()
        await wrapper.get('[data-test="import-next"]').trigger('click')
        await settle()
        await wrapper.get('[data-test="import-run"]').trigger('click')
        await settle()
        expect(wrapper.find('[data-test="import-result"]').exists()).toBe(true)
        expect(wrapper.find('[data-test="import-recover"]').exists()).toBe(false)
        expect(wrapper.get('[data-test="import-passwords-manual"]').text()).toContain(
          'escribe la contraseña'
        )
      })
    })
  }

  describe('automatic search', () => {
    const cand = (rootPath: string, connectionCount: number, source = 'default') => ({
      rootPath,
      source,
      connectionCount,
      jobCount: 3,
      backupCount: 105,
      modifiedAt: '2026-10-01T10:00:00.000Z'
    })
    const NAV = '/Users/demo/Library/Application Support/PremiumSoft CyberTech/Navicat CC'
    const STORE = '/Users/demo/Library/Containers/com.prect.Navicat/Data/Navicat CC'
    let saved: unknown[]

    function mock(candidates: unknown[], validRoots: string[] = [NAV, STORE]) {
      saved = []
      invoke = mockVortaq({
        'navicat:findCandidates': () => ({ supportedPlatform: true, candidates }),
        'navicat:detect': (root) => ({
          found: validRoots.includes(root as string),
          rootPath: root,
          connPlistPath: null,
          prefPlistPath: null,
          profilesDir: null,
          connectionCount: 4,
          jobCount: 3,
          backupCount: 105
        }),
        'navicat:previewConnections': () => [preview('Local', false)],
        'navicat:previewJobs': () => [],
        'settings:update': (patch) => {
          saved.push(patch)
          return { ...useSettingsStore().settings, ...(patch as object) }
        },
        'app:pickDirectory': () => STORE
      })
    }

    async function open(path = '', request: object | null = null) {
      const pinia = freshPinia()
      useSettingsStore().settings.navicatRootPath = path
      useUiStore().openImportDialog(request)
      wrapper = mountWith(ImportNavicatDialog, pinia)
      await settle(8)
      return wrapper
    }

    it('empty path: searches and asks «¿Es correcto?» for a single folder; «Sí» goes on and remembers it', async () => {
      mock([cand(NAV, 4)])
      const w = await open('')
      expect(calls(invoke, 'navicat:findCandidates')).toHaveLength(1)
      const proposal = w.get('[data-test="import-proposal"]')
      expect(proposal.text()).toContain(`Se detectó Navicat en ${NAV}`)
      expect(proposal.text()).toContain('4 conexiones, 3 tareas, 105 copias')
      expect(proposal.text()).toContain('¿Es correcto?')

      await w.get('[data-test="import-proposal-yes"]').trigger('click')
      await settle(8)
      expect(calls(invoke, 'navicat:previewConnections')).toEqual([[NAV]])
      expect(w.find('[data-test="import-connections"]').exists()).toBe(true)
      expect(saved).toEqual([{ navicatRootPath: NAV }])
    })

    it('opened from the import wizard: «Otros orígenes» goes back to the source list', async () => {
      mock([cand(NAV, 4)])
      const w = await open('', { fromWizard: true })
      await w.get('[data-test="import-back-to-wizard"]').trigger('click')
      await settle()
      expect(useUiStore().importDialog).toBe(false)
      expect(useUiStore().importWizard).toBe(true)
    })

    it('opened directly (tour, Automatización): no «Otros orígenes»', async () => {
      mock([cand(NAV, 4)])
      const w = await open('')
      expect(w.find('[data-test="import-back-to-wizard"]').exists()).toBe(false)
    })

    it('stored path that is no longer valid: searches the usual places', async () => {
      mock([cand(STORE, 2, 'appStore')])
      const w = await open('/old/Navicat CC')
      expect(calls(invoke, 'navicat:detect')).toEqual([['/old/Navicat CC']])
      expect(calls(invoke, 'navicat:findCandidates')).toHaveLength(1)
      expect(w.get('[data-test="import-proposal"]').text()).toContain(STORE)
      // The proposal replaces the «no data in that folder» warning.
      expect(w.find('[data-test="import-not-found"]').exists()).toBe(false)
    })

    it('valid stored path: no search, the usual detection', async () => {
      mock([cand(STORE, 2)])
      const w = await open(NAV)
      expect(calls(invoke, 'navicat:findCandidates')).toHaveLength(0)
      expect(w.find('[data-test="import-detection"]').exists()).toBe(true)
    })

    it('several folders: a list to choose from, best first', async () => {
      mock([cand(NAV, 4), cand(STORE, 2, 'appStore')])
      const w = await open('')
      const list = w.get('[data-test="import-candidates"]')
      expect(list.text()).toContain('Se encontraron 2 carpetas')
      expect(list.text()).toContain('Navicat de la App Store')
      const radios = w.findAll('[data-test="import-candidate"] input')
      expect(radios).toHaveLength(2)
      await radios[1].setValue(true)
      await w.get('[data-test="import-candidates-use"]').trigger('click')
      await settle(8)
      expect(calls(invoke, 'navicat:previewConnections')).toEqual([[STORE]])
      expect(saved).toEqual([{ navicatRootPath: STORE }])
    })

    it('«Elegir otra» hides the proposal and keeps the manual path, picker and Detectar', async () => {
      mock([cand(NAV, 4)])
      const w = await open('')
      await w.get('[data-test="import-proposal-other"]').trigger('click')
      await settle()
      expect(w.find('[data-test="import-proposal"]').exists()).toBe(false)
      await w.get('[data-test="import-pick"]').trigger('click')
      await settle(8)
      expect(calls(invoke, 'navicat:detect')).toEqual([[STORE]])
      expect(w.get('[data-test="import-detection"]').text()).toContain(STORE)
    })

    it('nothing found on macOS: says so and keeps the manual path', async () => {
      mock([])
      const w = await open('')
      expect(w.get('[data-test="import-none-found"]').text()).toContain('No se encontró Navicat')
      expect(w.find('[data-test="import-root"]').exists()).toBe(true)
    })

    it('«Detectar» with an empty path searches again', async () => {
      mock([])
      const w = await open('')
      await w.get('[data-test="import-detect"]').trigger('click')
      await settle(8)
      expect(calls(invoke, 'navicat:findCandidates')).toHaveLength(2)
      expect(calls(invoke, 'navicat:detect')).toHaveLength(0)
    })

    it('from the welcome tour («Sí, importar»): detected and straight to «Seleccionar»', async () => {
      mock([cand(NAV, 4)])
      const w = await open('', { rootPath: NAV })
      expect(calls(invoke, 'navicat:findCandidates')).toHaveLength(0)
      expect(calls(invoke, 'navicat:detect')).toEqual([[NAV]])
      expect(w.find('[data-test="import-connections"]').exists()).toBe(true)
      expect(w.text()).toContain('Paso 2 de 3')
      expect(useUiStore().importDialogRequest).toBeNull()
    })

    it('from the welcome tour («No es esta carpeta»): step 1, no single-folder question again', async () => {
      mock([cand(NAV, 4)])
      const w = await open(NAV, { chooseFolder: true })
      expect(w.text()).toContain('Paso 1 de 3')
      expect(w.find('[data-test="import-proposal"]').exists()).toBe(false)
      expect((w.get('[data-test="import-root"] input').element as HTMLInputElement).value).toBe('')
      expect(w.find('[data-test="import-pick"]').exists()).toBe(true)
    })
  })
})
