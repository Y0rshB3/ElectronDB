import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectionConfig, SqliteAlterRequest, TableStructure } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useUiStore } from '@renderer/stores/ui'
import TableDesignerView from '../TableDesignerView.vue'
import { mockBridge, mountView, openTab, setupDom } from './helpers'

function seedSqlite(): void {
  useConnectionsStore().items = [
    {
      id: 'lite',
      name: 'Lite',
      environment: 'local',
      engine: 'sqlite',
      sqlite: { filePath: '/data/app.db' }
    } as ConnectionConfig
  ]
}

const structure: TableStructure = {
  schema: 'main',
  name: 'item',
  kind: 'table',
  tableType: 'BASE TABLE',
  columns: [
    {
      name: 'id',
      ordinal: 1,
      columnType: 'INTEGER',
      dataType: 'integer',
      nullable: false,
      key: 'PRI',
      defaultValue: null,
      extra: 'AUTOINCREMENT',
      characterSet: null,
      collation: null,
      comment: '',
      primaryKey: true,
      autoIncrement: true,
      generated: null
    },
    {
      name: 'price',
      ordinal: 2,
      columnType: 'TEXT',
      dataType: 'text',
      nullable: true,
      key: '',
      defaultValue: null,
      extra: '',
      characterSet: null,
      collation: null,
      comment: '',
      primaryKey: false,
      autoIncrement: false,
      generated: null
    }
  ],
  indexes: [
    {
      name: 'PRIMARY',
      unique: true,
      type: 'PRIMARY KEY',
      columns: ['id'],
      comment: '',
      primary: true,
      constraint: 'pk'
    }
  ],
  foreignKeys: [],
  engine: null,
  collation: null,
  comment: '',
  autoIncrement: 3,
  createSql:
    "CREATE TABLE item (id INTEGER PRIMARY KEY AUTOINCREMENT, price TEXT, CHECK (price <> ''))",
  constraints: [{ name: '', type: 'check', definition: "CHECK (price <> '')", columns: [] }],
  options: { withoutRowid: false, strict: false, autoincrement: true, virtual: false }
}

describe('SQLite table designer', () => {
  let wrapper: Awaited<ReturnType<typeof mountView>> | null = null
  afterEach(() => wrapper?.unmount())

  it('previews the rebuild with its dependents and sends one sqlite:alterTable', async () => {
    const pinia = setupDom()
    seedSqlite()
    const invoke = mockBridge({
      'db:tableStructure': () => structuredClone(structure),
      'sqlite:tableDependents': () => ({
        dependents: [
          { type: 'view', name: 'v_item', sql: 'CREATE VIEW v_item AS SELECT * FROM item' }
        ],
        sequence: 3,
        foreignKeys: true
      }),
      'sqlite:alterTable': () => ({ applied: [], warnings: [], durationMs: 1 })
    })
    const tab = openTab({
      kind: 'tableDesigner',
      title: 't',
      connectionId: 'lite',
      schema: 'main',
      objectName: 'item',
      objectType: 'table'
    })
    wrapper = await mountView(TableDesignerView, tab, pinia)
    expect(invoke).toHaveBeenCalledWith('sqlite:tableDependents', 'lite', 'main', 'item')
    expect(invoke).not.toHaveBeenCalledWith('db:charsets', 'lite')
    expect(wrapper.text()).not.toContain('Sin signo')

    // NOT NULL on an existing column: rebuild.
    await wrapper.get('[data-test="column-nullable-1"]').trigger('change')
    await flushPromises()
    expect(wrapper.find('[data-test="rebuild-note"]').text()).toContain('se reconstruirá')
    const vm = wrapper.vm as unknown as { previewSql: string }
    expect(vm.previewSql).toContain('PRAGMA foreign_keys = OFF;')
    expect(vm.previewSql).toContain('DROP VIEW IF EXISTS "main"."v_item";')
    expect(vm.previewSql).toContain("CHECK (price <> '')")
    expect(vm.previewSql).toContain('SET seq = max(seq, 3)')
    expect(vm.previewSql).toContain('PRAGMA foreign_keys = ON;')

    // Options keep the CHECK list and offer WITHOUT ROWID / STRICT, no MySQL fields.
    await wrapper.get('[data-test="tab-options"]').trigger('click')
    expect(wrapper.find('[data-test="sqlite-strict"]').exists()).toBe(true)
    expect(wrapper.get('[data-test="sqlite-checks"]').text()).toContain("CHECK (price <> '')")
    expect(wrapper.text()).not.toContain('Juego de caracteres')

    await wrapper.get('[data-test="copy-before"] input').setValue(false)
    await wrapper.get('[data-test="save"]').trigger('click')
    await flushPromises()
    const ui = useUiStore()
    if (ui.confirm.open) {
      ui.answer(true)
      await flushPromises()
    }
    const calls = invoke.mock.calls.filter((c) => c[0] === 'sqlite:alterTable')
    expect(calls).toHaveLength(1)
    const request = calls[0][3] as SqliteAlterRequest
    expect(request.table).toBe('item')
    expect(request.rebuild?.createBody).toContain('price TEXT NOT NULL')
    expect(request.rebuild?.autoincrement).toBe(true)
    expect(calls[0][4]).toEqual({ confirmProduction: true })
    expect(invoke).not.toHaveBeenCalledWith('sqlite:copyFile', expect.anything(), expect.anything())
  })

  it('creates a new table with an INTEGER PRIMARY KEY in one request', async () => {
    const pinia = setupDom()
    seedSqlite()
    const invoke = mockBridge({
      'sqlite:alterTable': () => ({ applied: [], warnings: [], durationMs: 1 }),
      'db:tables': () => []
    })
    const tab = openTab({
      kind: 'tableDesigner',
      title: 'Nueva',
      connectionId: 'lite',
      schema: 'main',
      objectType: 'table'
    })
    wrapper = await mountView(TableDesignerView, tab, pinia)
    await wrapper.get('[data-test="tab-options"]').trigger('click')
    await wrapper.get('[data-test="table-name"] input').setValue('orders')
    await wrapper.get('[data-test="save"]').trigger('click')
    await flushPromises()
    const ui = useUiStore()
    if (ui.confirm.open) {
      ui.answer(true)
      await flushPromises()
    }
    const calls = invoke.mock.calls.filter((c) => c[0] === 'sqlite:alterTable')
    expect(calls).toHaveLength(1)
    const request = calls[0][3] as SqliteAlterRequest
    expect(request).toMatchObject({ table: null, newName: 'orders', rebuild: null })
    expect(request.statements[0]).toBe('CREATE TABLE "main".orders (\n  id INTEGER PRIMARY KEY\n)')
  })
})
