import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { Environment, TableDataPage, TableStructure } from '@shared/types'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore } from '@renderer/stores/ui'
import DdlEditorView from '../DdlEditorView.vue'
import QueryView from '../QueryView.vue'
import TableDataView from '../TableDataView.vue'
import TableDesignerView from '../TableDesignerView.vue'
import UsersView from '../UsersView.vue'
import { mockBridge, mountView, okExecute, openTab, seedConnection, setupDom } from './helpers'

// A connection that needs the typed name (production, always, plus the environments of
// settings.typedConfirmEnvironments) must route every write through
// ui.ask({ production: true, requireTyped }) and send confirmProduction; a cancel must not write.

/** Environment of the seeded connection and typed list for the next scenario mount. */
let seedEnv: Environment = 'production'
let typedList: Environment[] | null = null

function seed(): void {
  seedConnection('c1', seedEnv)
  if (typedList) useSettingsStore().settings.typedConfirmEnvironments = [...typedList]
}

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
      seed()
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
      seed()
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
      seed()
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
      seed()
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
      seed()
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
      seed()
      const tab = openTab({ kind: 'users', title: 'u', connectionId: 'c1' })
      return { wrapper: await mountView(UsersView, tab, pinia), invoke }
    },
    async write(wrapper) {
      await wrapper.get('[aria-label="Bloquear app"]').trigger('click')
    }
  }
]

const confirmed = (call: unknown[] | undefined): boolean =>
  !!call?.some(
    (a) =>
      typeof a === 'object' &&
      a !== null &&
      (a as { confirmProduction?: boolean }).confirmProduction === true
  )

describe.each(scenarios)('$name on a production connection', (scenario) => {
  let wrapper: Wrapper | null = null
  afterEach(() => {
    wrapper?.unmount()
    localStorage.clear()
    seedEnv = 'production'
    typedList = null
  })

  it('asks with the production flag and does not write when cancelled', async () => {
    const mounted = await scenario.mount()
    wrapper = mounted.wrapper
    // Default: only production needs the typed name.
    expect(useSettingsStore().typedEnvironments).toEqual(['production'])
    await scenario.write(wrapper)
    await flushPromises()

    const ui = useUiStore()
    expect(ui.confirm.open).toBe(true)
    expect(ui.confirm.production).toBe(true)
    expect(ui.confirm.requireTyped).toBe('Servidor')
    expect(ui.confirm.message).toMatch(/PRODUCCIÓN/)
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
    expect(confirmed(call)).toBe(true)
  })

  it('still asks when the stored list leaves production out (it cannot be removed)', async () => {
    typedList = []
    const mounted = await scenario.mount()
    wrapper = mounted.wrapper
    await scenario.write(wrapper)
    await flushPromises()
    const ui = useUiStore()
    expect(ui.confirm.production).toBe(true)
    expect(ui.confirm.requireTyped).toBe('Servidor')
    ui.answer(true)
    await flushPromises()
    expect(confirmed(mounted.invoke.mock.calls.find((c) => c[0] === scenario.channel))).toBe(true)
  })
})

describe.each(scenarios)('$name on a staging connection listed in Ajustes', (scenario) => {
  let wrapper: Wrapper | null = null
  afterEach(() => {
    wrapper?.unmount()
    localStorage.clear()
    seedEnv = 'production'
    typedList = null
  })

  it('asks for the typed name naming the environment and does not write when cancelled', async () => {
    seedEnv = 'staging'
    typedList = ['production', 'staging']
    const mounted = await scenario.mount()
    wrapper = mounted.wrapper
    await scenario.write(wrapper)
    await flushPromises()
    const ui = useUiStore()
    expect(ui.confirm.open).toBe(true)
    expect(ui.confirm.production).toBe(true)
    expect(ui.confirm.typedEnvironment).toBe('staging')
    expect(ui.confirm.requireTyped).toBe('Servidor')
    expect(ui.confirm.message).toMatch(/«Servidor» \(entorno Staging\) requiere confirmación/)
    expect(ui.confirm.message).not.toMatch(/PRODUCCIÓN/)
    ui.answer(false)
    await flushPromises()
    expect(mounted.invoke.mock.calls.some((c) => c[0] === scenario.channel)).toBe(false)
  })

  it('sends confirmProduction once the typed name is accepted', async () => {
    seedEnv = 'staging'
    typedList = ['production', 'staging']
    const mounted = await scenario.mount()
    wrapper = mounted.wrapper
    await scenario.write(wrapper)
    await flushPromises()
    useUiStore().answer(true)
    await flushPromises()
    // Single dialog: the typed confirmation replaces the destructive one.
    expect(useUiStore().confirm.open).toBe(false)
    expect(confirmed(mounted.invoke.mock.calls.find((c) => c[0] === scenario.channel))).toBe(true)
  })
})

describe.each(scenarios)('$name on a staging connection not listed', (scenario) => {
  let wrapper: Wrapper | null = null
  afterEach(() => {
    wrapper?.unmount()
    localStorage.clear()
    seedEnv = 'production'
    typedList = null
  })

  it('never asks for the typed name', async () => {
    seedEnv = 'staging'
    const mounted = await scenario.mount()
    wrapper = mounted.wrapper
    await scenario.write(wrapper)
    await flushPromises()
    const ui = useUiStore()
    // Some screens always ask (plain dialog); none asks for the name.
    expect(ui.confirm.requireTyped).toBeFalsy()
    expect(ui.confirm.production).toBeFalsy()
    if (ui.confirm.open) ui.answer(true)
    await flushPromises()
    expect(mounted.invoke.mock.calls.some((c) => c[0] === scenario.channel)).toBe(true)
  })
})

describe('typed confirmation and the destructive confirmation', () => {
  async function mountQuery(env: Environment, sql: string) {
    const pinia = setupDom()
    const invoke = mockBridge({
      'db:databases': () => [],
      'db:tables': () => [],
      'db:execute': okExecute
    })
    seedConnection('c1', env)
    return { pinia, invoke, sql }
  }

  it('production cannot be turned off: an empty list still asks for the name', async () => {
    const { pinia, invoke } = await mountQuery('production', '')
    useSettingsStore().settings.typedConfirmEnvironments = []
    useSettingsStore().settings.confirmDestructiveEverywhere = false
    const tab = openTab({
      kind: 'query',
      title: 'q',
      connectionId: 'c1',
      payload: { sql: 'DELETE FROM t' }
    })
    const wrapper = await mountView(QueryView, tab, pinia)
    await wrapper.get('[data-test="run"]').trigger('click')
    await flushPromises()
    const ui = useUiStore()
    expect(ui.confirm.open).toBe(true)
    expect(ui.confirm.requireTyped).toBe('Servidor')
    ui.answer(false)
    await flushPromises()
    expect(invoke.mock.calls.some((c) => c[0] === 'db:execute')).toBe(false)
    wrapper.unmount()
  })

  it('a listed staging connection shows only the typed dialog for a DELETE (never both)', async () => {
    const { pinia, invoke } = await mountQuery('staging', '')
    useSettingsStore().settings.typedConfirmEnvironments = ['production', 'staging']
    const tab = openTab({
      kind: 'query',
      title: 'q',
      connectionId: 'c1',
      payload: { sql: 'DELETE FROM t' }
    })
    const wrapper = await mountView(QueryView, tab, pinia)
    await wrapper.get('[data-test="run"]').trigger('click')
    await flushPromises()
    const ui = useUiStore()
    expect(ui.confirm.requireTyped).toBe('Servidor')
    expect(ui.confirm.danger).toBeFalsy()
    expect(ui.confirm.title).toBe('Ejecutar en «Servidor»')
    let asked = 0
    ui.$onAction(({ name }) => {
      if (name === 'ask') asked++
    })
    ui.answer(true)
    await flushPromises()
    expect(asked).toBe(0)
    expect(ui.confirm.open).toBe(false)
    const call = invoke.mock.calls.find((c) => c[0] === 'db:execute')
    expect(confirmed(call)).toBe(true)
    wrapper.unmount()
  })

  it('a staging connection not listed asks the plain destructive dialog for a DELETE', async () => {
    const { pinia, invoke } = await mountQuery('staging', '')
    const tab = openTab({
      kind: 'query',
      title: 'q',
      connectionId: 'c1',
      payload: { sql: 'DELETE FROM t' }
    })
    const wrapper = await mountView(QueryView, tab, pinia)
    await wrapper.get('[data-test="run"]').trigger('click')
    await flushPromises()
    const ui = useUiStore()
    expect(ui.confirm.open).toBe(true)
    expect(ui.confirm.production).toBeFalsy()
    expect(ui.confirm.requireTyped).toBeFalsy()
    expect(ui.confirm.danger).toBe(true)
    ui.answer(true)
    await flushPromises()
    const call = invoke.mock.calls.find((c) => c[0] === 'db:execute')
    expect(call).toBeTruthy()
    expect(confirmed(call)).toBe(false)
    wrapper.unmount()
  })
})
