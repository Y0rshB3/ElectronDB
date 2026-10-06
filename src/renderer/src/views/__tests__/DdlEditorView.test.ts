import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { useUiStore } from '@renderer/stores/ui'
import DdlEditorView from '../DdlEditorView.vue'
import { mockBridge, mountView, openTab, setupDom } from './helpers'

const PROC = 'CREATE DEFINER=`admin`@`%` PROCEDURE `refresh_totals`()\nBEGIN\n  SELECT 1;\nEND'

describe('DdlEditorView', () => {
  let wrapper: Awaited<ReturnType<typeof mountView>> | null = null
  afterEach(() => wrapper?.unmount())

  it('strips DEFINER and applies DROP + CREATE for a procedure', async () => {
    const pinia = setupDom()
    const invoke = mockBridge({
      'db:showCreate': () => PROC,
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
      kind: 'ddlEditor',
      title: 'p',
      connectionId: 'c1',
      schema: 'shop',
      objectName: 'refresh_totals',
      objectType: 'procedure'
    })
    wrapper = await mountView(DdlEditorView, tab, pinia)

    expect(invoke).toHaveBeenCalledWith(
      'db:showCreate',
      'c1',
      'shop',
      'procedure',
      'refresh_totals'
    )
    await wrapper.get('[data-test="remove-definer"] input').setValue(true)
    await wrapper.get('[data-test="apply"]').trigger('click')
    await flushPromises()

    // Replacing a routine always asks first
    const ui = useUiStore()
    expect(ui.confirm.open).toBe(true)
    ui.answer(true)
    await flushPromises()

    const call = invoke.mock.calls.find((c) => c[0] === 'db:execute')!
    const script = call[2] as string
    expect(script).not.toMatch(/DEFINER/i)
    expect(script).toBe(
      'DROP PROCEDURE IF EXISTS `shop`.`refresh_totals`;\nDELIMITER $$\nCREATE PROCEDURE `refresh_totals`()\nBEGIN\n  SELECT 1;\nEND$$\nDELIMITER ;'
    )
    expect(call[3]).toEqual({ schema: 'shop', confirmProduction: true })
  })

  it('does not execute when the confirmation is cancelled', async () => {
    const pinia = setupDom()
    const invoke = mockBridge({ 'db:showCreate': () => PROC, 'db:execute': () => [] })
    const tab = openTab({
      kind: 'ddlEditor',
      title: 'p',
      connectionId: 'c1',
      schema: 'shop',
      objectName: 'refresh_totals',
      objectType: 'procedure'
    })
    wrapper = await mountView(DdlEditorView, tab, pinia)
    await wrapper.get('[data-test="apply"]').trigger('click')
    await flushPromises()
    useUiStore().answer(false)
    await flushPromises()
    expect(invoke.mock.calls.some((c) => c[0] === 'db:execute')).toBe(false)
  })

  it('opens a template for new objects', async () => {
    const pinia = setupDom()
    mockBridge({})
    const tab = openTab({
      kind: 'ddlEditor',
      title: 'v',
      connectionId: 'c1',
      schema: 'shop',
      objectType: 'view'
    })
    wrapper = await mountView(DdlEditorView, tab, pinia)
    const vm = wrapper.vm as unknown as { sql: string; script: string }
    expect(vm.sql).toContain('CREATE VIEW `nueva_vista`')
    expect(vm.script).toMatch(/^CREATE OR REPLACE VIEW `nueva_vista`/)
  })
})
