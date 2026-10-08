import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AppToolbar from '@renderer/components/layout/AppToolbar.vue'
import {
  automationConnections,
  backupConnections,
  findLocalConnection
} from '@renderer/components/backups/backupHelpers'
import { useObjectActions } from '@renderer/composables/useObjectActions'
import { can, descriptorOf, groupsFor } from '@renderer/engines'
import { useConnectionsStore } from '@renderer/stores/connections'
import { nodeIds, useTreeStore } from '@renderer/stores/tree'
import {
  createTestVuetify,
  flush,
  installBridge,
  installDomPolyfills,
  makeConnection,
  makeServerInfo
} from './shellTestUtils'

/*
 * Menus, toolbar, tree groups and pickers are driven by the engine
 * capabilities. MySQL has every capability the v0.1.0 UI used (its menus are
 * pinned by mysqlMenus.test.ts); these tests use fake connections of engines
 * that cannot be created in this build to show what a capability removes.
 */

const keys = (actions: { key: string; divider?: boolean }[]) =>
  actions.filter((a) => !a.divider).map((a) => a.key)

async function setup(): Promise<void> {
  installDomPolyfills()
  setActivePinia(createPinia())
  installBridge({
    'connections:list': [
      makeConnection({ id: 'my', name: 'MySQL local' }),
      makeConnection({ id: 'pg', name: 'PG local', engine: 'postgresql' }),
      makeConnection({ id: 'lite', name: 'SQLite local', engine: 'sqlite' }),
      makeConnection({ id: 'odd', name: 'Desconocido', engine: 'oracle' as never })
    ],
    // Only used to mark connections open: main refuses non-MySQL engines in this build.
    'connections:open': () => makeServerInfo(),
    'db:databases': () => [{ name: 'app', characterSet: 'utf8mb4', collation: 'x' }]
  })
  await useConnectionsStore().load()
}

describe('capability helpers', () => {
  it('treats a connection without engine (or not loaded) as MySQL', () => {
    expect(descriptorOf(undefined)?.id).toBe('mysql')
    expect(descriptorOf({})?.id).toBe('mysql')
    expect(can({}, 'supportsBackupsNb3')).toBe(true)
  })

  it('grants nothing to an unknown engine', () => {
    const odd = { engine: 'oracle' as never }
    expect(descriptorOf(odd)).toBeNull()
    expect(can(odd, 'hasUsers')).toBe(false)
    expect(groupsFor(odd)).toEqual([])
  })
})

describe('context menus per engine', () => {
  beforeEach(setup)

  it('PostgreSQL: no users or events entries; backups (.vqb) per connection', async () => {
    const tree = useTreeStore()
    const { actionsFor } = useObjectActions()
    await useConnectionsStore().open('pg')
    expect(keys(actionsFor(tree.parse(nodeIds.connection('pg'))!))).toEqual([
      'close',
      'edit',
      'copyUri',
      'query',
      'newdb',
      'backups',
      'refresh',
      'delete'
    ])
    expect(keys(actionsFor(tree.parse(nodeIds.schema('pg', 'app'))!))).toEqual([
      'query',
      'table',
      'refresh',
      'drop'
    ])
    expect(keys(actionsFor(tree.parse(nodeIds.group('pg', 'app', 'events'))!))).toEqual(['refresh'])
    expect(keys(actionsFor(tree.parse(nodeIds.group('pg', 'app', 'backups'))!))).toEqual([
      'refresh'
    ])
    expect(keys(actionsFor(tree.parse(nodeIds.object('pg', 'app', 'tables', 'users'))!))).toContain(
      'truncate'
    )
  })

  it('SQLite: no "Nueva base de datos" and no TRUNCATE', async () => {
    const tree = useTreeStore()
    const { actionsFor } = useObjectActions()
    await useConnectionsStore().open('lite')
    expect(keys(actionsFor(tree.parse(nodeIds.connection('lite'))!))).not.toContain('newdb')
    const table = keys(actionsFor(tree.parse(nodeIds.object('lite', 'main', 'tables', 't'))!))
    expect(table).toContain('design')
    expect(table).not.toContain('truncate')
  })

  it('SQLite: file and maintenance entries, per-group menus, no database drop', async () => {
    const tree = useTreeStore()
    const { actionsFor } = useObjectActions()
    const connections = useConnectionsStore()
    await connections.open('lite')
    expect(keys(actionsFor(tree.parse(nodeIds.connection('lite'))!))).toEqual([
      'close',
      'edit',
      'query',
      'backups',
      'showFile',
      'copyFile',
      'integrity',
      'fkCheck',
      'vacuum',
      'refresh',
      'delete'
    ])
    // A read-only file offers «Reabrir en modo escritura» and no VACUUM.
    connections.setServerInfo(
      'lite',
      makeServerInfo({
        runtime: {
          flavor: 'sqlite',
          versionNumber: 3053004,
          transactions: true,
          returning: 'all',
          readOnly: true
        }
      })
    )
    const ro = actionsFor(tree.parse(nodeIds.connection('lite'))!)
    expect(keys(ro)).toContain('reopenRw')
    expect(ro.find((a) => a.key === 'vacuum')?.disabled).toBe(true)
    expect(keys(actionsFor(tree.parse(nodeIds.schema('lite', 'main'))!))).toEqual([
      'query',
      'table',
      'backup',
      'backups',
      'refresh'
    ])
    expect(keys(actionsFor(tree.parse(nodeIds.group('lite', 'main', 'indexes'))!))).toEqual([
      'new',
      'refresh'
    ])
    expect(keys(actionsFor(tree.parse(nodeIds.object('lite', 'main', 'tables', 't'))!))).toEqual([
      'open',
      'design',
      'new',
      'copy',
      'ddl',
      'empty',
      'delete',
      'refresh'
    ])
    expect(keys(actionsFor(tree.parse(nodeIds.object('lite', 'main', 'views', 'v'))!))).toEqual([
      'open',
      'design',
      'new',
      'copy',
      'ddl',
      'delete',
      'refresh'
    ])
    expect(
      keys(actionsFor(tree.parse(nodeIds.object('lite', 'main', 'triggers', 'trg'))!))
    ).toEqual(['open', 'new', 'copy', 'ddl', 'delete', 'refresh'])
  })

  it('unknown engine: only entries that need no capability', () => {
    const tree = useTreeStore()
    const { actionsFor } = useObjectActions()
    expect(keys(actionsFor(tree.parse(nodeIds.connection('odd'))!))).toEqual([
      'open',
      'edit',
      'query',
      'refresh',
      'delete'
    ])
    expect(keys(actionsFor(tree.parse(nodeIds.object('odd', 'x', 'tables', 't'))!))).toEqual([
      'open',
      'new',
      'copy',
      'ddl',
      'delete',
      'refresh'
    ])
  })
})

describe('main toolbar per engine', () => {
  beforeEach(setup)
  afterEach(() => {
    document.body.innerHTML = ''
  })

  async function toolbarFor(
    connectionId: string
  ): Promise<{ buttons: string[]; objects: string[] }> {
    const tree = useTreeStore()
    tree.select(nodeIds.connection(connectionId))
    const wrapper = mount(AppToolbar, {
      global: { plugins: [createTestVuetify()] },
      attachTo: document.body
    })
    await flush()
    const buttons = wrapper
      .findAll('[data-test^="toolbar-"]')
      .map((b) => b.attributes('data-test')!.replace('toolbar-', ''))
    await wrapper.get('[data-test="toolbar-objects"]').trigger('click')
    await flush()
    await flush()
    const objects = [...document.querySelectorAll('.v-overlay--active .v-list-item-title')].map(
      (el) => el.textContent?.trim() ?? ''
    )
    wrapper.unmount()
    document.querySelectorAll('.v-overlay-container').forEach((el) => (el.innerHTML = ''))
    return { buttons, objects }
  }

  it('MySQL shows every module', async () => {
    expect(await toolbarFor('my')).toEqual({
      buttons: [
        'connection',
        'query',
        'objects',
        'users',
        'backup',
        'automation',
        'more',
        // global buttons (not tied to the selected connection)
        'ai',
        'settings'
      ],
      objects: [
        'Tablas',
        'Vistas',
        'Funciones y procedimientos',
        'Eventos',
        'Consultas guardadas',
        'Nueva tabla',
        'Nueva vista',
        'Nueva función',
        'Nuevo procedimiento'
      ]
    })
  })

  it('leaves out the modules the selected engine lacks', async () => {
    expect(await toolbarFor('pg')).toEqual({
      buttons: ['connection', 'query', 'objects', 'backup', 'automation', 'more', 'ai', 'settings'],
      objects: [
        'Tablas',
        'Vistas',
        'Funciones y procedimientos',
        'Consultas guardadas',
        'Nueva tabla',
        'Nueva vista',
        'Nueva función',
        'Nuevo procedimiento'
      ]
    })
    // SQLite: .vqb backups, no users; its tree also lists indexes and triggers.
    expect(await toolbarFor('lite')).toEqual({
      buttons: ['connection', 'query', 'objects', 'backup', 'automation', 'more', 'ai', 'settings'],
      objects: [
        'Tablas',
        'Vistas',
        'Índices',
        'Disparadores',
        'Consultas guardadas',
        'Nueva tabla',
        'Nueva vista'
      ]
    })
  })
})

describe('backup and job pickers', () => {
  beforeEach(setup)

  it('only offer connections whose engine supports them', () => {
    const all = useConnectionsStore().sorted
    // PostgreSQL and SQLite have .vqb backups (no .nb3) and automation.
    expect(backupConnections(all).map((c) => c.id)).toEqual(['my', 'pg', 'lite'])
    expect(automationConnections(all).map((c) => c.id)).toEqual(['my', 'pg', 'lite'])
    // The default restore target is the first *backup-capable* local connection.
    expect(findLocalConnection(backupConnections(all))?.id).toBe('my')
    expect(findLocalConnection(all)?.id).not.toBe('my')
  })

  it('keep every MySQL connection, in the same order', () => {
    const mysqlOnly = useConnectionsStore().sorted.filter((c) => c.engine === 'mysql')
    expect(backupConnections(mysqlOnly)).toEqual(mysqlOnly)
    expect(automationConnections(mysqlOnly)).toEqual(mysqlOnly)
  })
})
