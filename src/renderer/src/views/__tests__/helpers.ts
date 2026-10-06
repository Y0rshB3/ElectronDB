import { defineComponent, h, type Component } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { vi } from 'vitest'
import { createVuetify } from 'vuetify'
import * as vuetifyComponents from 'vuetify/components'
import * as vuetifyDirectives from 'vuetify/directives'
import { aliases, mdi } from 'vuetify/iconsets/mdi'
import type { ConnectionConfig, Environment } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useTabsStore, type OpenTabInput, type WorkspaceTab } from '@renderer/stores/tabs'

export type Handlers = Record<string, (...args: unknown[]) => unknown>

/** Installs a fake window.electronDB whose invoke dispatches to one vi.fn per channel. */
export function mockBridge(handlers: Handlers): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    const handler = handlers[channel]
    if (!handler) throw new Error(`Canal no simulado: ${channel}`)
    return handler(...args)
  })
  window.electronDB = { invoke, on: vi.fn(() => () => {}) } as never
  return invoke
}

/** Lightweight replacement for the CodeMirror editor, which needs real layout. */
export const SqlEditorStub = defineComponent({
  name: 'SqlEditor',
  props: { modelValue: { type: String, default: '' }, readonly: Boolean },
  emits: ['update:modelValue', 'run', 'save', 'beautify'],
  setup(props, { emit, expose }) {
    expose({ getSelection: () => '', replaceSelection: () => undefined, focus: () => undefined })
    return () =>
      h('textarea', {
        'data-test': 'sql-editor',
        value: props.modelValue,
        readonly: props.readonly,
        onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLTextAreaElement).value)
      })
  }
})

// The app auto-imports Vuetify components via vite-plugin-vuetify, which vitest
// does not use, so they are registered explicitly for view tests.
const vuetify = createVuetify({
  components: vuetifyComponents,
  directives: vuetifyDirectives,
  icons: { defaultSet: 'mdi', aliases, sets: { mdi } },
  theme: {
    defaultTheme: 'electrondbDark',
    themes: { electrondbDark: { dark: true }, electrondbLight: { dark: false } }
  }
})

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

export function setupDom(): Pinia {
  globalThis.ResizeObserver ??= ResizeObserverStub as never
  // Vuetify menus position against the visual viewport, which jsdom lacks.
  ;(globalThis as { visualViewport?: unknown }).visualViewport ??= {
    width: 1280,
    height: 800,
    offsetLeft: 0,
    offsetTop: 0,
    pageLeft: 0,
    pageTop: 0,
    scale: 1,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }
  document.elementsFromPoint ??= () => []
  const pinia = createPinia()
  setActivePinia(pinia)
  return pinia
}

export function openTab(input: OpenTabInput): WorkspaceTab {
  return useTabsStore().open(input)
}

export async function mountView(view: Component, tab: WorkspaceTab, pinia: Pinia) {
  const wrapper = mount(view, {
    props: { tab },
    attachTo: document.body,
    global: { plugins: [pinia, vuetify], stubs: { SqlEditor: SqlEditorStub } }
  })
  await flushPromises()
  return wrapper
}

/** Mounts any component with the test Vuetify + Pinia (props as given). */
export async function mountComponent(
  component: Component,
  props: Record<string, unknown>,
  pinia: Pinia
) {
  const wrapper = mount(component, {
    props,
    attachTo: document.body,
    global: { plugins: [pinia, vuetify], stubs: { SqlEditor: SqlEditorStub } }
  })
  await flushPromises()
  return wrapper
}

/** Registers connection `id` in the connections store with the given environment. */
export function seedConnection(id: string, environment: Environment, name = 'Servidor'): void {
  useConnectionsStore().items = [{ id, name, environment } as ConnectionConfig]
}

/** Successful db:execute result for every statement-shaped call. */
export const okExecute = (_c: unknown, sql: unknown) => [
  {
    sql,
    durationMs: 1,
    affectedRows: 0,
    insertId: null,
    changedRows: null,
    warnings: 0,
    resultSet: null,
    error: null
  }
]
