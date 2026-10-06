import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ColumnInfo, QueryColumn } from '@shared/types'
import { mountComponent, setupDom } from '../../views/__tests__/helpers'
import EditableGrid from './EditableGrid.vue'
import { rowsFromPage } from './rowEditing'

const columns: QueryColumn[] = [
  { name: 'id', type: 'INT', primaryKey: true },
  { name: 'dateEnd', type: 'DATETIME' },
  { name: 'born', type: 'DATE' },
  { name: 'note', type: 'VARCHAR' }
]

function info(name: string, columnType: string, nullable: boolean): ColumnInfo {
  return {
    name,
    ordinal: 1,
    columnType,
    dataType: columnType.replace(/\(.*/, ''),
    nullable,
    key: '',
    defaultValue: null,
    extra: '',
    characterSet: null,
    collation: null,
    comment: ''
  }
}

type Wrapper = Awaited<ReturnType<typeof mountComponent>>

function body(selector: string): HTMLElement {
  const active = [...document.body.querySelectorAll<HTMLElement>(`.v-overlay--active ${selector}`)]
  const el = active.at(-1) ?? document.body.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`no ${selector}`)
  return el
}

describe('EditableGrid', () => {
  let wrapper: Wrapper | null = null
  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
  })
  afterEach(() => wrapper?.unmount())

  async function mount(extra: Record<string, unknown> = {}) {
    const pinia = setupDom()
    wrapper = await mountComponent(
      EditableGrid,
      {
        columns,
        rows: rowsFromPage([
          [1, '2026-09-30 23:45:00', '2026-09-30', 'hola'],
          [2, '0000-00-00 00:00:00', null, null]
        ]),
        primaryKey: ['id'],
        sort: null,
        columnInfo: [
          info('id', 'int', false),
          info('dateEnd', 'datetime', false),
          info('born', 'date', true),
          info('note', 'varchar(20)', true)
        ],
        ...extra
      },
      pinia
    )
    return { w: wrapper, pinia }
  }

  const edits = (w: Wrapper) => (w.emitted('edit') ?? []) as unknown[][]

  // Regression: the column shrank when a cell entered edit mode ("…30 23:45:00").
  it('keeps the cell box when editing: the value stays in the flow and the editor overlays it', async () => {
    const { w } = await mount()
    const cell = w.get('[data-test="cell-0-1"]')
    const before = cell.attributes('style')
    await cell.trigger('dblclick')
    await flushPromises()
    const sizer = cell.get('.cell-value')
    expect(sizer.classes()).toContain('is-sizer')
    expect(sizer.text()).toBe('2026-09-30 23:45:00')
    expect(cell.get('.cell-editor').find('[data-test="cell-input"]').exists()).toBe(true)
    expect(cell.attributes('style')).toBe(before)
    // Plain text columns too.
    await w.get('[data-test="cell-0-3"]').trigger('dblclick')
    await flushPromises()
    expect(w.get('[data-test="cell-0-3"] .cell-value').text()).toBe('hola')
    expect(w.find('[data-test="cell-0-3"] .cell-editor input').exists()).toBe(true)
  })

  it('edits a DATETIME with the picker editor: validates, normalises and commits on Enter', async () => {
    const { w } = await mount()
    await w.get('[data-test="cell-0-1"]').trigger('dblclick')
    await flushPromises()
    const input = () => w.get('[data-test="cell-0-1"] [data-test="cell-input"]')
    expect(w.find('[data-test="temporal-input"]').exists()).toBe(true)

    await input().setValue('2026-02-30 10:00')
    await input().trigger('keydown', { key: 'Enter' })
    expect(w.get('[data-test="temporal-error"]').text()).toMatch(/día/)
    expect(edits(w)).toHaveLength(0)

    await input().setValue('2026-9-30T23:59')
    await input().trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(edits(w)).toEqual([[expect.any(String), 1, '2026-09-30 23:59:00']])
    expect(w.find('[data-test="temporal-input"]').exists()).toBe(false)
  })

  it('Esc cancels; Alt+ArrowDown opens the calendar; picking a day rewrites only the date', async () => {
    const { w } = await mount()
    await w.get('[data-test="cell-0-1"]').trigger('dblclick')
    await flushPromises()
    const input = () => w.get('[data-test="cell-0-1"] [data-test="cell-input"]')
    await input().trigger('keydown', { key: 'ArrowDown', altKey: true })
    await flushPromises()
    expect(body('[data-test="temporal-picker"]')).toBeTruthy()
    body('[data-test="temporal-day-1"]').click()
    await flushPromises()
    expect((input().element as HTMLInputElement).value).toBe('2026-09-01 23:45:00')
    // NOT NULL column: no NULL action.
    expect(document.body.querySelector('.v-overlay--active [data-test="temporal-null"]')).toBeNull()
    body('[data-test="temporal-accept"]').click()
    await flushPromises()
    expect(edits(w).at(-1)).toEqual([expect.any(String), 1, '2026-09-01 23:45:00'])

    await w.get('[data-test="cell-1-1"]').trigger('dblclick')
    await flushPromises()
    await w
      .get('[data-test="cell-1-1"] [data-test="cell-input"]')
      .trigger('keydown', { key: 'Escape' })
    expect(w.find('[data-test="temporal-input"]').exists()).toBe(false)
    expect(edits(w)).toHaveLength(1)
  })

  it('offers NULL only on nullable columns and keeps zero dates as they are', async () => {
    const { w } = await mount()
    // Zero datetime: opens and commits unchanged (no edit).
    await w.get('[data-test="cell-1-1"]').trigger('dblclick')
    await flushPromises()
    const zero = w.get('[data-test="cell-1-1"] [data-test="cell-input"]')
    expect((zero.element as HTMLInputElement).value).toBe('0000-00-00 00:00:00')
    await zero.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(edits(w)).toHaveLength(0)

    // Nullable DATE: the picker offers NULL, which writes NULL.
    await w.get('[data-test="cell-0-2"]').trigger('dblclick')
    await flushPromises()
    await w.get('[data-test="cell-0-2"] [data-test="temporal-open"]').trigger('click')
    await flushPromises()
    body('[data-test="temporal-null"]').click()
    await flushPromises()
    expect(edits(w).at(-1)).toEqual([expect.any(String), 2, null])
  })

  it('resizes a column by dragging the header edge and fits it on double click', async () => {
    const { w } = await mount()
    const handle = w.get('[data-test="resize-note"]')
    const th = w.get('[data-test="header-note"]').element as HTMLElement
    th.getBoundingClientRect = () => ({ width: 100 }) as DOMRect
    handle.element.dispatchEvent(new MouseEvent('pointerdown', { clientX: 200, bubbles: true }))
    handle.element.dispatchEvent(new MouseEvent('pointermove', { clientX: 260, bubbles: true }))
    handle.element.dispatchEvent(new MouseEvent('pointerup', { clientX: 260, bubbles: true }))
    await flushPromises()
    expect(th.style.width).toBe('160px')
    expect((w.get('[data-test="cell-0-3"]').element as HTMLElement).style.width).toBe('160px')
    // Never below the minimum.
    handle.element.dispatchEvent(new MouseEvent('pointerdown', { clientX: 200, bubbles: true }))
    handle.element.dispatchEvent(new MouseEvent('pointermove', { clientX: 0, bubbles: true }))
    handle.element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    await flushPromises()
    expect(th.style.width).toBe('48px')
    // Header click after a drag must not sort.
    expect(w.emitted('sort')).toBeUndefined()

    w.findAll('td[data-col="3"] .cell-value').forEach((v, i) =>
      Object.defineProperty(v.element, 'scrollWidth', { value: i === 0 ? 300 : 120 })
    )
    await handle.trigger('dblclick')
    expect(th.style.width).toBe('326px')
  })

  it('remembers widths by key across remounts (paging, refresh, reopening)', async () => {
    const { w, pinia } = await mount({ widthKey: 'c1:shop:items' })
    const handle = w.get('[data-test="resize-note"]')
    ;(w.get('[data-test="header-note"]').element as HTMLElement).getBoundingClientRect = () =>
      ({ width: 90 }) as DOMRect
    handle.element.dispatchEvent(new MouseEvent('pointerdown', { clientX: 0, bubbles: true }))
    handle.element.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, bubbles: true }))
    handle.element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    await flushPromises()
    w.unmount()
    wrapper = await mountComponent(
      EditableGrid,
      {
        columns,
        rows: rowsFromPage([[3, null, null, 'x']]),
        primaryKey: [],
        sort: null,
        widthKey: 'c1:shop:items'
      },
      pinia
    )
    expect((wrapper.get('[data-test="header-note"]').element as HTMLElement).style.width).toBe(
      '120px'
    )
    expect(localStorage.getItem('electrondb.grid.columnWidths')).toContain('"note":120')
  })
})
