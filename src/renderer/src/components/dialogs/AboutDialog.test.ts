import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mock } from 'vitest'
import { useUiStore } from '@renderer/stores/ui'
import AboutDialog from './AboutDialog.vue'
import { calls, freshPinia, mockVortaq, mountWith, settle } from './testing'

const RULE = '='.repeat(78)
const notices = [
  'Vortaq 2.0.0 — Licencias de terceros\n\nComponentes: 2',
  `${RULE}\n@mdi/font 7.4.47\nLicencia: Apache-2.0\n\n--- LICENSE ---\n\nPictogrammers Free License`,
  `${RULE}\nvue 3.5.42\nLicencia: MIT\n\n--- LICENSE ---\n\nCopyright (c) Evan You`,
  RULE
].join('\n\n')

describe('AboutDialog', () => {
  let invoke: Mock
  let wrapper: ReturnType<typeof mountWith> | null = null

  beforeEach(() => {
    invoke = mockVortaq({
      'app:info': () => ({ name: 'Vortaq', version: '2.0.0', electron: '44.3.0' }),
      'app:licenses': () => ({
        license: 'MIT License\n\nCopyright (c) 2026 Y0rshB3',
        thirdParty: notices,
        thirdPartyPath: '/res/THIRD_PARTY_LICENSES.txt',
        repositoryUrl: 'https://github.com/Y0rshB3/ElectronDB'
      })
    })
  })
  afterEach(() => wrapper?.unmount())

  async function openDialog() {
    const pinia = freshPinia()
    wrapper = mountWith(AboutDialog, pinia)
    useUiStore().openAboutDialog()
    await settle()
    return wrapper
  }

  it('shows the version, the licence and the trademark note', async () => {
    const w = await openDialog()
    expect(w.get('[data-test="about-version"]').text()).toContain('Versión 2.0.0')
    expect(w.text()).toContain('licencia MIT')
    expect(w.text()).toContain('no está afiliado, patrocinado ni respaldado por')
    await w.get('[data-test="about-show-license"]').trigger('click')
    expect(w.get('[data-test="about-license-text"]').text()).toContain('Copyright (c) 2026 Y0rshB3')
  })

  it('opens the repository through main (no URL from the renderer)', async () => {
    const w = await openDialog()
    await w.get('[data-test="about-repository"]').trigger('click')
    await settle()
    expect(calls(invoke, 'app:openRepository')).toEqual([[]])
  })

  it('lists and filters the third-party notices and opens the file', async () => {
    const w = await openDialog()
    await w.get('[data-test="about-third-party"]').trigger('click')
    await settle()
    expect(w.get('[data-test="about-notices-count"]').text()).toBe('2 / 2')
    expect(w.get('[data-test="about-notices"]').text()).toContain('@mdi/font 7.4.47')
    await w.get('[data-test="about-notices-filter"] input').setValue('vue')
    await settle()
    expect(w.get('[data-test="about-notices-count"]').text()).toBe('1 / 2')
    await w.get('[data-test="about-open-notices"]').trigger('click')
    await settle()
    expect(calls(invoke, 'app:openPath')).toEqual([['/res/THIRD_PARTY_LICENSES.txt']])
  })

  it('explains when the notices were not generated (development)', async () => {
    invoke.mockImplementation(async (channel: string) =>
      channel === 'app:licenses'
        ? { license: 'MIT', thirdParty: null, thirdPartyPath: null, repositoryUrl: '' }
        : { version: '2.0.0', electron: '44.3.0' }
    )
    const w = await openDialog()
    await w.get('[data-test="about-third-party"]').trigger('click')
    await settle()
    expect(w.text()).toContain('npm run build')
    expect(w.find('[data-test="about-open-notices"]').exists()).toBe(false)
  })
})
