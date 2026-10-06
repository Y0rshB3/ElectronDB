import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createPinia } from 'pinia'
import {
  createTestVuetify,
  flush,
  installBridge,
  installDomPolyfills,
  makeConnection,
  makeServerInfo,
  makeTable,
  type MockBridge
} from './shellTestUtils'

// Dialogs are owned and tested elsewhere; the shell only needs them mounted.
function stubDialog(name: string) {
  return {
    default: defineComponent({
      name,
      setup: () => () => h('div', { 'data-test': `dialog-${name}` })
    })
  }
}
vi.mock('../components/dialogs/ConnectionDialog.vue', () => stubDialog('ConnectionDialog'))
vi.mock('../components/dialogs/ImportNavicatDialog.vue', () => stubDialog('ImportNavicatDialog'))
vi.mock('../components/dialogs/SettingsDialog.vue', () => stubDialog('SettingsDialog'))
vi.mock('../components/dialogs/NewDatabaseDialog.vue', () => stubDialog('NewDatabaseDialog'))
vi.mock('../components/dialogs/BackupDialog.vue', () => stubDialog('BackupDialog'))
vi.mock('../components/dialogs/RestoreDialog.vue', () => stubDialog('RestoreDialog'))

const { default: App } = await import('../App.vue')
const { useUiStore } = await import('../stores/ui')
const { useTabsStore } = await import('../stores/tabs')
const { useConnectionsStore } = await import('../stores/connections')
const { useProgressStore } = await import('../stores/progress')
const { useLogStore } = await import('../stores/log')
const { unsubscribeFromMainEvents } = await import('../composables/useAppBootstrap')

const settings = {
  navicatRootPath: '',
  backupsRootDir: '',
  defaultRowLimit: 1000,
  theme: 'dark',
  confirmProductionWrites: true
}

function mountApp() {
  const pinia = createPinia()
  const wrapper = mount(App, {
    global: { plugins: [pinia, createTestVuetify()] },
    attachTo: document.body
  })
  return { wrapper, pinia }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await flush()
}

describe('App shell', () => {
  let bridge: MockBridge

  beforeEach(() => {
    installDomPolyfills()
    bridge = installBridge({
      'settings:get': settings,
      'connections:list': [makeConnection({ id: 'c1', name: 'Dev', environment: 'staging' })],
      'connections:open': () => makeServerInfo(),
      'db:databases': () => [
        { name: 'shop', characterSet: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }
      ],
      'db:tables': () => [makeTable('users')],
      'jobs:list': [],
      'jobs:runs': [],
      'backups:cancel': undefined,
      'jobs:cancel': undefined
    })
  })

  afterEach(() => {
    unsubscribeFromMainEvents()
    document.body.innerHTML = ''
  })

  it('mounts the Navicat-like layout and loads startup data', async () => {
    const { wrapper } = mountApp()
    await settle()
    expect(wrapper.find('.app-toolbar').exists()).toBe(true)
    expect(wrapper.find('.connection-tree').exists()).toBe(true)
    expect(wrapper.find('[data-test="tab-objects"]').exists()).toBe(true)
    expect(wrapper.find('.info-panel').exists()).toBe(true)
    expect(wrapper.get('[data-test="status-connections"]').text()).toBe(
      '1 Conexión en Mis Conexiones'
    )
    for (const name of [
      'ConnectionDialog',
      'ImportNavicatDialog',
      'SettingsDialog',
      'NewDatabaseDialog',
      'BackupDialog',
      'RestoreDialog'
    ])
      expect(wrapper.find(`[data-test="dialog-${name}"]`).exists()).toBe(true)

    const channels = bridge.invoke.mock.calls.map(([ch]) => ch)
    expect(channels).toEqual(
      expect.arrayContaining(['settings:get', 'connections:list', 'jobs:list'])
    )
    for (const ev of ['event:progress', 'event:log'] as const)
      expect(bridge.listenerCount(ev)).toBe(1)
    // jobs store (run history) + progress store (closes finished job entries).
    expect(bridge.listenerCount('event:jobRun')).toBe(2)
    expect(bridge.listenerCount('event:connectionClosed')).toBe(2)
    expect(useUiStore().importDialog).toBe(false)
    expect(wrapper.text()).toContain('Dev')
    wrapper.unmount()
  })

  it('opens the Navicat import dialog when there are no connections', async () => {
    installBridge({
      'settings:get': settings,
      'connections:list': [],
      'jobs:list': [],
      'jobs:runs': []
    })
    const { wrapper } = mountApp()
    await settle()
    expect(useUiStore().importDialog).toBe(true)
    wrapper.unmount()
  })

  it('shows a startup notice once, without Cancelar, and dismisses it in main', async () => {
    const dismissed: unknown[] = []
    installBridge({
      'settings:get': settings,
      'connections:list': [makeConnection({ id: 'c1', name: 'Dev' })],
      'jobs:list': [],
      'jobs:runs': [],
      'app:startupNotices': [
        {
          id: 'reenter-passwords',
          level: 'warning',
          title: 'Contraseñas que hay que volver a escribir',
          message: 'Vuelve a escribir la contraseña de: Dev, Prod (SSH).'
        }
      ],
      'app:dismissStartupNotice': (id: unknown) => {
        dismissed.push(id)
      }
    })
    const { wrapper } = mountApp()
    await settle()
    const dialog = document.querySelector('[data-test="confirm-message"]')
    expect(dialog?.textContent).toContain('Vuelve a escribir la contraseña de: Dev, Prod (SSH)')
    expect(document.querySelector('[data-test="confirm-cancel"]')).toBeNull()
    expect(dismissed).toEqual([])
    ;(document.querySelector('[data-test="confirm-ok"]') as HTMLElement).click()
    await settle()
    expect(dismissed).toEqual(['reenter-passwords'])
    expect(useUiStore().confirm.open).toBe(false)
    wrapper.unmount()
  })

  it('wires push events to the stores', async () => {
    const { wrapper } = mountApp()
    await settle()
    const connections = useConnectionsStore()
    await connections.open('c1')

    bridge.emit('event:connectionClosed', { connectionId: 'c1', reason: 'servidor reiniciado' })
    expect(connections.isOpen('c1')).toBe(false)

    bridge.emit('event:log', {
      level: 'error',
      scope: 'backup',
      message: 'fallo',
      at: new Date().toISOString()
    })
    expect(useLogStore().entries).toHaveLength(1)

    bridge.emit('event:progress', {
      operationId: 'backup-1',
      kind: 'backup',
      phase: 'Datos',
      current: 2,
      total: 4,
      message: 'Exportando users',
      done: false
    })
    await flush()
    expect(useProgressStore().active).toHaveLength(1)
    expect(wrapper.get('[data-test="status-progress"]').text()).toContain('Exportando users (2/4)')
    const overlay = document.querySelector('[data-test="progress-overlay"]')
    expect(overlay?.textContent).toContain('Copia de seguridad')
    ;(document.querySelector('[data-test="progress-cancel"]') as HTMLElement).click()
    await flush()
    expect(bridge.invoke).toHaveBeenCalledWith('backups:cancel', 'backup-1')
    wrapper.unmount()
  })

  it('cancels a running job through jobs:cancel and clears it when the run ends', async () => {
    const { wrapper } = mountApp()
    await settle()
    bridge.emit('event:progress', {
      operationId: 'run-7',
      kind: 'job',
      phase: 'Copia',
      current: 1,
      total: 2,
      message: 'Ejecutando tarea',
      done: false
    })
    await flush()
    expect(wrapper.get('[data-test="status-progress"]').text()).toContain('Ejecutando tarea')
    ;(document.querySelector('[data-test="progress-cancel"]') as HTMLElement).click()
    await flush()
    expect(bridge.invoke).toHaveBeenCalledWith('jobs:cancel', 'run-7')

    bridge.emit('event:jobRun', {
      id: 'run-7',
      jobId: 'j1',
      jobName: 'Nocturna',
      status: 'cancelled',
      trigger: 'manual',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
      tasks: [],
      logPath: '/tmp/x.log'
    })
    await flush()
    expect(useProgressStore().active).toHaveLength(0)
    expect(wrapper.find('[data-test="status-progress"]').exists()).toBe(false)
    expect(document.querySelector('[data-test="progress-cancel"]')).toBeNull()
    wrapper.unmount()
  })

  it('Cmd+N opens a new query tab and Cmd+W closes it', async () => {
    const { wrapper } = mountApp()
    await settle()
    const tabs = useTabsStore()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }))
    await flush()
    expect(tabs.active.kind).toBe('query')
    expect(tabs.active.title).toContain('(Dev)')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', metaKey: true }))
    await flush()
    expect(tabs.tabs.map((t) => t.kind)).toEqual(['objects'])
    wrapper.unmount()
  })

  it('the Tabla toolbar button selects the tables group and shows the Objects tab', async () => {
    const { wrapper } = mountApp()
    await settle()
    const tabs = useTabsStore()
    const { useTreeStore } = await import('../stores/tree')
    const tree = useTreeStore()
    await useConnectionsStore().open('c1')
    tree.select('s:c1:shop')
    tabs.open({ kind: 'automation', id: 'automation', title: 'Automatización' })

    await wrapper.get('[data-test="toolbar-table"]').trigger('click')
    await settle()
    expect(tree.selectedId).toBe('g:c1:shop:tables')
    expect(tabs.activeId).toBe('objects')
    expect(bridge.invoke).toHaveBeenCalledWith('db:tables', 'c1', 'shop')
    wrapper.unmount()
  })
})
