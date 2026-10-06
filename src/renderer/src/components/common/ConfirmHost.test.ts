import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useConfirm } from '@renderer/composables/useConfirm'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore } from '@renderer/stores/ui'
import {
  createTestVuetify,
  flush,
  installBridge,
  installDomPolyfills,
  makeConnection
} from '@renderer/__tests__/shellTestUtils'
import ConfirmHost from './ConfirmHost.vue'

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)

async function typeInto(value: string): Promise<void> {
  const input = q<HTMLInputElement>('[data-test="confirm-typed"] input')!
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flush()
}

describe('ConfirmHost production confirmation', () => {
  beforeEach(async () => {
    installDomPolyfills()
    setActivePinia(createPinia())
    installBridge({
      'connections:list': [
        makeConnection({ id: 'prod', name: 'Ventas PROD', environment: 'production' }),
        makeConnection({ id: 'stg', name: 'Ventas PRE', environment: 'staging' })
      ],
      'settings:get': {
        navicatRootPath: '',
        backupsRootDir: '',
        defaultRowLimit: 1000,
        theme: 'dark',
        typedConfirmEnvironments: ['production']
      }
    })
    await useConnectionsStore().load()
    await useSettingsStore().load()
    document.body.innerHTML = ''
  })

  it('keeps the confirm button disabled until the connection name is typed', async () => {
    const wrapper = mount(ConfirmHost, {
      global: { plugins: [createTestVuetify()] },
      attachTo: document.body
    })
    const answer = useConfirm().confirmDestructive({
      connectionId: 'prod',
      title: 'Truncar tabla',
      message: 'Se borrarán todas las filas.',
      details: 'TRUNCATE TABLE `shop`.`users`'
    })
    await flush()
    await flush()

    expect(useUiStore().confirm.requireTyped).toBe('Ventas PROD')
    expect(q('[data-test="confirm-production"]')).not.toBeNull()
    const ok = () => q<HTMLButtonElement>('[data-test="confirm-ok"]')!
    expect(ok().disabled).toBe(true)

    await typeInto('ventas prod')
    expect(ok().disabled).toBe(true)

    await typeInto('Ventas PROD')
    expect(ok().disabled).toBe(false)
    ok().click()
    await expect(answer).resolves.toBe(true)
    wrapper.unmount()
  })

  it('a staging connection listed in Ajustes asks for its name with a banner naming the environment', async () => {
    useSettingsStore().settings.typedConfirmEnvironments = ['production', 'staging']
    const wrapper = mount(ConfirmHost, {
      global: { plugins: [createTestVuetify()] },
      attachTo: document.body
    })
    const answer = useConfirm().confirmDestructive({
      connectionId: 'stg',
      title: 'Truncar tabla',
      message: 'Se borrarán todas las filas.'
    })
    await flush()
    await flush()
    expect(q('[data-test="confirm-production"]')!.textContent).toContain(
      'Entorno STAGING · requiere escribir el nombre'
    )
    expect(q('[data-test="confirm-message"]')!.textContent).toContain(
      'La conexión «Ventas PRE» (entorno Staging) requiere confirmación: escribe su nombre'
    )
    expect(q('[data-test="confirm-ok"]')!.textContent).toContain('Ejecutar en «Ventas PRE»')
    await typeInto('Ventas PRE')
    q<HTMLButtonElement>('[data-test="confirm-ok"]')!.click()
    await expect(answer).resolves.toBe(true)
    wrapper.unmount()
  })

  it('a staging connection that is not listed never asks for the name', async () => {
    const wrapper = mount(ConfirmHost, {
      global: { plugins: [createTestVuetify()] },
      attachTo: document.body
    })
    const answer = useConfirm().confirmDestructive({
      connectionId: 'stg',
      title: 'Crear tabla',
      message: 'Se creará la tabla.',
      alwaysAsk: false
    })
    await flush()
    await expect(answer).resolves.toBe(true)
    expect(useUiStore().confirm.open).toBe(false)
    wrapper.unmount()
  })

  it('is persistent: Escape does not dismiss a production confirmation', async () => {
    const wrapper = mount(ConfirmHost, {
      global: { plugins: [createTestVuetify()] },
      attachTo: document.body
    })
    const ui = useUiStore()
    const answer = useConfirm().confirmDestructive({
      connectionId: 'prod',
      title: 'Eliminar tabla',
      message: 'Se eliminará users.'
    })
    await flush()
    await flush()
    const content = q('.v-overlay__content')!
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()
    expect(ui.confirm.open).toBe(true)

    q<HTMLButtonElement>('[data-test="confirm-cancel"]')!.click()
    await expect(answer).resolves.toBe(false)
    wrapper.unmount()
  })

  it('non-production confirmations need no typing', async () => {
    const wrapper = mount(ConfirmHost, {
      global: { plugins: [createTestVuetify()] },
      attachTo: document.body
    })
    const answer = useUiStore().ask({ title: 'Eliminar', message: '¿Seguro?' })
    await flush()
    await flush()
    expect(q('[data-test="confirm-typed"]')).toBeNull()
    q<HTMLButtonElement>('[data-test="confirm-ok"]')!.click()
    await expect(answer).resolves.toBe(true)
    wrapper.unmount()
  })

  it('destructive confirmations show the connection, the affected items and focus Cancelar', async () => {
    const wrapper = mount(ConfirmHost, {
      global: { plugins: [createTestVuetify()] },
      attachTo: document.body
    })
    const answer = useUiStore().ask({
      title: '¿Ejecutar 1 sentencia destructiva?',
      message: 'Revisa lo que se va a borrar.',
      danger: true,
      color: 'error',
      confirmText: 'Ejecutar',
      connection: { name: 'Local dev', environment: 'local' },
      items: [
        { tag: 'DELETE', text: 'DELETE FROM log', warning: 'sin WHERE: afecta a todas las filas' }
      ]
    })
    await flush()
    await flush()
    expect(q('[data-test="confirm-connection"]')!.textContent).toContain('Local dev')
    expect(q('[data-test="confirm-connection"] .nd-pill')!.textContent).toContain('Local')
    expect(q('[data-test="confirm-items"]')!.textContent).toContain('DELETE FROM log')
    expect(q('[data-test="confirm-item-warning"]')!.textContent).toContain(
      'afecta a todas las filas'
    )
    expect(q('[data-test="confirm-typed"]')).toBeNull()
    const cancel = q<HTMLButtonElement>('[data-test="confirm-cancel"]')!
    const ok = q<HTMLButtonElement>('[data-test="confirm-ok"]')!
    expect(ok.textContent).toContain('Ejecutar')
    expect(cancel.hasAttribute('autofocus')).toBe(true)
    expect(ok.hasAttribute('autofocus')).toBe(false)
    cancel.click()
    await expect(answer).resolves.toBe(false)
    wrapper.unmount()
  })
})
