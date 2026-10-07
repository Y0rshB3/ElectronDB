/**
 * Test helpers for dialog/view specs (web project). Not imported by app code.
 */
import { flushPromises, mount, type ComponentMountingOptions } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { vi, type Mock } from 'vitest'
import type { Component } from 'vue'
import type { BackupFile, ConnectionConfig, Job } from '@shared/types'
import { createVuetify } from 'vuetify'
import * as vuetifyComponents from 'vuetify/components'
import * as vuetifyDirectives from 'vuetify/directives'
import { aliases, mdi } from 'vuetify/iconsets/mdi'

type Handler = (...args: unknown[]) => unknown

export function installBrowserShims(): void {
  const g = globalThis as unknown as Record<string, unknown>
  if (!g.ResizeObserver) {
    g.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
}

/** Installs a fake window.vortaq whose invoke dispatches to the given handlers. */
export function mockVortaq(handlers: Record<string, Handler>): Mock {
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    const handler = handlers[channel]
    return handler ? handler(...args) : undefined
  })
  window.vortaq = { invoke, on: vi.fn(() => () => {}) } as never
  return invoke
}

export function freshPinia(): Pinia {
  const pinia = createPinia()
  setActivePinia(pinia)
  return pinia
}

// The app registers Vuetify components through vite-plugin-vuetify auto-import,
// which the vitest config does not use, so register them explicitly here.
const vuetify = createVuetify({
  components: vuetifyComponents,
  directives: vuetifyDirectives,
  icons: { defaultSet: 'mdi', aliases, sets: { mdi } },
  theme: {
    defaultTheme: 'vortaqDark',
    themes: { vortaqDark: { dark: true }, vortaqLight: { dark: false } }
  }
})

const stubs = {
  // Render dialog content inline so it can be queried from the wrapper.
  VDialog: { template: '<div class="v-dialog-stub"><slot /></div>' },
  SqlEditor: {
    props: ['modelValue'],
    template: '<pre class="sql-editor-stub">{{ modelValue }}</pre>'
  }
}

export function mountWith<C extends Component>(
  component: C,
  pinia: Pinia,
  options: ComponentMountingOptions<C> = {} as ComponentMountingOptions<C>
) {
  installBrowserShims()
  return mount(component, {
    ...options,
    global: { plugins: [pinia, vuetify], stubs, ...(options.global ?? {}) },
    attachTo: document.body
  } as ComponentMountingOptions<C>)
}

export async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await flushPromises()
}

export function calls(invoke: Mock, channel: string): unknown[][] {
  return invoke.mock.calls.filter((c) => c[0] === channel).map((c) => c.slice(1))
}

export function makeConnection(
  partial: Partial<ConnectionConfig> & { id: string; name: string }
): ConnectionConfig {
  return {
    engine: 'mysql',
    color: null,
    environment: 'local',
    host: '127.0.0.1',
    port: 3306,
    username: 'root',
    savePassword: true,
    customDatabases: [],
    initialQueries: '',
    ssh: {
      enabled: false,
      host: '',
      port: 22,
      username: '',
      authType: 'password',
      savePassword: false
    },
    ssl: { enabled: false, verifyServer: true },
    backupDir: '/tmp/backups',
    extraBackupDirs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial
  }
}

export function makeBackup(partial: Partial<BackupFile> & { path: string }): BackupFile {
  const fileName = partial.path.split('/').pop() ?? partial.path
  return {
    fileName,
    connectionId: 'c1',
    schema: 'billing',
    sizeBytes: 2048,
    createdAt: '2026-03-17T14:51:20.000Z',
    modifiedAt: '2026-03-17T14:51:20.000Z',
    source: 'electrondb',
    label: null,
    ...partial
  }
}

export function makeJob(partial: Partial<Job> & { id: string; name: string }): Job {
  return {
    continueOnError: true,
    tasks: [],
    schedule: { enabled: false, cron: '0 2 * * *', launchAgent: false },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastRunAt: null,
    ...partial
  }
}
