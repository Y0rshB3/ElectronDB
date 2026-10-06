import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectionConfig, QueryColumn, QueryStatementResult } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useQueriesStore } from '@renderer/stores/queries'
import { useTabsStore } from '@renderer/stores/tabs'
import { useUiStore } from '@renderer/stores/ui'
import QueryView from '../QueryView.vue'
import { mockBridge, mountView, okExecute, openTab, setupDom, type Handlers } from './helpers'

type Wrapper = Awaited<ReturnType<typeof mountView>>
type View = { switchConnection: (id: string) => Promise<boolean>; schema: string | null }

const CONNECTIONS = [
  { id: 'c1', name: 'Local', environment: 'local', color: '#69f0ae' },
  { id: 'c2', name: 'Tienda prod', environment: 'production', color: '#ff5252' }
] as ConnectionConfig[]

const DATABASES: Record<string, string[]> = { c1: ['shop', 'crm'], c2: ['shop', 'billing'] }

function db(name: string) {
  return { name, characterSet: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }
}

const column = (name: string, sourceName: string, pk = false): QueryColumn => ({
  name,
  type: 'INT',
  schema: 'shop',
  table: 'items',
  tableAlias: 'items',
  sourceName,
  ...(pk ? { primaryKey: true } : {})
})

const selectResult: QueryStatementResult[] = [
  {
    sql: 'SELECT id, qty FROM shop.items',
    durationMs: 1,
    affectedRows: null,
    insertId: null,
    changedRows: null,
    warnings: 0,
    resultSet: {
      columns: [column('id', 'id', true), column('qty', 'qty')],
      rows: [[1, 5]],
      truncated: false
    },
    error: null
  }
]

const structure = {
  schema: 'shop',
  name: 'items',
  tableType: 'BASE TABLE',
  columns: [
    {
      name: 'id',
      ordinal: 1,
      columnType: 'int',
      dataType: 'int',
      nullable: false,
      key: 'PRI',
      defaultValue: null,
      extra: '',
      characterSet: null,
      collation: null,
      comment: ''
    },
    {
      name: 'qty',
      ordinal: 2,
      columnType: 'int',
      dataType: 'int',
      nullable: true,
      key: '',
      defaultValue: null,
      extra: '',
      characterSet: null,
      collation: null,
      comment: ''
    }
  ],
  indexes: [{ name: 'PRIMARY', unique: true, type: 'BTREE', columns: ['id'], comment: '' }],
  foreignKeys: [],
  engine: 'InnoDB',
  collation: null,
  comment: '',
  autoIncrement: null,
  createSql: ''
}

describe('QueryView connection picker', () => {
  let wrapper: Wrapper | null = null
  afterEach(() => {
    wrapper?.unmount()
    localStorage.clear()
  })

  async function mount(
    options: { extra?: Handlers; payload?: Record<string, unknown>; schema?: string } = {}
  ) {
    const pinia = setupDom()
    const invoke = mockBridge({
      'db:databases': (c) => (DATABASES[c as string] ?? []).map(db),
      'db:tables': () => [],
      'db:views': () => [],
      'connections:open': () => ({ version: '8.4.0' }),
      'db:execute': okExecute,
      ...options.extra
    })
    useConnectionsStore().items = structuredClone(CONNECTIONS)
    const tab = openTab({
      kind: 'query',
      title: 'q',
      connectionId: 'c1',
      schema: options.schema ?? 'crm',
      payload: options.payload ?? { sql: 'SELECT 1' }
    })
    wrapper = await mountView(QueryView, tab, pinia)
    const view = wrapper.vm as unknown as View
    const current = () => useTabsStore().tabs.find((t) => t.id === tab.id)!
    return { invoke, tab, view, current, w: wrapper }
  }

  it('lists every connection with its environment and marks production', async () => {
    const { w } = await mount()
    expect(w.get('[data-test="connection-selection"]').text()).toContain('Local')
    expect(w.get('[data-test="connection-env"]').text()).toBe('Local')
    const select = w.findComponent({ name: 'VSelect' })
    expect((select.props('items') as ConnectionConfig[]).map((c) => c.name)).toEqual([
      'Local',
      'Tienda prod'
    ])
  })

  it('switches: keeps the SQL, updates the tab and reloads databases and completion', async () => {
    const { invoke, view, current, w } = await mount({ schema: 'shop' })
    await w.get('[data-test="sql-editor"]').setValue('SELECT * FROM items')
    expect(await view.switchConnection('c2')).toBe(true)
    await flushPromises()

    expect(current().connectionId).toBe('c2')
    expect(current().schema).toBe('shop')
    expect(current().title).toBe('Consulta sin título@shop (Tienda prod)')
    expect((w.get('[data-test="sql-editor"]').element as HTMLTextAreaElement).value).toBe(
      'SELECT * FROM items'
    )
    expect(invoke).toHaveBeenCalledWith('connections:open', 'c2')
    expect(invoke).toHaveBeenCalledWith('db:databases', 'c2')
    // Fresh completion provider for the new connection (its cache is warmed there).
    expect(invoke).toHaveBeenCalledWith('db:tables', 'c2', 'shop')
    const schemaSelect = w
      .findAllComponents({ name: 'VSelect' })
      .find((c) => c.attributes('data-test') === 'schema')!
    expect(schemaSelect.props('items')).toEqual(['shop', 'billing'])
  })

  it('picks no database when the new connection does not have the current one', async () => {
    const { view, current } = await mount({ schema: 'crm' })
    await view.switchConnection('c2')
    await flushPromises()
    expect(view.schema).toBeNull()
    expect(current().title).toBe('Consulta sin título (Tienda prod)')
  })

  it('makes production obvious and guards writes with the CURRENT connection', async () => {
    const { invoke, view, w } = await mount({ payload: { sql: 'DELETE FROM items' } })
    expect(w.get('[role="toolbar"]').classes()).not.toContain('is-production')
    await view.switchConnection('c2')
    await flushPromises()
    expect(w.get('[role="toolbar"]').classes()).toContain('is-production')
    expect(w.get('[data-test="connection"]').classes()).toContain('is-production')
    expect(w.get('[data-test="connection-env"]').text()).toBe('Producción')

    await w.get('[data-test="run"]').trigger('click')
    await flushPromises()
    const ui = useUiStore()
    expect(ui.confirm).toMatchObject({ open: true, production: true, requireTyped: 'Tienda prod' })
    ui.answer(true)
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith('db:execute', 'c2', 'DELETE FROM items', {
      schema: null,
      confirmProduction: true
    })
  })

  it('refuses to switch while a query is running', async () => {
    const { view, current, w } = await mount({
      extra: { 'db:execute': () => new Promise(() => undefined) }
    })
    await w.get('[data-test="run"]').trigger('click')
    await flushPromises()
    const picker = w.findAllComponents({ name: 'VSelect' })[0]
    expect(picker.props('disabled')).toBe(true)
    expect(await view.switchConnection('c2')).toBe(false)
    expect(current().connectionId).toBe('c1')
  })

  it('asks to discard pending result edits and clears the old results', async () => {
    const { invoke, view, current, w } = await mount({
      extra: {
        'db:execute': () => structuredClone(selectResult),
        'db:tableStructure': () => structuredClone(structure)
      }
    })
    await w.get('[data-test="run"]').trigger('click')
    await flushPromises()
    await w.get('[data-test="cell-0-1"]').trigger('dblclick')
    const input = w.get('[data-test="cell-input"]')
    await input.setValue('9')
    await input.trigger('keydown', { key: 'Enter' })

    const ui = useUiStore()
    const pending = view.switchConnection('c2')
    await flushPromises()
    expect(ui.confirm.open).toBe(true)
    expect(ui.confirm.message).toContain('Si cambias de conexión se descartarán')
    ui.answer(false)
    expect(await pending).toBe(false)
    expect(current().connectionId).toBe('c1')
    expect(w.find('[data-test="pending"]').exists()).toBe(true)

    const accepted = view.switchConnection('c2')
    await flushPromises()
    ui.answer(true)
    expect(await accepted).toBe(true)
    await flushPromises()
    expect(current().connectionId).toBe('c2')
    expect(w.find('[data-test="tab-rs0"]').exists()).toBe(false)
    expect(invoke.mock.calls.some((c) => c[0] === 'db:applyRowChanges')).toBe(false)
  })

  it('saves a saved query moved to another connection under the new one', async () => {
    const queries = useQueriesStore()
    setupDom()
    const saved = queries.save('c1', { name: 'Informe', sql: 'SELECT 1', schema: 'shop' })
    const { view, current, w } = await mount({ payload: { savedQueryId: saved.id } })
    expect(current().dirty).toBe(false)
    await view.switchConnection('c2')
    await flushPromises()
    // Not saved on c2 yet: dirty, and the Save button says where it will go.
    expect(current().dirty).toBe(true)
    expect(w.find('[data-test="save-moved"]').exists()).toBe(true)
    expect(w.get('[data-test="save"]').attributes('title')).toContain(
      'se guardará en «Tienda prod»'
    )

    await w.get('[data-test="save"]').trigger('click')
    const onC2 = useQueriesStore().list('c2')
    expect(onC2).toHaveLength(1)
    expect(onC2[0]).toMatchObject({ name: 'Informe', sql: 'SELECT 1' })
    expect(useQueriesStore().list('c1')).toEqual([expect.objectContaining({ id: saved.id })])
    expect(current().payload?.savedQueryId).toBe(onC2[0].id)
    expect(current().dirty).toBe(false)
    expect(w.find('[data-test="save-moved"]').exists()).toBe(false)
  })
})
