import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { TableDataPage, TableStructure } from '@shared/types'
import { useObjectActions } from '@renderer/composables/useObjectActions'
import { useSettingsStore } from '@renderer/stores/settings'
import type { TreeNode } from '@renderer/stores/tree'
import { useUiStore } from '@renderer/stores/ui'
import DdlEditorView from '../DdlEditorView.vue'
import QueryView from '../QueryView.vue'
import TableDataView from '../TableDataView.vue'
import TableDesignerView from '../TableDesignerView.vue'
import UsersView from '../UsersView.vue'
import { mockBridge, mountView, okExecute, openTab, seedConnection, setupDom } from './helpers'

// settings.confirmDestructiveEverywhere (default on) must ask before every
// destructive operation on any connection: one plain dialog on non-production,
// the typed production dialog (only) on production, and nothing is written on cancel.

type Env = 'local' | 'production'
type Wrapper = Awaited<ReturnType<typeof mountView>>

const page: TableDataPage = {
  columns: [
    { name: 'id', type: 'LONG', primaryKey: true },
    { name: 'name', type: 'VAR_STRING' }
  ],
  rows: [
    [1, 'alpha'],
    [2, 'beta']
  ],
  primaryKey: ['id'],
  total: 2,
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
    },
    {
      name: 'notes',
      ordinal: 2,
      columnType: 'text',
      dataType: 'text',
      nullable: true,
      key: '',
      defaultValue: null,
      extra: '',
      characterSet: 'utf8mb4',
      collation: 'utf8mb4_0900_ai_ci',
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
    'CREATE TABLE `items` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `notes` text,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB'
}

const queryResult = [
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
]

/** Bridge for every scenario: reads answer empty lists, writes succeed. */
function bridge() {
  return mockBridge({
    'db:tableData': () => structuredClone(page),
    'db:applyRowChanges': (_c, _s, _t, changes) => ({
      applied: (changes as unknown[]).length,
      statements: []
    }),
    'db:databases': () => [],
    'db:tables': () => [],
    'db:views': () => [],
    'db:routines': () => [],
    'db:events': () => [],
    'db:charsets': () => [],
    'db:dropObject': () => undefined,
    'db:dropDatabase': () => undefined,
    'db:showCreate': () => 'CREATE PROCEDURE `purge`()\nBEGIN\n  SELECT 1;\nEND',
    'db:tableStructure': () => ({ ...structuredClone(structure), tableType: 'BASE TABLE' }),
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
    'db:execute': (c, sql) =>
      /^SELECT/i.test(String(sql)) ? structuredClone(queryResult) : okExecute(c, sql)
  })
}

interface RunOptions {
  /** settings.confirmDestructiveEverywhere off. */
  off?: boolean
}

/** Every ui.ask request of the current scenario. */
let asks: unknown[] = []

/** Seeds the connection and settings in the fresh Pinia and records each ui.ask call. */
function prepare(env: Env, options: RunOptions): void {
  seedConnection('c1', env, 'Servidor')
  if (options.off) useSettingsStore().settings.confirmDestructiveEverywhere = false
  asks = []
  const ui = useUiStore()
  const ask = ui.ask
  ui.ask = (request) => {
    asks.push(request)
    return ask(request)
  }
}

const node = (patch: Partial<TreeNode>): TreeNode => ({
  id: 'n',
  kind: 'object',
  label: patch.name ?? 'x',
  connectionId: 'c1',
  schema: 'shop',
  parentId: null,
  ...patch
})

interface Scenario {
  name: string
  /** IPC channel that performs the destructive write. */
  channel: string
  title: string
  /** Text expected in the listed items. */
  item: string
  /** With the setting off, non-production keeps today's behaviour: the old dialog (true) or none. */
  offAsks: boolean
  /** Mounts what is needed and triggers the operation; resolves once a dialog may be pending. */
  run: (
    env: Env,
    options?: RunOptions
  ) => Promise<{ invoke: ReturnType<typeof mockBridge>; wrapper?: Wrapper }>
}

function treeScenario(
  name: string,
  channel: string,
  title: string,
  item: string,
  act: (actions: ReturnType<typeof useObjectActions>) => Promise<void>
): Scenario {
  return {
    name,
    channel,
    title,
    item,
    offAsks: true,
    async run(env, options = {}) {
      setupDom()
      const invoke = bridge()
      prepare(env, options)
      void act(useObjectActions())
      await flushPromises()
      return { invoke }
    }
  }
}

async function mountTab(
  env: Env,
  options: RunOptions,
  input: Parameters<typeof openTab>[0],
  view: Parameters<typeof mountView>[0]
) {
  const pinia = setupDom()
  const invoke = bridge()
  prepare(env, options)
  const wrapper = await mountView(view, openTab(input), pinia)
  return { invoke, wrapper }
}

const scenarios: Scenario[] = [
  treeScenario(
    'drop table',
    'db:dropObject',
    '¿Eliminar la tabla «items»?',
    '`shop`.`items`',
    (a) => a.dropObject(node({ group: 'tables', name: 'items' }))
  ),
  treeScenario('drop view', 'db:dropObject', '¿Eliminar la vista «v_items»?', 'v_items', (a) =>
    a.dropObject(node({ group: 'views', name: 'v_items' }))
  ),
  treeScenario('drop function', 'db:dropObject', '¿Eliminar la función «total»?', 'total', (a) =>
    a.dropObject(node({ group: 'functions', subtype: 'FUNCTION', name: 'total' }))
  ),
  treeScenario(
    'drop procedure',
    'db:dropObject',
    '¿Eliminar el procedimiento «purge»?',
    'purge',
    (a) => a.dropObject(node({ group: 'functions', subtype: 'PROCEDURE', name: 'purge' }))
  ),
  treeScenario('drop event', 'db:dropObject', '¿Eliminar el evento «nightly»?', 'nightly', (a) =>
    a.dropObject(node({ group: 'events', name: 'nightly' }))
  ),
  treeScenario(
    'drop database',
    'db:dropDatabase',
    '¿Eliminar la base de datos «shop»?',
    '`shop`',
    (a) => a.dropDatabase(node({ kind: 'schema' }))
  ),
  treeScenario('truncate table', 'db:execute', '¿Vaciar la tabla «items»?', '`shop`.`items`', (a) =>
    a.truncateTable(node({ group: 'tables', name: 'items' }))
  ),
  {
    name: 'TableDataView: Aplicar with a deleted row',
    channel: 'db:applyRowChanges',
    title: '¿Eliminar 1 fila de «items»?',
    item: 'id = 2',
    offAsks: false,
    async run(env, options = {}) {
      const mounted = await mountTab(
        env,
        options,
        {
          kind: 'tableData',
          title: 't',
          connectionId: 'c1',
          schema: 'shop',
          objectName: 'items',
          objectType: 'table'
        },
        TableDataView
      )
      const w = mounted.wrapper
      await w.get('[data-test="row-1"] td').trigger('click')
      await w.get('[data-test="delete-rows"]').trigger('click')
      await w.get('[data-test="apply"]').trigger('click')
      await flushPromises()
      return mounted
    }
  },
  {
    name: 'QueryView: editable result with a deleted row',
    channel: 'db:applyRowChanges',
    title: '¿Eliminar 1 fila de «items»?',
    item: 'id = 1',
    offAsks: false,
    async run(env, options = {}) {
      const mounted = await mountTab(
        env,
        options,
        {
          kind: 'query',
          title: 'q',
          connectionId: 'c1',
          schema: 'shop',
          payload: { sql: 'SELECT * FROM items AS i' }
        },
        QueryView
      )
      const w = mounted.wrapper
      await w.get('[data-test="run"]').trigger('click')
      await flushPromises()
      expect(useUiStore().confirm.open).toBe(false)
      await w.get('[data-test="row-0"] td').trigger('click')
      await w.get('[data-test="delete-rows"]').trigger('click')
      await w.get('[data-test="apply"]').trigger('click')
      await flushPromises()
      return mounted
    }
  },
  {
    name: 'QueryView: script with DELETE without WHERE and DROP',
    channel: 'db:execute',
    title: '¿Ejecutar 2 sentencias destructivas?',
    item: 'DELETE FROM log',
    offAsks: false,
    async run(env, options = {}) {
      const mounted = await mountTab(
        env,
        options,
        {
          kind: 'query',
          title: 'q',
          connectionId: 'c1',
          schema: 'shop',
          payload: { sql: "-- DROP TABLE x\nSELECT 'TRUNCATE';\nDELETE FROM log;\nDROP TABLE tmp" }
        },
        QueryView
      )
      await mounted.wrapper.get('[data-test="run"]').trigger('click')
      await flushPromises()
      return mounted
    }
  },
  {
    name: 'DdlEditorView: replacing a procedure',
    channel: 'db:execute',
    title: '¿Eliminar y volver a crear el procedimiento «purge»?',
    item: 'DROP PROCEDURE IF EXISTS `shop`.`purge`',
    offAsks: true,
    async run(env, options = {}) {
      const mounted = await mountTab(
        env,
        options,
        {
          kind: 'ddlEditor',
          title: 'p',
          connectionId: 'c1',
          schema: 'shop',
          objectName: 'purge',
          objectType: 'procedure'
        },
        DdlEditorView
      )
      await mounted.wrapper.get('[data-test="apply"]').trigger('click')
      await flushPromises()
      return mounted
    }
  },
  {
    name: 'TableDesignerView: dropping a column',
    channel: 'db:execute',
    title: '¿Eliminar 1 elemento de la tabla «items»?',
    item: 'notes',
    offAsks: true,
    async run(env, options = {}) {
      const mounted = await mountTab(
        env,
        options,
        {
          kind: 'tableDesigner',
          title: 't',
          connectionId: 'c1',
          schema: 'shop',
          objectName: 'items',
          objectType: 'table'
        },
        TableDesignerView
      )
      const w = mounted.wrapper
      await w.get('[data-test="column-row-1"]').trigger('click')
      await w.get('[data-test="remove-column"]').trigger('click')
      await w.get('[data-test="save"]').trigger('click')
      await flushPromises()
      return mounted
    }
  },
  {
    name: 'UsersView: drop user',
    channel: 'db:execute',
    title: '¿Eliminar el usuario «app@%»?',
    item: 'app@%',
    offAsks: true,
    async run(env, options = {}) {
      const mounted = await mountTab(
        env,
        options,
        { kind: 'users', title: 'u', connectionId: 'c1' },
        UsersView
      )
      await mounted.wrapper.get('[aria-label="Eliminar app"]').trigger('click')
      await flushPromises()
      return mounted
    }
  }
]

const wrote = (invoke: ReturnType<typeof mockBridge>, channel: string): boolean =>
  invoke.mock.calls.some(
    (c) => c[0] === channel && (channel !== 'db:execute' || !/^SELECT/i.test(String(c[2])))
  )

describe.each(scenarios)('$name', (scenario) => {
  let wrapper: Wrapper | undefined
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    localStorage.clear()
  })

  it('asks with the destructive dialog on a Local connection and does not write when cancelled', async () => {
    const mounted = await scenario.run('local')
    wrapper = mounted.wrapper
    expect(useSettingsStore().settings.confirmDestructiveEverywhere).toBe(true)
    const ui = useUiStore()
    expect(ui.confirm.open).toBe(true)
    expect(ui.confirm.danger).toBe(true)
    expect(ui.confirm.production).toBeFalsy()
    expect(ui.confirm.requireTyped).toBeUndefined()
    expect(ui.confirm.title).toBe(scenario.title)
    expect(ui.confirm.color).toBe('error')
    expect(ui.confirm.connection).toEqual({ name: 'Servidor', environment: 'local' })
    expect(ui.confirm.items?.map((i) => i.text).join('\n')).toContain(scenario.item)
    ui.answer(false)
    await flushPromises()
    expect(wrote(mounted.invoke, scenario.channel)).toBe(false)
  })

  it('writes after the destructive dialog is accepted', async () => {
    const mounted = await scenario.run('local')
    wrapper = mounted.wrapper
    useUiStore().answer(true)
    await flushPromises()
    expect(wrote(mounted.invoke, scenario.channel)).toBe(true)
  })
})

describe.each(scenarios)('$name with confirmDestructiveEverywhere off', (scenario) => {
  let wrapper: Wrapper | undefined
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    localStorage.clear()
  })

  it(
    scenario.offAsks ? 'asks with the previous (non-destructive) dialog' : 'writes without asking',
    async () => {
      const mounted = await scenario.run('local', { off: true })
      wrapper = mounted.wrapper
      const ui = useUiStore()
      if (scenario.offAsks) {
        expect(ui.confirm.open).toBe(true)
        expect(ui.confirm.danger).toBeFalsy()
        ui.answer(true)
        await flushPromises()
      } else {
        expect(ui.confirm.open).toBe(false)
      }
      expect(wrote(mounted.invoke, scenario.channel)).toBe(true)
    }
  )
})

describe.each(scenarios)('$name on a production connection', (scenario) => {
  let wrapper: Wrapper | undefined
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    localStorage.clear()
  })

  it('shows only the typed production confirmation, once', async () => {
    const mounted = await scenario.run('production')
    wrapper = mounted.wrapper
    const ui = useUiStore()
    expect(ui.confirm.open).toBe(true)
    expect(ui.confirm.production).toBe(true)
    expect(ui.confirm.requireTyped).toBe('Servidor')
    ui.answer(true)
    await flushPromises()
    expect(asks).toHaveLength(1)
    const call = mounted.invoke.mock.calls.find(
      (c) => c[0] === scenario.channel && !/^SELECT/i.test(String(c[2]))
    )
    expect(
      call?.some((a) => (a as { confirmProduction?: boolean } | null)?.confirmProduction)
    ).toBe(true)
  })
})
