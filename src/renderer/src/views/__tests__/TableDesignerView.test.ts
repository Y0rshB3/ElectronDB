import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { TableStructure } from '@shared/types'
import { useUiStore } from '@renderer/stores/ui'
import TableDesignerView from '../TableDesignerView.vue'
import { mockBridge, mountView, openTab, setupDom } from './helpers'

const structure: TableStructure = {
  schema: 'shop',
  name: 'items',
  columns: [
    {
      name: 'id',
      ordinal: 1,
      columnType: 'int unsigned',
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
  autoIncrement: 5,
  createSql: ''
}

describe('TableDesignerView', () => {
  let wrapper: Awaited<ReturnType<typeof mountView>> | null = null
  afterEach(() => wrapper?.unmount())

  it('generates ALTER TABLE for an added column and applies it', async () => {
    const pinia = setupDom()
    const invoke = mockBridge({
      'db:tableStructure': () => structuredClone(structure),
      'db:charsets': () => [
        {
          charset: 'utf8mb4',
          defaultCollation: 'utf8mb4_0900_ai_ci',
          collations: ['utf8mb4_0900_ai_ci']
        }
      ],
      'db:databases': () => [],
      'db:execute': (_c, sql) => [
        {
          sql,
          durationMs: 1,
          affectedRows: 0,
          insertId: null,
          changedRows: null,
          warnings: 0,
          resultSet: null,
          error: null
        }
      ]
    })
    const tab = openTab({
      kind: 'tableDesigner',
      title: 't',
      connectionId: 'c1',
      schema: 'shop',
      objectName: 'items',
      objectType: 'table'
    })
    wrapper = await mountView(TableDesignerView, tab, pinia)

    const vm = wrapper.vm as unknown as { previewSql: string }
    expect(vm.previewSql).toBe('-- Sin cambios')

    await wrapper.get('[data-test="add-column"]').trigger('click')
    await wrapper.get('[data-test="column-name-1"]').setValue('email')

    expect(vm.previewSql).toBe(
      'ALTER TABLE `shop`.`items`\n  ADD COLUMN `email` varchar(255) NULL DEFAULT NULL AFTER `id`;'
    )

    await wrapper.get('[data-test="save"]').trigger('click')
    await flushPromises()
    expect(useUiStore().confirm.open).toBe(false)
    expect(invoke).toHaveBeenCalledWith(
      'db:execute',
      'c1',
      'ALTER TABLE `shop`.`items`\n  ADD COLUMN `email` varchar(255) NULL DEFAULT NULL AFTER `id`;',
      { schema: 'shop', confirmProduction: true }
    )
    expect(invoke.mock.calls.filter((c) => c[0] === 'db:tableStructure')).toHaveLength(2)
  })

  it('always asks before narrowing a column type, and does not run when cancelled', async () => {
    const pinia = setupDom()
    const withName: TableStructure = {
      ...structure,
      columns: [
        ...structure.columns,
        {
          name: 'name',
          ordinal: 2,
          columnType: 'varchar(255)',
          dataType: 'varchar',
          nullable: true,
          key: '',
          defaultValue: null,
          extra: '',
          characterSet: 'utf8mb4',
          collation: null,
          comment: ''
        }
      ]
    }
    const invoke = mockBridge({
      'db:tableStructure': () => structuredClone(withName),
      'db:charsets': () => [],
      'db:databases': () => [],
      'db:execute': () => []
    })
    const tab = openTab({
      kind: 'tableDesigner',
      title: 't',
      connectionId: 'c1',
      schema: 'shop',
      objectName: 'items',
      objectType: 'table'
    })
    wrapper = await mountView(TableDesignerView, tab, pinia)
    const vm = wrapper.vm as unknown as { draft: { columns: { columnType: string }[] } }
    vm.draft.columns[1].columnType = 'varchar(10)'
    await flushPromises()
    await wrapper.get('[data-test="save"]').trigger('click')
    await flushPromises()
    const ui = useUiStore()
    expect(ui.confirm.open).toBe(true)
    expect(ui.confirm.production).toBeFalsy()
    expect(ui.confirm.message).toContain('varchar(255) a varchar(10)')
    ui.answer(false)
    await flushPromises()
    expect(invoke.mock.calls.some((c) => c[0] === 'db:execute')).toBe(false)
  })

  it('narrows the base type length when switching to a type without length', async () => {
    const pinia = setupDom()
    mockBridge({ 'db:charsets': () => [], 'db:databases': () => [] })
    const tab = openTab({
      kind: 'tableDesigner',
      title: 'Nueva',
      connectionId: 'c1',
      schema: 'shop',
      objectType: 'table'
    })
    wrapper = await mountView(TableDesignerView, tab, pinia)
    await wrapper.get('[data-test="add-column"]').trigger('click')
    const vm = wrapper.vm as unknown as {
      draft: { columns: { columnType: string; defaultValue: string | null }[] }
    }
    expect(vm.draft.columns[1].columnType).toBe('varchar(255)')
    const typeInput = wrapper.get('[data-test="column-row-1"] .designer-combo input')
    await typeInput.setValue('date')
    await typeInput.trigger('blur')
    await flushPromises()
    expect(vm.draft.columns[1].columnType).toBe('date')

    const defaultInput = wrapper.get(
      '[data-test="column-row-1"] [aria-label="Valor predeterminado"]'
    )
    await defaultInput.setValue("''")
    expect(vm.draft.columns[1].defaultValue).toBe('')
    await defaultInput.setValue('')
    expect(vm.draft.columns[1].defaultValue).toBeNull()
  })

  it('starts with an id column and CREATE TABLE preview in new-table mode', async () => {
    const pinia = setupDom()
    mockBridge({ 'db:charsets': () => [], 'db:databases': () => [] })
    const tab = openTab({
      kind: 'tableDesigner',
      title: 'Nueva',
      connectionId: 'c1',
      schema: 'shop',
      objectType: 'table'
    })
    wrapper = await mountView(TableDesignerView, tab, pinia)
    const vm = wrapper.vm as unknown as { previewSql: string; draft: { name: string } }
    expect(vm.previewSql).toBe('-- Sin cambios')
    vm.draft.name = 'clientes'
    await flushPromises()
    expect(vm.previewSql).toContain('CREATE TABLE `shop`.`clientes`')
    expect(vm.previewSql).toContain('`id` int unsigned NOT NULL AUTO_INCREMENT')
    expect(vm.previewSql).toContain('PRIMARY KEY (`id`)')
  })
})
