import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ColumnInfo, TableDataPage } from '@shared/types'
import CellValuePanel from '@renderer/components/data/CellValuePanel.vue'
import EditableResult from '@renderer/components/query/EditableResult.vue'
import { resetValuePanelPref } from '@renderer/components/data/useValuePanelPref'
import { flushPromises } from '@vue/test-utils'
import TableDataView from '../TableDataView.vue'
import { mockBridge, mountComponent, mountView, openTab, setupDom } from './helpers'

const JSON_TEXT = '{"a":[1,2],"ok":true}'
const page: TableDataPage = {
  columns: [
    { name: 'id', type: 'INT', primaryKey: true },
    { name: 'payload', type: 'JSON' },
    { name: 'avatar', type: 'BLOB' },
    { name: 'note', type: 'VARCHAR' }
  ],
  rows: [
    [1, JSON_TEXT, '0xDEADBEEF', 'hola'],
    [2, null, null, 'adiós']
  ],
  primaryKey: ['id'],
  total: 2,
  durationMs: 1
}

const info = (name: string, columnType: string, nullable: boolean): ColumnInfo => ({
  name,
  ordinal: 1,
  columnType,
  dataType: columnType,
  nullable,
  key: '',
  defaultValue: null,
  extra: '',
  characterSet: null,
  collation: null,
  comment: ''
})

type Wrapper = Awaited<ReturnType<typeof mountView>>

describe('"Texto" value panel', () => {
  let wrapper: Wrapper | null = null
  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
    resetValuePanelPref()
  })
  afterEach(() => wrapper?.unmount())

  async function mount() {
    const pinia = setupDom()
    mockBridge({
      'db:tableData': () => structuredClone(page),
      'db:columns': () => [
        info('id', 'int', false),
        info('payload', 'json', true),
        info('avatar', 'blob', true),
        info('note', 'varchar(20)', true)
      ]
    })
    const tab = openTab({
      kind: 'tableData',
      title: 't',
      connectionId: 'c1',
      schema: 'shop',
      objectName: 'items',
      objectType: 'table'
    })
    wrapper = await mountView(TableDataView, tab, pinia)
    await wrapper.get('[data-test="value-toggle"]').trigger('click')
    return wrapper
  }

  const panel = (w: Wrapper) => w.get('[data-test="value-panel"]')

  it('shows the selected cell: JSON pretty printed and highlighted, with type and size', async () => {
    const w = await mount()
    expect(panel(w).text()).toContain('Selecciona una celda')
    await w.get('[data-test="cell-0-1"]').trigger('click')
    expect(w.get('[data-test="value-panel-column"]').text()).toBe('payload')
    expect(panel(w).text()).toContain('JSON')
    expect(w.get('[data-test="value-panel-size"]').text()).toContain('21 carácter(es)')
    const json = w.get('[data-test="value-panel-json"]')
    expect(json.text()).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "ok": true\n}')
    expect(json.findAll('.j-key').map((k) => k.text())).toEqual(['"a"', '"ok"'])
    expect(localStorage.getItem('electrondb.grid.valuePanel')).toContain('"open":true')
  })

  it('edits through the pending-edit model, keeping the original JSON text unless formatted', async () => {
    const w = await mount()
    await w.get('[data-test="cell-0-1"]').trigger('click')
    await w.get('[data-test="value-panel-edit"]').trigger('click')
    const text = w.get('[data-test="value-panel-text"]')
    expect((text.element as HTMLTextAreaElement).value).toBe(JSON_TEXT)
    await text.setValue('{"a":[1,2,3]}')
    await text.trigger('blur')
    expect(w.get('[data-test="cell-0-1"]').classes()).toContain('cell-changed')
    expect(w.get('[data-test="cell-0-1"]').text()).toBe('{"a":[1,2,3]}')
    expect(w.get('[data-test="pending"]').text()).toContain('1')

    await w.get('[data-test="value-panel-format"]').trigger('click')
    expect(w.get('[data-test="cell-0-1"]').text()).toContain('"a": [')
  })

  it('NULL only for nullable columns; NULL cells show a clear state', async () => {
    const w = await mount()
    await w.get('[data-test="cell-0-0"]').trigger('click')
    expect(w.find('[data-test="value-panel-null"]').exists()).toBe(false)
    await w.get('[data-test="cell-0-3"]').trigger('click')
    await w.get('[data-test="value-panel-null"]').trigger('click')
    expect(w.get('[data-test="cell-0-3"]').text()).toBe('(NULL)')
    expect(w.get('[data-test="value-panel-size"]').text()).toContain('NULL')
    expect(w.get('[data-test="value-panel-text"]').attributes('placeholder')).toBe('(NULL)')
  })

  it('shows binary as hex with its size, read-only', async () => {
    const w = await mount()
    await w.get('[data-test="cell-0-2"]').trigger('click')
    expect(w.get('[data-test="value-panel-hex"]').text()).toBe('00000000  DE AD BE EF')
    expect(w.get('[data-test="value-panel-size"]').text()).toContain('4 B')
    expect(w.find('[data-test="value-panel-text"]').exists()).toBe(false)
  })

  it('follows keyboard navigation in the grid', async () => {
    const w = await mount()
    await w.get('[data-test="cell-0-3"]').trigger('click')
    expect((w.get('[data-test="value-panel-text"]').element as HTMLTextAreaElement).value).toBe(
      'hola'
    )
    await w.get('.editable-grid').trigger('keydown', { key: 'ArrowDown' })
    expect((w.get('[data-test="value-panel-text"]').element as HTMLTextAreaElement).value).toBe(
      'adiós'
    )
    await w.get('.editable-grid').trigger('keydown', { key: 'ArrowLeft' })
    expect(w.get('[data-test="value-panel-column"]').text()).toBe('avatar')
  })

  it('is read-only for a read-only grid', async () => {
    const pinia = setupDom()
    const w = await mountComponent(
      CellValuePanel,
      { column: { name: 'note', type: 'VARCHAR' }, value: 'x', editable: false },
      pinia
    )
    expect(w.get('[data-test="value-panel-text"]').attributes('readonly')).toBeDefined()
    expect(w.find('[data-test="value-panel-null"]').exists()).toBe(false)
    await w.get('[data-test="value-panel-text"]').setValue('y')
    await w.get('[data-test="value-panel-text"]').trigger('blur')
    expect(w.emitted('edit')).toBeUndefined()
    w.unmount()
  })

  // Regression: with "Texto" on, the panel took the whole result area and the grid vanished.
  it('keeps the table grid rendered with a minimum height; the empty panel is just its header', async () => {
    const w = await mount()
    const area = w.get('[data-test="grid-area"]')
    expect((area.element as HTMLElement).style.minHeight).toBe('160px')
    expect(area.find('.editable-grid').exists()).toBe(true)
    expect(area.findAll('tbody tr')).toHaveLength(2)
    expect(panel(w).classes()).toContain('is-collapsed')
    expect(panel(w).find('.vpanel__body').exists()).toBe(false)

    await w.get('[data-test="cell-0-3"]').trigger('click')
    const style = (panel(w).element as HTMLElement).style
    expect(panel(w).classes()).not.toContain('is-collapsed')
    expect(style.flex).toBe('0 1 35%')
    expect(style.maxHeight).toBe('60%')
    expect(w.find('[data-test="grid-area"] .editable-grid').exists()).toBe(true)
  })

  it('keeps the query result grid visible under the panel and remembers the split per view', async () => {
    const pinia = setupDom()
    mockBridge({
      'db:tableStructure': () => ({
        schema: 'shop',
        name: 'items',
        tableType: 'BASE TABLE',
        columns: [info('id', 'int', false), info('note', 'varchar(20)', true)],
        indexes: [{ name: 'PRIMARY', unique: true, type: 'BTREE', columns: ['id'], comment: '' }],
        foreignKeys: [],
        engine: 'InnoDB',
        collation: null,
        comment: '',
        autoIncrement: null,
        createSql: ''
      })
    })
    const col = (name: string, pk = false) => ({
      name,
      type: name === 'id' ? 'INT' : 'VARCHAR',
      schema: 'shop',
      table: 'items',
      tableAlias: 'items',
      sourceName: name,
      ...(pk ? { primaryKey: true } : {})
    })
    const w = await mountComponent(
      EditableResult,
      {
        connectionId: 'c1',
        sql: 'SELECT id, note FROM shop.items',
        columns: [col('id', true), col('note')],
        rows: [
          [1, 'a'],
          [2, 'b']
        ],
        truncated: false
      },
      pinia
    )
    await flushPromises()
    await w.get('[data-test="value-toggle"]').trigger('click')
    const area = w.get('[data-test="grid-area"]')
    expect((area.element as HTMLElement).style.minHeight).toBe('min(160px, 70%)')
    expect(area.findAll('tbody tr')).toHaveLength(2)
    await w.get('[data-test="cell-1-1"]').trigger('click')
    const panelEl = w.get('[data-test="value-panel"]').element as HTMLElement
    expect(panelEl.style.flex).toBe('0 1 35%')
    expect((w.get('[data-test="value-panel-text"]').element as HTMLTextAreaElement).value).toBe('b')

    // Splitter: 400px host, 140px panel, ArrowUp (+20px) -> 40 % for "query" only.
    Object.defineProperty(panelEl.parentElement!, 'clientHeight', { value: 400 })
    panelEl.getBoundingClientRect = () => ({ height: 140 }) as DOMRect
    await w.get('.vpanel__splitter').trigger('keydown', { key: 'ArrowUp' })
    const stored = JSON.parse(localStorage.getItem('electrondb.grid.valuePanel') ?? '{}')
    expect(stored.ratio).toEqual({ table: 0.35, query: 0.4 })
    // Never above 60 %, never under 120px.
    panelEl.getBoundingClientRect = () => ({ height: 390 }) as DOMRect
    await w.get('.vpanel__splitter').trigger('keydown', { key: 'ArrowUp' })
    expect(panelEl.style.maxHeight).toBe('60%')
    expect(JSON.parse(localStorage.getItem('electrondb.grid.valuePanel')!).ratio.query).toBe(0.6)
    panelEl.getBoundingClientRect = () => ({ height: 50 }) as DOMRect
    await w.get('.vpanel__splitter').trigger('keydown', { key: 'ArrowDown' })
    expect(JSON.parse(localStorage.getItem('electrondb.grid.valuePanel')!).ratio.query).toBe(0.3)
    w.unmount()
  })
})
