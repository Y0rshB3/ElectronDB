import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { TableDataPage, TableStructure } from '@shared/types'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore } from '@renderer/stores/ui'
import DdlEditorView from '../DdlEditorView.vue'
import QueryView from '../QueryView.vue'
import TableDataView from '../TableDataView.vue'
import TableDesignerView from '../TableDesignerView.vue'
import UsersView from '../UsersView.vue'
import { mockBridge, mountView, okExecute, openTab, seedConnection, setupDom } from './helpers'

// Production connection + settings.confirmProductionWrites (default true) must route
// every write through ui.ask({ production: true }), and a cancel must not write.

const page: TableDataPage = {
  columns: [
    { name: 'id', type: 'LONG', primaryKey: true },
    { name: 'name', type: 'VAR_STRING' }
  ],
  rows: [[1, 'alpha']],
  primaryKey: ['id'],
  total: 1,
  durationMs: 1
}

const structure: TableStructure = {
  schema: 'shop',
  name: 'items',
  columns: [
    {
      name: 'id',
      ordinal: 1,
      columnType: 'int',
      dataType: 'int',
      nullable: false,
      key: 'PRI',
      defaultValue: null,
      extra: 'auto_increment',
      characterSet: null,
      collation: null,
      comment: ''
    }
  ],
  indexes: [{ name: 'PRIMARY', unique: true, type: 'BTREE', columns: ['id'], comment: '' }],
  foreignKeys: [],
  engine: 'InnoDB',
  collation: 'utf8mb4_0900_ai_ci',
  comment: '',
  autoIncrement: null,
  createSql:
    'CREATE TABLE `items` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB'
}

type Wrapper = Awaited<ReturnType<typeof mountView>>

interface Scenario {
  name: string
  mount: () => Promise<{ wrapper: Wrapper; invoke: ReturnType<typeof mockBridge> }>
  /** Triggers the write and resolves once the confirmation is pending. */
  write: (wrapper: Wrapper) => Promise<void>
  /** IPC channel that performs the write. */
  channel: string
}

const scenarios: Scenario[] = [
  {
    name: 'TableDataView',
    channel: 'db:applyRowChanges',
    async mount() {
      const pinia = setupDom()
      const invoke = mockBridge({
        'db:tableData': () => structuredClone(page),
        'db:applyRowChanges': () => ({ applied: 1, statements: [] })
      })
      seedConnection('c1', 'production')
      const tab = openTab({
        kind: 'tableData',
        title: 't',
        connectionId: 'c1',
        schema: 'shop',
        objectName: 'items',
        objectType: 'table'
      })
      return { wrapper: await mountView(TableDataView, tab, pinia), invoke }
    },
    async write(wrapper) {
      await wrapper.get('[data-test="cell-0-1"]').trigger('click')
      await wrapper.get('[data-test="set-null"]').trigger('click')
      await wrapper.get('[data-test="apply"]').trigger('click')
    }
  },
  {
    name: 'QueryView',
    channel: 'db:execute',
    async mount() {
      const pinia = setupDom()
      const invoke = mockBridge({
        'db:databases': () => [],
        'db:tables': () => [],
        'db:execute': okExecute
      })
      seedConnection('c1', 'production')
      // CALL is a write the old denylist missed.
      const tab = openTab({
        kind: 'query',
        title: 'q',
        connectionId: 'c1',
        schema: 'shop',
        payload: { sql: 'CALL purge_all()' }
      })
      return { wrapper: await mountView(QueryView, tab, pinia), invoke }
    },
    async write(wrapper) {
      await wrapper.get('[data-test="run"]').trigger('click')
    }
  },
  {
    name: 'QueryView (resultado editable)',
    channel: 'db:applyRowChanges',
    async mount() {
      const pinia = setupDom()
      const invoke = mockBridge({
        'db:databases': () => [],
        'db:tables': () => [],
        'db:execute': () => [
          {
            sql: 'SELECT * FROM items AS i',
            durationMs: 1,
            affectedRows: null,
            insertId: null,
            changedRows: null,
            warnings: 0,
            resultSet: {
              columns: [
                {
                  name: 'id',
                  type: 'INT',
                  schema: 'shop',
                  table: 'items',
                  tableAlias: 'i',
                  sourceName: 'id',
                  primaryKey: true
                },
                {
                  name: 'name',
                  type: 'VARCHAR',
                  schema: 'shop',
                  table: 'items',
                  tableAlias: 'i',
                  sourceName: 'name'
                }
              ],
              rows: [[1, 'alpha']],
              truncated: false
            },
            error: null
          }
        ],
        'db:tableStructure': () => ({ ...structuredClone(structure), tableType: 'BASE TABLE' }),
        'db:applyRowChanges': () => ({ applied: 1, statements: [] })
      })
      seedConnection('c1', 'production')
      const tab = openTab({
        kind: 'query',
        title: 'q',
        connectionId: 'c1',
        schema: 'shop',
        payload: { sql: 'SELECT * FROM items AS i' }
      })
      const wrapper = await mountView(QueryView, tab, pinia)
      // A plain SELECT is read-only for the guard: no confirmation to run it.
      await wrapper.get('[data-test="run"]').trigger('click')
      await flushPromises()
      return { wrapper, invoke }
    },
    async write(wrapper) {
      await wrapper.get('[data-test="cell-0-1"]').trigger('click')
      await wrapper.get('[data-test="set-null"]').trigger('click')
      await wrapper.get('[data-test="apply"]').trigger('click')
    }
  },
  {
    name: 'TableDesignerView',
    channel: 'db:execute',
    async mount() {
      const pinia = setupDom()
      const invoke = mockBridge({
        'db:tableStructure': () => structuredClone(structure),
        'db:charsets': () => [],
        'db:databases': () => [],
        'db:execute': okExecute
      })
      seedConnection('c1', 'production')
      const tab = openTab({
        kind: 'tableDesigner',
        title: 't',
        connectionId: 'c1',
        schema: 'shop',
        objectName: 'items',
        objectType: 'table'
      })
      return { wrapper: await mountView(TableDesignerView, tab, pinia), invoke }
    },
    async write(wrapper) {
      // Adding a column is not risky: only the production flag makes it ask.
      await wrapper.get('[data-test="add-column"]').trigger('click')
      await wrapper.get('[data-test="column-name-1"]').setValue('email')
      await wrapper.get('[data-test="save"]').trigger('click')
    }
  },
  {
    name: 'DdlEditorView',
    channel: 'db:execute',
    async mount() {
      const pinia = setupDom()
      const invoke = mockBridge({ 'db:execute': okExecute })
      seedConnection('c1', 'production')
      // New view: no DROP, so only the production flag makes it ask.
      const tab = openTab({
        kind: 'ddlEditor',
        title: 'v',
        connectionId: 'c1',
        schema: 'shop',
        objectType: 'view'
      })
      return { wrapper: await mountView(DdlEditorView, tab, pinia), invoke }
    },
    async write(wrapper) {
      await wrapper.get('[data-test="apply"]').trigger('click')
    }
  },
  {
    name: 'UsersView',
    channel: 'db:execute',
    async mount() {
      const pinia = setupDom()
      const invoke = mockBridge({
        'db:users': () => [
          {
            user: 'app',
            host: '%',
            plugin: 'caching_sha2_password',
            accountLocked: false,
            passwordExpired: false,
            maxConnections: 0
          }
        ],
        'db:databases': () => [],
        'db:execute': okExecute
      })
      seedConnection('c1', 'production')
      const tab = openTab({ kind: 'users', title: 'u', connectionId: 'c1' })
      return { wrapper: await mountView(UsersView, tab, pinia), invoke }
    },
    async write(wrapper) {
      await wrapper.get('[aria-label="Bloquear app"]').trigger('click')
    }
  }
]

describe.each(scenarios)('$name on a production connection', (scenario) => {
  let wrapper: Wrapper | null = null
  afterEach(() => {
    wrapper?.unmount()
    localStorage.clear()
  })

  it('asks with the production flag and does not write when cancelled', async () => {
    const mounted = await scenario.mount()
    wrapper = mounted.wrapper
    expect(useSettingsStore().settings.confirmProductionWrites).toBe(true)
    await scenario.write(wrapper)
    await flushPromises()

    const ui = useUiStore()
    expect(ui.confirm.open).toBe(true)
    expect(ui.confirm.production).toBe(true)
    expect(ui.confirm.requireTyped).toBe('Servidor')
    ui.answer(false)
    await flushPromises()
    expect(mounted.invoke.mock.calls.some((c) => c[0] === scenario.channel)).toBe(false)
  })

  it('writes once the production confirmation is accepted', async () => {
    const mounted = await scenario.mount()
    wrapper = mounted.wrapper
    await scenario.write(wrapper)
    await flushPromises()
    useUiStore().answer(true)
    await flushPromises()
    const call = mounted.invoke.mock.calls.find((c) => c[0] === scenario.channel)
    expect(call).toBeTruthy()
    // main enforces the same rule, so the confirmed write must say so
    expect(
      call!.some(
        (a) =>
          typeof a === 'object' &&
          a !== null &&
          (a as { confirmProduction?: boolean }).confirmProduction === true
      )
    ).toBe(true)
  })
})

describe('production guard can be disabled in settings', () => {
  it('QueryView runs writes without asking when confirmProductionWrites is off', async () => {
    const pinia = setupDom()
    const invoke = mockBridge({
      'db:databases': () => [],
      'db:tables': () => [],
      'db:execute': okExecute
    })
    seedConnection('c1', 'production')
    useSettingsStore().settings.confirmProductionWrites = false
    const tab = openTab({
      kind: 'query',
      title: 'q',
      connectionId: 'c1',
      payload: { sql: 'DELETE FROM t' }
    })
    const wrapper = await mountView(QueryView, tab, pinia)
    await wrapper.get('[data-test="run"]').trigger('click')
    await flushPromises()
    expect(useUiStore().confirm.open).toBe(false)
    expect(invoke.mock.calls.some((c) => c[0] === 'db:execute')).toBe(true)
    wrapper.unmount()
  })
})
