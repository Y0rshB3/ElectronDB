import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  TableDataPage,
  TableDataRequest,
  TableFilter,
  TableFilterCondition,
  TableFilterProfile
} from '@shared/types'
import { useTabsStore } from '@renderer/stores/tabs'
import { useUiStore } from '@renderer/stores/ui'
import TableDataView from '../TableDataView.vue'
import { mockBridge, mountView, openTab, setupDom } from './helpers'

const page: TableDataPage = {
  columns: [
    { name: 'id', type: 'INT', primaryKey: true },
    { name: 'email', type: 'VARCHAR' },
    { name: 'created_at', type: 'DATETIME' }
  ],
  rows: [[1, 'a@x.io', '2026-01-01 10:00:00']],
  primaryKey: ['id'],
  total: 1,
  durationMs: 3
}

type Wrapper = Awaited<ReturnType<typeof mountView>>

const tabInput = () => ({
  kind: 'tableData' as const,
  id: 'tableData:c1:shop:items',
  title: 't',
  connectionId: 'c1',
  schema: 'shop',
  objectName: 'items',
  objectType: 'table' as const
})

/** Teleported overlay content (menus, dialogs) lives in document.body. */
function body(selector: string): HTMLElement {
  // Closed menus stay mounted: prefer the open overlay, then the latest match.
  const active = [...document.body.querySelectorAll<HTMLElement>(`.v-overlay--active ${selector}`)]
  const any = [...document.body.querySelectorAll<HTMLElement>(selector)]
  const el = active.at(-1) ?? any.at(-1)
  if (!el) throw new Error(`no ${selector} in the document`)
  return el
}

async function pick(w: Wrapper, token: string, option: string, line = 0) {
  await w.findAll(`[data-test="${token}"]`)[line].trigger('click')
  await flushPromises()
  body(`[data-test="${option}"]`).click()
  await flushPromises()
}

async function typeValue(w: Wrapper, value: string, index = 0, submit = false) {
  await w.findAll('[data-test="filter-value-token"]')[index].trigger('click')
  await flushPromises()
  const input = w.get('[data-test="filter-value-input"]')
  await input.setValue(value)
  if (submit) await input.trigger('keydown', { key: 'Enter' })
  else await input.trigger('blur')
  await flushPromises()
}

const lines = (w: Wrapper) => w.findAll('[data-test^="filter-line-"]')
const condLines = (w: Wrapper) => w.findAll('[data-test="filter-line-condition"]')

describe('TableDataView Navicat filter builder', () => {
  let wrapper: Wrapper | null = null
  let requests: TableDataRequest[]
  let invoke: ReturnType<typeof mockBridge>
  let profiles: TableFilterProfile[]

  beforeEach(() => {
    document.body.innerHTML = ''
    requests = []
    profiles = []
  })
  afterEach(() => wrapper?.unmount())

  async function mount() {
    const pinia = setupDom()
    invoke = mockBridge({
      'db:tableData': (_c, req) => {
        requests.push(structuredClone(req) as TableDataRequest)
        return structuredClone(page)
      },
      'db:tableFilterSql': () => "(`email` LIKE '%jorge%')",
      'filters:list': () => structuredClone(profiles),
      'filters:save': (_c, _s, _t, name, filter) => {
        profiles = [
          ...profiles.filter((p) => p.name !== name),
          { name: name as string, filter: filter as TableFilter, updatedAt: 'now' }
        ]
        return structuredClone(profiles)
      },
      'filters:delete': (_c, _s, _t, name) => {
        profiles = profiles.filter((p) => p.name !== name)
        return structuredClone(profiles)
      }
    })
    const tab = openTab(tabInput())
    wrapper = await mountView(TableDataView, tab, pinia)
    await wrapper.get('[data-test="filter-toggle"]').trigger('click')
    return { tab, pinia, w: wrapper }
  }

  it('reads as a sentence: column, operator, value token, type hint, connector', async () => {
    const { w } = await mount()
    await w.get('[data-test="filter-add"]').trigger('click')
    await w.get('[data-test="filter-add"]').trigger('click')
    expect(condLines(w)).toHaveLength(2)
    const first = condLines(w)[0]
    expect(first.get('[data-test="filter-column-token"]').text()).toBe('id')
    expect(first.get('[data-test="filter-operator-token"]').text()).toBe('=')
    expect(first.get('[data-test="filter-value-token"]').text()).toBe('<?>')
    expect(first.get('[data-test="filter-type-hint"]').text()).toBe('[Número]')
    // Only lines with a following sibling show a connector.
    expect(first.get('[data-test="filter-connector"]').text()).toBe('y')
    expect(condLines(w)[1].find('[data-test="filter-connector"]').exists()).toBe(false)

    await pick(w, 'filter-column-token', 'filter-column-option-email')
    await pick(w, 'filter-operator-token', 'filter-operator-option-contains')
    expect(condLines(w)[0].text()).toContain('email')
    expect(condLines(w)[0].text()).toContain('contiene')
    expect(condLines(w)[0].get('[data-test="filter-type-hint"]').text()).toBe('[Texto]')
  })

  it('adapts the value tokens to the operator', async () => {
    const { w } = await mount()
    await w.get('[data-test="filter-add"]').trigger('click')
    const line = () => condLines(w)[0]
    await pick(w, 'filter-operator-token', 'filter-operator-option-isNull')
    expect(line().find('[data-test="filter-value-token"]').exists()).toBe(false)
    expect(line().find('[data-test="filter-type-hint"]').exists()).toBe(false)
    await pick(w, 'filter-operator-token', 'filter-operator-option-between')
    expect(line().findAll('[data-test="filter-value-token"]')).toHaveLength(2)
    await pick(w, 'filter-operator-token', 'filter-operator-option-in')
    expect(line().get('[data-test="filter-list-token"]').text()).toBe('<?>')
    await line().get('[data-test="filter-list-token"]').trigger('click')
    await flushPromises()
    const textarea = body('[data-test="filter-list-input"] textarea') as HTMLTextAreaElement
    textarea.value = '1, 2\n3'
    textarea.dispatchEvent(new Event('input'))
    await flushPromises()
    body('[data-test="filter-list-accept"]').click()
    await flushPromises()
    expect(line().get('[data-test="filter-list-token"]').text()).toBe('(1, 2, 3)')
    await pick(w, 'filter-operator-token', 'filter-operator-option-custom')
    expect(line().find('[data-test="filter-column-token"]').exists()).toBe(false)
    expect(line().get('[data-test="filter-value-token"]').classes()).toContain('is-sql')
  })

  it('applies a structured tree with per-condition connectors and brackets (Enter in a value)', async () => {
    const { w } = await mount()
    // email contiene jorge  o  ( id > 5  y  id < 9 )
    await w.get('[data-test="filter-add"]').trigger('click')
    await pick(w, 'filter-column-token', 'filter-column-option-email')
    await pick(w, 'filter-operator-token', 'filter-operator-option-contains')
    await typeValue(w, 'jorge')
    await w.get('[data-test="filter-add-group"]').trigger('click')
    await w.get('[data-test="filter-group-add"]').trigger('click')
    await w.get('[data-test="filter-connector"]').trigger('click')
    expect(lines(w).map((l) => l.attributes('data-test'))).toEqual([
      'filter-line-condition',
      'filter-line-open',
      'filter-line-condition',
      'filter-line-condition',
      'filter-line-close'
    ])
    await pick(w, 'filter-operator-token', 'filter-operator-option-gt', 1)
    await typeValue(w, '5', 1)
    await pick(w, 'filter-operator-token', 'filter-operator-option-lt', 2)
    await typeValue(w, '9', 2, true)

    const last = requests.at(-1)!
    expect(last.where).toBeNull()
    expect(last.offset).toBe(0)
    const c = (column: string, operator: string, values: string[], connector = 'AND') =>
      ({
        kind: 'condition',
        enabled: true,
        column,
        operator,
        values,
        connector
      }) as TableFilterCondition
    expect(last.filter).toEqual({
      kind: 'group',
      enabled: true,
      connector: 'AND',
      children: [
        c('email', 'contains', ['jorge'], 'OR'),
        {
          kind: 'group',
          enabled: true,
          connector: 'AND',
          children: [c('id', 'gt', ['5']), c('id', 'lt', ['9'])]
        }
      ]
    } satisfies TableFilter)
    expect(w.get('[data-test="footer"]').text()).toContain('filtrado')

    // Unchecked conditions stay (dimmed) and are sent disabled.
    await w.findAll('[data-test="filter-check"]')[0].setValue(false)
    expect(condLines(w)[0].classes()).toContain('is-disabled')
    await w.get('[data-test="apply-filter"]').trigger('click')
    await flushPromises()
    expect((requests.at(-1)!.filter!.children[0] as TableFilterCondition).enabled).toBe(false)

    // Hidden panel: the toolbar button keeps a badge with the applied conditions.
    await w.get('[data-test="filter-toggle"]').trigger('click')
    expect(w.find('[data-test="filter-panel"]').exists()).toBe(false)
    expect(w.get('[data-test="filter-badge"]').text()).toBe('2')
  })

  it('edits the structure from the right-click menus', async () => {
    const { w } = await mount()
    await w.get('[data-test="filter-add"]').trigger('click')
    await w.get('[data-test="filter-add"]').trigger('click')

    // Long menu on a condition line: wrap it in brackets.
    await condLines(w)[0].trigger('contextmenu', { clientX: 10, clientY: 10 })
    await flushPromises()
    expect(condLines(w)[0].classes()).toContain('is-selected')
    expect(body('[data-test="ctx-remove"]')).toBeTruthy()
    body('[data-test="ctx-wrap"]').click()
    await flushPromises()
    expect(lines(w).map((l) => l.attributes('data-test'))).toEqual([
      'filter-line-open',
      'filter-line-condition',
      'filter-line-close',
      'filter-line-condition'
    ])

    // Bracket line: "Borrar paréntesis" keeps its conditions.
    await w.get('[data-test="filter-line-open"]').trigger('contextmenu')
    await flushPromises()
    body('[data-test="ctx-unwrap"]').click()
    await flushPromises()
    expect(lines(w)).toHaveLength(2)

    // Short menu on the empty area: Añadir, Limpiar todo and disabled profile entries.
    await w.get('[data-test="filter-lines"]').trigger('contextmenu')
    await flushPromises()
    expect(document.body.querySelector('[data-test="ctx-wrap"]')).toBeNull()
    expect(body('[data-test="ctx-load-profile"]').classList).toContain('v-list-item--disabled')
    body('[data-test="ctx-add"]').click()
    await flushPromises()
    expect(condLines(w)).toHaveLength(3)

    await condLines(w)[2].trigger('contextmenu')
    await flushPromises()
    body('[data-test="ctx-remove"]').click()
    await flushPromises()
    expect(condLines(w)).toHaveLength(2)

    await w.get('[data-test="filter-lines"]').trigger('contextmenu')
    await flushPromises()
    body('[data-test="ctx-clear-all"]').click()
    await flushPromises()
    expect(lines(w)).toHaveLength(0)
  })

  it('refuses to apply an incomplete condition and marks it', async () => {
    const { w } = await mount()
    await w.get('[data-test="filter-add"]').trigger('click')
    const before = requests.length
    await w.get('[data-test="apply-filter"]').trigger('click')
    await flushPromises()
    expect(requests).toHaveLength(before)
    expect(condLines(w)[0].classes()).toContain('is-invalid')
    expect(w.text()).toContain('Falta el valor')
  })

  it('round-trips with the text mode: main generates the WHERE, edits stay raw SQL', async () => {
    const { w } = await mount()
    await w.get('[data-test="filter-add"]').trigger('click')
    await pick(w, 'filter-column-token', 'filter-column-option-email')
    await pick(w, 'filter-operator-token', 'filter-operator-option-contains')
    await typeValue(w, 'jorge')

    await w.get('[data-test="filter-text-mode"] input').setValue(true)
    await flushPromises()
    const call = invoke.mock.calls.find((c) => c[0] === 'db:tableFilterSql')!
    expect(call.slice(1, 4)).toEqual(['c1', 'shop', 'items'])
    expect((call[4] as TableFilter).children[0]).toMatchObject({ operator: 'contains' })
    const where = () => w.get('[data-test="where"] textarea')
    expect((where().element as HTMLTextAreaElement).value).toBe("(`email` LIKE '%jorge%')")

    await w.get('[data-test="filter-text-mode"] input').setValue(false)
    await flushPromises()
    expect(useUiStore().confirm.open).toBe(false)
    expect(condLines(w)).toHaveLength(1)

    await w.get('[data-test="filter-text-mode"] input').setValue(true)
    await flushPromises()
    await where().setValue("(`email` LIKE '%jorge%') AND id > 0")
    await where().trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(requests.at(-1)).toMatchObject({ where: "(`email` LIKE '%jorge%') AND id > 0" })
    expect(requests.at(-1)!.filter).toBeUndefined()

    await w.get('[data-test="filter-text-mode"] input').setValue(false)
    await flushPromises()
    const ui = useUiStore()
    expect(ui.confirm.open).toBe(true)
    ui.answer(false)
    await flushPromises()
    expect(w.find('[data-test="where"]').exists()).toBe(true)
  })

  it('saves and loads filter profiles through main', async () => {
    const { w } = await mount()
    await w.get('[data-test="filter-add"]').trigger('click')
    await pick(w, 'filter-operator-token', 'filter-operator-option-isNotNull')

    await w.get('[data-test="filter-lines"]').trigger('contextmenu')
    await flushPromises()
    body('[data-test="ctx-save-profile-as"]').click()
    await flushPromises()
    const name = body('[data-test="profile-name"] input') as HTMLInputElement
    name.value = 'Con id'
    name.dispatchEvent(new Event('input'))
    await flushPromises()
    body('[data-test="profile-name-confirm"]').click()
    await flushPromises()
    const save = invoke.mock.calls.find((c) => c[0] === 'filters:save')!
    expect(save.slice(1, 5)).toEqual(['c1', 'shop', 'items', 'Con id'])
    expect(w.get('[data-test="filter-profile"]').text()).toContain('Con id')

    await w.get('[data-test="filter-lines"]').trigger('contextmenu')
    await flushPromises()
    body('[data-test="ctx-clear-all"]').click()
    await flushPromises()
    expect(condLines(w)).toHaveLength(0)

    await w.get('[data-test="filter-lines"]').trigger('contextmenu')
    await flushPromises()
    expect(body('[data-test="ctx-load-profile"]').classList).not.toContain('v-list-item--disabled')
    // Same handler the submenu item runs.
    w.findComponent({ name: 'TableFilterPanel' }).vm.$emit('load-profile', 'Con id')
    await flushPromises()
    expect(condLines(w)).toHaveLength(1)
    expect(condLines(w)[0].text()).toContain('no es nulo')
  })

  it('keeps the filter and the panel per tab across a remount; Limpiar reloads unfiltered', async () => {
    const { tab, pinia, w } = await mount()
    await w.get('[data-test="filter-add"]').trigger('click')
    await pick(w, 'filter-operator-token', 'filter-operator-option-isNotNull')
    await w.get('[data-test="apply-filter"]').trigger('click')
    await flushPromises()
    w.unmount()

    const same = useTabsStore().tabs.find((t) => t.id === tab.id)!
    wrapper = await mountView(TableDataView, same, pinia)
    expect(condLines(wrapper)).toHaveLength(1)
    expect(requests.at(-1)!.filter!.children[0]).toMatchObject({ operator: 'isNotNull' })

    await wrapper.get('[data-test="filter-clear"]').trigger('click')
    await flushPromises()
    expect(condLines(wrapper)).toHaveLength(0)
    expect(requests.at(-1)!.filter).toBeUndefined()
    expect(requests.at(-1)!.where).toBeNull()
    expect(wrapper.find('[data-test="filter-badge"]').exists()).toBe(false)
  })
})
