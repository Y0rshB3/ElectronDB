import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, onActivated, onUnmounted, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useTabsStore } from '@renderer/stores/tabs'
import { useUiStore } from '@renderer/stores/ui'
import {
  createTestVuetify,
  flush,
  installBridge,
  installDomPolyfills
} from '@renderer/__tests__/shellTestUtils'

const lifecycle = { mounted: 0, unmounted: 0, activated: 0 }

// Lightweight stand-in for every lazily loaded view.
vi.mock('@renderer/views/registry', () => {
  const StubView = defineComponent({
    props: { tab: { type: Object, required: true } },
    setup(props) {
      const counter = ref(0)
      lifecycle.mounted++
      onActivated(() => lifecycle.activated++)
      onUnmounted(() => lifecycle.unmounted++)
      return () =>
        h('div', { 'data-test': 'stub-view' }, [
          h('span', { class: 'stub-title' }, (props.tab as { title: string }).title),
          h('button', { class: 'stub-inc', onClick: () => counter.value++ }, String(counter.value))
        ])
    }
  })
  return { viewFor: () => StubView, VIEW_REGISTRY: {} }
})

const { default: WorkspaceTabs } = await import('./WorkspaceTabs.vue')

function mountTabs() {
  return mount(WorkspaceTabs, {
    global: { plugins: [createTestVuetify()] },
    attachTo: document.body
  })
}

describe('WorkspaceTabs', () => {
  beforeEach(() => {
    installDomPolyfills()
    installBridge()
    setActivePinia(createPinia())
    lifecycle.mounted = lifecycle.unmounted = lifecycle.activated = 0
  })

  it('renders the fixed Objetos tab without a close button', () => {
    const wrapper = mountTabs()
    const tab = wrapper.get('[data-test="tab-objects"]')
    expect(tab.text()).toContain('Objetos')
    expect(tab.find('[data-test="tab-close"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('closes clean tabs immediately', async () => {
    const tabs = useTabsStore()
    tabs.open({ kind: 'query', id: 'q1', title: 'Consulta (Dev)' })
    const wrapper = mountTabs()
    await wrapper.get('[data-tab-id="q1"] [data-test="tab-close"]').trigger('click')
    await flush()
    expect(tabs.tabs.map((t) => t.id)).toEqual(['objects'])
    expect(tabs.activeId).toBe('objects')
    wrapper.unmount()
  })

  it('asks before closing a dirty tab and keeps it when cancelled', async () => {
    const tabs = useTabsStore()
    const ui = useUiStore()
    tabs.open({ kind: 'tableData', id: 't1', title: 'users@shop (Dev)' })
    tabs.setDirty('t1', true)
    const wrapper = mountTabs()
    expect(wrapper.find('[data-tab-id="t1"] [data-test="tab-dirty"]').exists()).toBe(true)

    await wrapper.get('[data-tab-id="t1"] [data-test="tab-close"]').trigger('click')
    expect(ui.confirm.open).toBe(true)
    expect(ui.confirm.message).toContain('users@shop (Dev)')
    ui.answer(false)
    await flush()
    expect(tabs.tabs.some((t) => t.id === 't1')).toBe(true)

    await wrapper.get('[data-tab-id="t1"] [data-test="tab-close"]').trigger('click')
    ui.answer(true)
    await flush()
    expect(tabs.tabs.some((t) => t.id === 't1')).toBe(false)
    wrapper.unmount()
  })

  it('closes on middle click', async () => {
    const tabs = useTabsStore()
    tabs.open({ kind: 'query', id: 'q1', title: 'Consulta' })
    const wrapper = mountTabs()
    await wrapper.get('[data-tab-id="q1"]').trigger('auxclick', { button: 1 })
    await flush()
    expect(tabs.tabs.some((t) => t.id === 'q1')).toBe(false)
    wrapper.unmount()
  })

  it('keeps each tab view alive while switching and destroys it when closed', async () => {
    const tabs = useTabsStore()
    const wrapper = mountTabs()
    tabs.open({ kind: 'query', id: 'q1', title: 'Consulta A' })
    await flush()
    await wrapper.get('.stub-inc').trigger('click')
    expect(wrapper.get('.stub-inc').text()).toBe('1')

    tabs.activate('objects')
    await flush()
    tabs.activate('q1')
    await flush()
    expect(wrapper.get('.stub-title').text()).toBe('Consulta A')
    expect(wrapper.get('.stub-inc').text()).toBe('1')
    expect(lifecycle.activated).toBeGreaterThan(1)

    const unmountedBefore = lifecycle.unmounted
    tabs.close('q1')
    await flush()
    expect(lifecycle.unmounted).toBe(unmountedBefore + 1)

    // Reopening the same id starts from a fresh instance.
    tabs.open({ kind: 'query', id: 'q1', title: 'Consulta A' })
    await flush()
    expect(wrapper.get('.stub-inc').text()).toBe('0')
    wrapper.unmount()
  })

  it('keeps alive tabs whose id contains a comma (table `a,b`)', async () => {
    const tabs = useTabsStore()
    const wrapper = mountTabs()
    tabs.open({ kind: 'tableData', id: 'tableData:c1:shop:a,b', title: 'a,b@shop (Dev)' })
    await flush()
    await wrapper.get('.stub-inc').trigger('click')
    const unmountedBefore = lifecycle.unmounted

    tabs.activate('objects')
    await flush()
    tabs.activate('tableData:c1:shop:a,b')
    await flush()
    expect(wrapper.get('.stub-inc').text()).toBe('1')
    expect(lifecycle.unmounted).toBe(unmountedBefore)
    wrapper.unmount()
  })
})
