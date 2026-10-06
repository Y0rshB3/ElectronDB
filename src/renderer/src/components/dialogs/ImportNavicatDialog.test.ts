import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mock } from 'vitest'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore } from '@renderer/stores/ui'
import ImportNavicatDialog from './ImportNavicatDialog.vue'
import { calls, freshPinia, mockElectronDB, mountWith, settle } from './testing'

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
    invoke = mockElectronDB({
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
      'navicat:recoverPasswords': () => ({
        attempted: 2,
        recovered: [{ account: 'a', connectionName: 'Local' }],
        warnings: []
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

    await wrapper.get('[data-test="import-recover"]').trigger('click')
    await settle()
    expect(calls(invoke, 'navicat:recoverPasswords')).toHaveLength(1)
    expect(wrapper.get('[data-test="import-recovery"]').text()).toContain('Recuperadas 1 de 2')
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
        ;(window.electronDB as { platform?: string }).platform = os
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
})
