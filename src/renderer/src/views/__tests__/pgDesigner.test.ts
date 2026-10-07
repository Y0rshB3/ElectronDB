import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectionConfig, TableStructure } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useUiStore } from '@renderer/stores/ui'
import NewDatabaseDialog from '@renderer/components/dialogs/NewDatabaseDialog.vue'
import DdlEditorView from '../DdlEditorView.vue'
import TableDesignerView from '../TableDesignerView.vue'
import { mockBridge, mountComponent, mountView, okExecute, openTab, setupDom } from './helpers'

/** A PostgreSQL connection in the store (the engine decides the designer and editor). */
function seedPg(): void {
  useConnectionsStore().items = [
    { id: 'pg1', name: 'PG', environment: 'local', engine: 'postgresql' } as ConnectionConfig
  ]
}

const REF = { database: 'shop', schema: 'app' }

const structure: TableStructure = {
  schema: 'app',
  database: 'shop',
  name: 'items',
  kind: 'table',
  tableType: 'BASE TABLE',
  columns: [
    {
      name: 'id',
      ordinal: 1,
      columnType: 'integer',
      dataType: 'integer',
      nullable: false,
      key: 'PRI',
      defaultValue: "nextval('app.items_id_seq'::regclass)",
      extra: 'serial',
      characterSet: null,
      collation: null,
      comment: '',
      primaryKey: true,
      autoIncrement: true,
      identity: null,
      generated: null,
      hasDefault: true,
      typeKind: 'integer'
    },
    {
      name: 'feeling',
      ordinal: 2,
      columnType: 'mood',
      dataType: 'mood',
      nullable: true,
      key: '',
      defaultValue: "'ok'::mood",
      extra: '',
      characterSet: null,
      collation: null,
      comment: '',
      primaryKey: false,
      autoIncrement: false,
      identity: null,
      generated: null,
      hasDefault: true,
      typeKind: 'enum',
      enumValues: ['sad', 'ok']
    }
  ],
  indexes: [
    {
      name: 'items_pkey',
      unique: true,
      type: 'btree',
      columns: ['id'],
      comment: '',
      primary: true,
      definition: 'CREATE UNIQUE INDEX items_pkey ON app.items USING btree (id)',
      constraint: 'items_pkey'
    }
  ],
  foreignKeys: [],
  constraints: [
    { name: 'items_pkey', type: 'primary', definition: 'PRIMARY KEY (id)', columns: ['id'] }
  ],
  engine: null,
  collation: null,
  comment: '',
  autoIncrement: null,
  createSql: '',
  options: { unlogged: false, owner: 'postgres', tablespace: '', partitionKey: '' }
}

const dataTypes = [
  { name: 'integer', schema: 'pg_catalog', kind: 'base' },
  { name: 'text', schema: 'pg_catalog', kind: 'base' },
  { name: 'mood', schema: 'app', kind: 'enum', enumValues: ['sad', 'ok'] }
]

describe('PostgreSQL table designer', () => {
  let wrapper: Awaited<ReturnType<typeof mountView>> | null = null
  afterEach(() => wrapper?.unmount())

  it('adds the enum value before the transaction and applies the plan in one BEGIN … COMMIT', async () => {
    const pinia = setupDom()
    seedPg()
    const invoke = mockBridge({
      'db:tableStructure': () => structuredClone(structure),
      'db:dataTypes': () => dataTypes,
      'db:schemas': () => [{ name: 'app', owner: 'postgres', comment: '', system: false }],
      'db:execute': okExecute
    })
    const tab = openTab({
      kind: 'tableDesigner',
      title: 't',
      connectionId: 'pg1',
      database: 'shop',
      schema: 'app',
      objectName: 'items',
      objectType: 'table'
    })
    wrapper = await mountView(TableDesignerView, tab, pinia)

    expect(invoke).toHaveBeenCalledWith('db:tableStructure', 'pg1', REF, 'items')
    expect(invoke).toHaveBeenCalledWith('db:dataTypes', 'pg1', 'shop')
    expect(invoke).not.toHaveBeenCalledWith('db:charsets', 'pg1')
    // MySQL-only fields are not rendered.
    expect(wrapper.text()).not.toContain('Sin signo')
    await wrapper.get('[data-test="tab-options"]').trigger('click')
    expect(wrapper.find('[data-test="pg-unlogged"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Juego de caracteres')
    await wrapper.get('[data-test="tab-fields"]').trigger('click')

    // Serial column: shown as auto increment (serial), read-only.
    await wrapper.get('[data-test="column-row-0"]').trigger('click')
    expect(wrapper.find('[data-test="serial-note"]').exists()).toBe(true)

    // Enum column: add a label and use it as the default.
    await wrapper.get('[data-test="column-row-1"]').trigger('click')
    await wrapper.get('[data-test="enum-new-label"] input').setValue('happy')
    await wrapper.get('[data-test="enum-add"]').trigger('click')
    await wrapper.get('[data-test="column-default-1"]').setValue("'happy'::mood")

    const vm = wrapper.vm as unknown as { previewSql: string }
    expect(vm.previewSql).toContain("ALTER TYPE mood ADD VALUE IF NOT EXISTS 'happy'")
    expect(vm.previewSql).toContain('BEGIN;')

    await wrapper.get('[data-test="save"]').trigger('click')
    await flushPromises()
    const ui = useUiStore()
    if (ui.confirm.open) {
      ui.answer(true)
      await flushPromises()
    }
    const executes = invoke.mock.calls.filter((c) => c[0] === 'db:execute')
    expect(executes).toHaveLength(2)
    expect(executes[0][2]).toBe("ALTER TYPE mood ADD VALUE IF NOT EXISTS 'happy';")
    expect(executes[0][3]).toEqual({ schema: REF, confirmProduction: true })
    const script = executes[1][2] as string
    expect(script.startsWith('BEGIN;\n')).toBe(true)
    expect(script.endsWith('\nCOMMIT;')).toBe(true)
    expect(script).toContain("ALTER COLUMN feeling SET DEFAULT 'happy'::mood")
    expect(executes[1][3]).toEqual({ schema: REF, confirmProduction: true })
  })

  it('creates a new table from an identity id in one transaction', async () => {
    const pinia = setupDom()
    seedPg()
    const invoke = mockBridge({
      'db:dataTypes': () => dataTypes,
      'db:schemas': () => [],
      'db:execute': okExecute
    })
    const tab = openTab({
      kind: 'tableDesigner',
      title: 'Nueva',
      connectionId: 'pg1',
      database: 'shop',
      schema: 'app',
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
    const executes = invoke.mock.calls.filter((c) => c[0] === 'db:execute')
    expect(executes).toHaveLength(1)
    const script = executes[0][2] as string
    expect(script).toMatch(/^BEGIN;\nCREATE TABLE app\.orders \(/)
    expect(script).toContain('GENERATED BY DEFAULT AS IDENTITY')
    expect(script.endsWith('\nCOMMIT;')).toBe(true)
  })
})

describe('PostgreSQL DDL editor', () => {
  let wrapper: Awaited<ReturnType<typeof mountView>> | null = null
  afterEach(() => wrapper?.unmount())

  it('loads an overloaded function by signature and applies CREATE OR REPLACE without DEFINER', async () => {
    const pinia = setupDom()
    seedPg()
    const fn =
      'CREATE OR REPLACE FUNCTION app.add(a integer, b integer)\n RETURNS integer\n LANGUAGE sql\nAS $function$ SELECT a + b $function$'
    const invoke = mockBridge({ 'db:showCreate': () => fn, 'db:execute': okExecute })
    const tab = openTab({
      kind: 'ddlEditor',
      title: 'add',
      connectionId: 'pg1',
      database: 'shop',
      schema: 'app',
      objectName: 'add',
      objectType: 'function',
      payload: { signature: 'a integer, b integer' }
    })
    wrapper = await mountView(DdlEditorView, tab, pinia)
    expect(invoke).toHaveBeenCalledWith('db:showCreate', 'pg1', REF, 'function', {
      type: 'function',
      name: 'add',
      signature: 'a integer, b integer'
    })
    expect(wrapper.find('[data-test="remove-definer"]').exists()).toBe(false)

    await wrapper.get('[data-test="sql-editor"]').setValue(fn.replace('a + b', 'a + b + 0'))
    await wrapper.get('[data-test="apply"]').trigger('click')
    await flushPromises()
    const ui = useUiStore()
    if (ui.confirm.open) {
      ui.answer(true)
      await flushPromises()
    }
    const call = invoke.mock.calls.find((c) => c[0] === 'db:execute')!
    expect(call[2]).toBe(`${fn.replace('a + b', 'a + b + 0')};`)
    expect(call[3]).toEqual({ schema: REF, confirmProduction: true })
  })

  it('opens a materialized view and rebuilds it with DROP + CREATE', async () => {
    const pinia = setupDom()
    seedPg()
    const mv = 'CREATE MATERIALIZED VIEW app.mv_counts AS\n SELECT 1 AS n\nWITH DATA;'
    const invoke = mockBridge({ 'db:showCreate': () => mv, 'db:execute': okExecute })
    const tab = openTab({
      kind: 'ddlEditor',
      title: 'mv',
      connectionId: 'pg1',
      database: 'shop',
      schema: 'app',
      objectName: 'mv_counts',
      objectType: 'materialized_view' as never
    })
    wrapper = await mountView(DdlEditorView, tab, pinia)
    expect(invoke).toHaveBeenCalledWith(
      'db:showCreate',
      'pg1',
      REF,
      'materialized_view',
      'mv_counts'
    )
    const vm = wrapper.vm as unknown as { script: string }
    expect(vm.script).toBe(
      'DROP MATERIALIZED VIEW IF EXISTS app.mv_counts;\nCREATE MATERIALIZED VIEW app.mv_counts AS\n SELECT 1 AS n\nWITH DATA;'
    )
  })
})

describe('NewDatabaseDialog on PostgreSQL', () => {
  it('sends owner, template and encoding instead of a charset', async () => {
    const pinia = setupDom()
    seedPg()
    const invoke = mockBridge({ 'db:createDatabase': () => undefined, 'db:databases': () => [] })
    useUiStore().newDatabaseDialog = { open: true, connectionId: 'pg1' } as never
    const wrapper = await mountComponent(NewDatabaseDialog, {}, pinia)
    expect(invoke).not.toHaveBeenCalledWith('db:charsets', 'pg1')
    const field = (test: string) => document.querySelector(`[data-test="${test}"] input`)!
    const set = async (test: string, value: string) => {
      const input = field(test) as HTMLInputElement
      input.value = value
      input.dispatchEvent(new Event('input'))
      await flushPromises()
    }
    await set('newdb-name', 'reports')
    await set('newdb-owner', 'app_owner')
    await set('newdb-encoding', 'UTF8')
    ;(document.querySelector('[data-test="newdb-save"]') as HTMLElement).click()
    await flushPromises()
    const ui = useUiStore()
    if (ui.confirm.open) {
      ui.answer(true)
      await flushPromises()
    }
    expect(invoke).toHaveBeenCalledWith(
      'db:createDatabase',
      'pg1',
      'reports',
      '',
      '',
      { confirmProduction: true },
      { owner: 'app_owner', encoding: 'UTF8' }
    )
    wrapper.unmount()
  })
})
