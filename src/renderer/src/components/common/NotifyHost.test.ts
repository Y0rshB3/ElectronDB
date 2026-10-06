import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createTestVuetify, flush, installDomPolyfills } from '@renderer/__tests__/shellTestUtils'
import { useNotify } from '@renderer/composables/useNotify'
import NotifyHost from './NotifyHost.vue'

describe('NotifyHost', () => {
  beforeEach(() => {
    installDomPolyfills()
    document.body.innerHTML = ''
  })
  afterEach(() => {
    const notify = useNotify()
    for (const n of [...notify.queue]) notify.dismiss(n.id)
    document.body.innerHTML = ''
  })

  it('shows the optional action and closes the message after running it', async () => {
    const handler = vi.fn()
    const notify = useNotify()
    notify.success('Copia creada', { label: 'Mostrar en Finder', handler })
    expect(notify.queue[0].timeout).toBe(8000)
    mount(NotifyHost, {
      global: { plugins: [createTestVuetify()] },
      attachTo: document.body
    })
    await flush()
    const button = document.querySelector<HTMLButtonElement>('[data-test="notify-action"]')
    expect(button?.textContent).toContain('Mostrar en Finder')
    button!.click()
    await flush()
    expect(handler).toHaveBeenCalledOnce()
    expect(notify.queue).toHaveLength(0)
  })

  it('has no action button for plain messages', async () => {
    useNotify().info('Hola')
    mount(NotifyHost, {
      global: { plugins: [createTestVuetify()] },
      attachTo: document.body
    })
    await flush()
    expect(document.querySelector('[data-test="notify-message"]')?.textContent).toBe('Hola')
    expect(document.querySelector('[data-test="notify-action"]')).toBeNull()
  })
})
