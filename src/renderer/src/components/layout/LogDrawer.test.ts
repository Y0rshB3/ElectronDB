import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useLogStore } from '@renderer/stores/log'
import { useUiStore } from '@renderer/stores/ui'
import {
  createTestVuetify,
  flush,
  installBridge,
  installDomPolyfills
} from '@renderer/__tests__/shellTestUtils'
import LogDrawer from './LogDrawer.vue'

describe('LogDrawer', () => {
  beforeEach(() => {
    installDomPolyfills()
    setActivePinia(createPinia())
  })

  it('renders only the last 500 event:log lines', async () => {
    const bridge = installBridge()
    const log = useLogStore()
    log.listen()
    useUiStore().toggleLogDrawer(true)
    for (let i = 0; i < 520; i++)
      bridge.emit('event:log', {
        level: i % 2 ? 'info' : 'warn',
        scope: 'test',
        message: `linea ${i}`,
        at: '2026-01-01T00:00:00.000Z'
      })
    const wrapper = mount(LogDrawer, { global: { plugins: [createTestVuetify()] } })
    await flush()
    const lines = wrapper.findAll('.log-drawer__line')
    expect(lines).toHaveLength(500)
    expect(lines[0].text()).toContain('linea 20')
    expect(lines[499].text()).toContain('linea 519')
    expect(wrapper.text()).toContain('Registro (500)')
    wrapper.unmount()
  })

  it('is hidden until opened', () => {
    installBridge()
    const wrapper = mount(LogDrawer, { global: { plugins: [createTestVuetify()] } })
    expect(wrapper.find('[data-test="log-drawer"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
