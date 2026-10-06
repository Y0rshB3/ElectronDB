import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ConnectionTree from './ConnectionTree.vue'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useUiStore } from '@renderer/stores/ui'
import {
  createTestVuetify,
  flush,
  installBridge,
  installDomPolyfills,
  makeConnection,
  makeServerInfo
} from '@renderer/__tests__/shellTestUtils'

function mountTree() {
  return mount(ConnectionTree, {
    global: { plugins: [createTestVuetify()] },
    attachTo: document.body
  })
}

describe('ConnectionTree', () => {
  beforeEach(() => {
    installDomPolyfills()
    setActivePinia(createPinia())
  })

  it('renders one row per connection with its colour marker and environment chip', async () => {
    installBridge({
      'connections:list': [
        makeConnection({ id: 'p', name: 'Prod', color: '#ff5252', environment: 'production' }),
        makeConnection({ id: 'l', name: 'Local', color: null, environment: 'local' })
      ]
    })
    await useConnectionsStore().load()
    const wrapper = mountTree()
    await flush()

    const rows = wrapper.findAll('[data-test="tree-node-connection"]')
    expect(rows.map((r) => r.find('.tree-node__label').text())).toEqual(['Local', 'Prod'])

    const prod = rows[1]
    expect(prod.get('[data-test="connection-color"]').attributes('style')).toMatch(
      /background: (#ff5252|rgb\(255, 82, 82\))/
    )
    expect(prod.get('[data-test="env-chip"]').text()).toBe('Producción')
    expect(prod.get('.tree-node__row').classes()).toContain('tree-node__row--production')

    const local = rows[0]
    expect(local.get('[data-test="connection-color"]').attributes('style')).toContain('transparent')
    expect(local.get('[data-test="env-chip"]').text()).toBe('Local')
    wrapper.unmount()
  })

  it('shows closed connections dimmed and open ones with their schemas after expanding', async () => {
    installBridge({
      'connections:list': [makeConnection({ id: 'c1', name: 'Dev' })],
      'connections:open': () => makeServerInfo(),
      'db:databases': () => [
        { name: 'shop', characterSet: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }
      ]
    })
    await useConnectionsStore().load()
    const wrapper = mountTree()
    await flush()
    const row = wrapper.get('[data-test="tree-node-connection"] .tree-node__row')
    expect(row.classes()).toContain('tree-node__row--closed')

    await row.trigger('dblclick')
    await flush()
    await flush()
    expect(
      wrapper.get('[data-test="tree-node-connection"] .tree-node__row').classes()
    ).not.toContain('tree-node__row--closed')
    expect(wrapper.find('[data-test="tree-node-schema"]').text()).toContain('shop')
    wrapper.unmount()
  })

  it('offers the Navicat import CTA when there are no connections', async () => {
    installBridge({ 'connections:list': [] })
    await useConnectionsStore().load()
    const wrapper = mountTree()
    await flush()
    await wrapper.get('[data-test="import-cta"]').trigger('click')
    expect(useUiStore().importDialog).toBe(true)
    wrapper.unmount()
  })
})
