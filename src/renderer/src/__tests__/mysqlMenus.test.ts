import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AppToolbar from '@renderer/components/layout/AppToolbar.vue'
import { useObjectActions, type MenuAction } from '@renderer/composables/useObjectActions'
import { useConnectionsStore } from '@renderer/stores/connections'
import { nodeIds, useTreeStore, type TreeNode } from '@renderer/stores/tree'
import {
  createTestVuetify,
  flush,
  installBridge,
  installDomPolyfills,
  makeConnection,
  makeServerInfo,
  makeTable
} from './shellTestUtils'

/*
 * Golden snapshot of every MySQL context menu and of the main toolbar, captured
 * from v0.1.0 before the renderer became capability-driven (multi-engine P1a),
 * and re-captured by running this same file on a clean v0.1.9 tree when P1a
 * was ported onto it (v0.1.9 added the AI, Preferencias, updates and tour
 * entries). The snapshot file must never be regenerated from the code under
 * test to make a change pass: a diff here is a MySQL UI change.
 */

function describeMenu(actions: MenuAction[]) {
  return actions.map((a) =>
    a.divider
      ? '---'
      : [a.key, a.label, a.icon ?? '', a.disabled ? 'disabled' : '', a.danger ? 'danger' : '']
          .filter(Boolean)
          .join(' | ')
  )
}

async function setup(): Promise<void> {
  installDomPolyfills()
  setActivePinia(createPinia())
  installBridge({
    'settings:get': {
      navicatRootPath: '',
      backupsRootDir: '',
      defaultRowLimit: 1000,
      theme: 'dark',
      confirmProductionWrites: true
    },
    'connections:list': [
      makeConnection({ id: 'c1', name: 'Dev' }),
      makeConnection({ id: 'c2', name: 'Prod', environment: 'production' })
    ],
    'connections:open': () => makeServerInfo(),
    'db:databases': () => [
      { name: 'shop', characterSet: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }
    ],
    'db:tables': () => [makeTable('users')],
    'db:views': () => [],
    'db:routines': () => [],
    'db:events': () => [],
    'backups:list': () => [],
    'jobs:list': [],
    'jobs:runs': []
  })
  await useConnectionsStore().load()
}

describe('MySQL context menus (golden)', () => {
  beforeEach(setup)

  it('connection, database, group and object menus are unchanged', async () => {
    const tree = useTreeStore()
    const { actionsFor } = useObjectActions()
    const menus: Record<string, string[]> = {}
    const node = (id: string): TreeNode => tree.parse(id)!

    menus['connection (closed)'] = describeMenu(actionsFor(node(nodeIds.connection('c1'))))
    menus['production connection (closed)'] = describeMenu(
      actionsFor(node(nodeIds.connection('c2')))
    )
    await tree.expand(node(nodeIds.connection('c1')))
    menus['connection (open)'] = describeMenu(actionsFor(node(nodeIds.connection('c1'))))
    menus['database'] = describeMenu(actionsFor(node(nodeIds.schema('c1', 'shop'))))
    for (const g of ['tables', 'views', 'functions', 'events', 'queries', 'backups'] as const)
      menus[`group ${g}`] = describeMenu(actionsFor(node(nodeIds.group('c1', 'shop', g))))

    const object = (
      group: Parameters<typeof nodeIds.object>[2],
      name: string,
      subtype?: string
    ) => {
      const n = node(nodeIds.object('c1', 'shop', group, name))
      n.subtype = subtype
      return describeMenu(actionsFor(n))
    }
    menus['object table'] = object('tables', 'users')
    menus['object view'] = object('views', 'v_users', 'VIEW')
    menus['object function'] = object('functions', 'f_total', 'FUNCTION')
    menus['object procedure'] = object('functions', 'p_fill', 'PROCEDURE')
    menus['object event'] = object('events', 'ev_purge')
    menus['object saved query'] = object('queries', 'q-1')
    menus['object backup'] = object('backups', '/tmp/backups/shop/x.nb3')

    expect(menus).toMatchSnapshot()
  })
})

describe('MySQL main toolbar (golden)', () => {
  beforeEach(setup)
  afterEach(() => {
    document.body.innerHTML = ''
  })

  async function toolbarState() {
    const wrapper = mount(AppToolbar, {
      global: { plugins: [createTestVuetify()] },
      attachTo: document.body
    })
    await flush()
    const buttons = wrapper.findAll('[data-test^="toolbar-"]').map((b) => ({
      key: b.attributes('data-test'),
      label: b.attributes('aria-label'),
      disabled: b.attributes('disabled') !== undefined
    }))
    const menus: Record<string, string[]> = {}
    for (const activator of wrapper.findAll('.app-toolbar__item')) {
      const btn =
        activator.find('.app-toolbar__caret').exists() &&
        !activator.find('.app-toolbar__caret').attributes('disabled')
          ? activator.find('.app-toolbar__caret')
          : activator.find('[data-test^="toolbar-"]')
      if (btn.attributes('disabled') !== undefined) continue
      const key = activator.find('[data-test^="toolbar-"]').attributes('data-test')!
      await btn.trigger('click')
      await flush()
      await flush()
      const titles = [...document.querySelectorAll('.v-overlay--active .v-list-item-title')].map(
        (el) => el.textContent?.trim() ?? ''
      )
      if (titles.length) menus[key] = titles
      await btn.trigger('click')
      document.querySelectorAll('.v-overlay-container').forEach((el) => (el.innerHTML = ''))
      await flush()
    }
    wrapper.unmount()
    return { buttons, menus }
  }

  it('is unchanged without a selection', async () => {
    useTreeStore().select(null)
    expect(await toolbarState()).toMatchSnapshot()
  })

  it('is unchanged with an open MySQL database selected', async () => {
    const tree = useTreeStore()
    await tree.expand(tree.parse(nodeIds.connection('c1'))!)
    tree.select(nodeIds.schema('c1', 'shop'))
    expect(await toolbarState()).toMatchSnapshot()
  })
})
