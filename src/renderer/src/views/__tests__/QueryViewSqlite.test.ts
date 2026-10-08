import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ConnectionConfig,
  Environment,
  QueryStatementResult,
  TableDataPage
} from '@shared/types'
import { answerTransactionPrompt } from '@renderer/composables/useTransactionPrompt'
import { useConnectionsStore } from '@renderer/stores/connections'
import QueryView from '../QueryView.vue'
import TableDataView from '../TableDataView.vue'
import { mockBridge, mountView, openTab, setupDom } from './helpers'

function seedSqlite(environment: Environment = 'local'): void {
  const connections = useConnectionsStore()
  connections.items = [
    {
      id: 'lite',
      name: 'Notas',
      environment,
      engine: 'sqlite',
      customDatabases: [],
      sqlite: {
        filePath: '/data/notas.db',
        readOnly: false,
        foreignKeys: false,
        attached: [],
        busyTimeoutMs: 5000
      }
    } as unknown as ConnectionConfig
  ]
  connections.serverInfo = { lite: { version: '3.53.4', engine: 'sqlite' } as never }
}

const result = (sql: string, extra: Partial<QueryStatementResult> = {}): QueryStatementResult => ({
  sql,
  durationMs: 1,
  affectedRows: 1,
  insertId: null,
  changedRows: null,
  warnings: 0,
  resultSet: null,
  error: null,
  ...extra
})

const idle = { open: true, transactionStatus: 'idle', effectiveSchema: null, database: null }

const liteHandlers = (extra: Record<string, (...args: unknown[]) => unknown> = {}) => ({
  'db:databases': () => [{ name: 'main', characterSet: '', collation: '' }],
  'db:tables': () => [],
  'db:views': () => [],
  'db:sessionState': () => ({ ...idle, transactionElsewhere: false }),
  'db:closeSession': () => undefined,
  ...extra
})

describe('QueryView on SQLite', () => {
  let wrapper: Awaited<ReturnType<typeof mountView>> | null = null
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    answerTransactionPrompt('cancel')
    localStorage.clear()
  })

  it('runs on the tab session with an execution id and says the transaction is shared', async () => {
    const pinia = setupDom()
    seedSqlite()
    let status = 'idle'
    const invoke = mockBridge(
      liteHandlers({
        'db:execute': (_c, sql) => {
          status = 'in'
          return [result(String(sql), { transactionStatus: 'in' })]
        },
        'db:sessionState': () => ({
          ...idle,
          transactionStatus: status,
          transactionElsewhere: false
        })
      })
    )
    const tab = openTab({
      kind: 'query',
      title: 'q',
      connectionId: 'lite',
      payload: { sql: 'BEGIN; INSERT INTO t VALUES (1)' }
    })
    wrapper = await mountView(QueryView, tab, pinia)
    expect(wrapper.find('[data-test="database"]').exists()).toBe(false)
    await wrapper.get('[data-test="run"]').trigger('click')
    await flushPromises()
    const call = invoke.mock.calls.find((c) => c[0] === 'db:execute')!
    expect(call[3]).toMatchObject({ sessionKey: tab.id })
    expect(String((call[3] as { executionId: string }).executionId)).toMatch(/^exec-/)
    expect(wrapper.get('[data-test="tx-status"]').text()).toBe(
      'Transacción abierta (compartida con las demás pestañas)'
    )
    expect(wrapper.find('[data-test="tx-commit"]').exists()).toBe(true)
  })

  it('shows another tab’s open transaction', async () => {
    const pinia = setupDom()
    seedSqlite()
    mockBridge(
      liteHandlers({
        'db:sessionState': () => ({ ...idle, transactionElsewhere: true })
      })
    )
    const tab = openTab({ kind: 'query', title: 'q', connectionId: 'lite', payload: { sql: '' } })
    wrapper = await mountView(QueryView, tab, pinia)
    expect(wrapper.get('[data-test="tx-elsewhere"]').text()).toBe(
      'Transacción abierta en otra pestaña'
    )
    expect(wrapper.find('[data-test="tx-commit"]').exists()).toBe(false)
  })

  it('cancels through db:cancel and asks for the typed name before writing to production', async () => {
    const pinia = setupDom()
    seedSqlite('production')
    let release: (value: QueryStatementResult[]) => void = () => undefined
    const invoke = mockBridge(
      liteHandlers({
        'db:execute': () => new Promise<QueryStatementResult[]>((resolve) => (release = resolve)),
        'db:cancel': () => true
      })
    )
    const tab = openTab({
      kind: 'query',
      title: 'q',
      connectionId: 'lite',
      payload: { sql: 'SELECT * FROM t' }
    })
    wrapper = await mountView(QueryView, tab, pinia)
    // A read on production runs without the typed confirmation.
    await wrapper.get('[data-test="run"]').trigger('click')
    await flushPromises()
    const exec = invoke.mock.calls.find((c) => c[0] === 'db:execute')!
    expect(exec[3]).not.toHaveProperty('confirmProduction')
    await wrapper.get('[data-test="stop"]').trigger('click')
    await flushPromises()
    const cancel = invoke.mock.calls.find((c) => c[0] === 'db:cancel')!
    expect(cancel[2]).toBe((exec[3] as { executionId: string }).executionId)
    release([result('SELECT * FROM t', { error: 'Consulta cancelada…' })])
    await flushPromises()
  })
})

describe('TableDataView on SQLite', () => {
  let wrapper: Awaited<ReturnType<typeof mountView>> | null = null
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    localStorage.clear()
  })

  const page: TableDataPage = {
    columns: [
      {
        name: 'rowid',
        type: '',
        table: 'notes',
        schema: 'main',
        sourceName: 'rowid',
        primaryKey: true,
        locked: 'rowid'
      },
      { name: 'title', type: 'TEXT', table: 'notes', schema: 'main', sourceName: 'title' },
      { name: 'n', type: '', table: 'notes', schema: 'main', sourceName: 'n' }
    ],
    rows: [[7, 'Hola', 5]],
    storage: [['integer', 'text', 'integer']],
    primaryKey: ['rowid'],
    total: 1,
    durationMs: 1
  }

  it('locks the rowid, keeps storage classes in the save payload and edits by rowid', async () => {
    const pinia = setupDom()
    seedSqlite()
    const invoke = mockBridge({
      'db:tableData': () => page,
      'db:columns': () => [],
      'db:applyRowChanges': () => ({ applied: 1, statements: [], insertIds: [null] }),
      'filters:list': () => []
    })
    const tab = openTab({
      kind: 'tableData',
      title: 'notes',
      connectionId: 'lite',
      schema: 'main',
      objectName: 'notes',
      objectType: 'table'
    })
    wrapper = await mountView(TableDataView, tab, pinia)
    await flushPromises()
    expect(wrapper.find('[data-test="read-only"]').exists()).toBe(false)
    const rowid = wrapper.get('[data-test="cell-0-0"]')
    expect(rowid.classes()).toContain('cell-locked')
    expect(wrapper.get('[data-test="cell-0-2"] .cell-value').attributes('title')).toContain(
      'Almacenado como INTEGER'
    )
    await rowid.trigger('dblclick')
    expect(wrapper.find('[data-test="cell-editor"]').exists()).toBe(false)
    await wrapper.get('[data-test="cell-0-2"]').trigger('dblclick')
    const input = wrapper.get('[data-test="cell-editor"] input')
    await input.setValue('6')
    await input.trigger('keydown', { key: 'Enter' })
    await (wrapper.vm as unknown as { applyChanges: () => Promise<void> }).applyChanges()
    await flushPromises()
    const save = invoke.mock.calls.find((c) => c[0] === 'db:applyRowChanges')!
    expect(save[2]).toBe('main')
    expect(save[4]).toEqual([
      { kind: 'update', key: { rowid: 7 }, values: { n: '6' }, storage: { n: 'integer' } }
    ])
  })

  it('a view (no row identity) is read-only and says why', async () => {
    const pinia = setupDom()
    seedSqlite()
    mockBridge({
      'db:tableData': () => ({
        ...page,
        columns: page.columns.slice(1).map((c) => ({ ...c, readOnlyReason: 'es una vista' })),
        rows: [['Hola', 5]],
        storage: [['text', 'integer']],
        primaryKey: []
      }),
      'db:columns': () => [],
      'filters:list': () => []
    })
    const tab = openTab({
      kind: 'tableData',
      title: 'v',
      connectionId: 'lite',
      schema: 'main',
      objectName: 'v',
      objectType: 'table'
    })
    wrapper = await mountView(TableDataView, tab, pinia)
    await flushPromises()
    expect(wrapper.get('[data-test="read-only"]').text()).toContain('Solo lectura: es una vista')
  })
})
