import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mock } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import { useUiStore } from '@renderer/stores/ui'
import ConnectionDialog from './ConnectionDialog.vue'
import { freshPinia, makeConnection, mockElectronDB, mountWith, settle } from './testing'

describe('ConnectionDialog', () => {
  let invoke: Mock
  let wrapper: ReturnType<typeof mountWith> | null = null

  beforeEach(() => {
    invoke = mockElectronDB({
      'connections:save': (input) => makeConnection({ ...(input as ConnectionInput), id: 'new-1' }),
      'connections:setPassword': () => undefined,
      'connections:hasPassword': () => true,
      'connections:hasSshPassword': () => false
    })
  })
  afterEach(() => wrapper?.unmount())

  it('saves the connection and then stores the password through IPC', async () => {
    const pinia = freshPinia()
    const ui = useUiStore()
    ui.connectionDialog = { open: true, editing: null }
    wrapper = mountWith(ConnectionDialog, pinia)
    await settle()

    await wrapper.get('[data-test="conn-name"] input').setValue('Local')
    await wrapper.get('[data-test="conn-host"] input').setValue('127.0.0.1')
    await wrapper.get('[data-test="conn-user"] input').setValue('root')
    await wrapper.get('[data-test="conn-password"] input').setValue('s3cret')
    await wrapper.get('[data-test="conn-save"]').trigger('click')
    await settle()

    const channels = invoke.mock.calls.map((c) => c[0])
    const saveIdx = channels.indexOf('connections:save')
    const pwIdx = channels.indexOf('connections:setPassword')
    expect(saveIdx).toBeGreaterThanOrEqual(0)
    expect(pwIdx).toBeGreaterThan(saveIdx)
    const savedInput = invoke.mock.calls[saveIdx][1] as ConnectionInput
    expect(savedInput).toMatchObject({
      name: 'Local',
      host: '127.0.0.1',
      username: 'root',
      port: 3306
    })
    expect(JSON.stringify(savedInput)).not.toContain('s3cret')
    expect(invoke.mock.calls[pwIdx].slice(1)).toEqual(['new-1', 's3cret'])
    expect(ui.connectionDialog.open).toBe(false)
  })

  it('does not create a duplicate when storing the password fails and the user retries', async () => {
    let attempts = 0
    invoke = mockElectronDB({
      'connections:save': (input) =>
        makeConnection({
          ...(input as ConnectionInput),
          id: (input as ConnectionInput & { id?: string }).id ?? 'new-1'
        }),
      'connections:setPassword': () => {
        if (++attempts === 1) throw new Error('Keychain no disponible')
      },
      'connections:hasPassword': () => false,
      'connections:hasSshPassword': () => false
    })
    const pinia = freshPinia()
    const ui = useUiStore()
    ui.connectionDialog = { open: true, editing: null }
    wrapper = mountWith(ConnectionDialog, pinia)
    await settle()

    await wrapper.get('[data-test="conn-name"] input').setValue('Local')
    await wrapper.get('[data-test="conn-password"] input').setValue('s3cret')
    await wrapper.get('[data-test="conn-save"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-test="conn-errors"]').text()).toContain('se guardó')
    expect(ui.connectionDialog.open).toBe(true)
    expect(ui.connectionDialog.editing?.id).toBe('new-1')

    await wrapper.get('[data-test="conn-save"]').trigger('click')
    await settle()
    const saves = invoke.mock.calls
      .filter((c) => c[0] === 'connections:save')
      .map((c) => c[1] as ConnectionInput & { id?: string })
    expect(saves).toHaveLength(2)
    expect(saves[1].id).toBe('new-1')
    expect(ui.connectionDialog.open).toBe(false)
  })

  it('shows validation errors instead of saving an incomplete form', async () => {
    const pinia = freshPinia()
    useUiStore().connectionDialog = { open: true, editing: null }
    wrapper = mountWith(ConnectionDialog, pinia)
    await settle()
    await wrapper.get('[data-test="conn-save"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-test="conn-errors"]').text()).toContain('nombre')
    expect(invoke.mock.calls.some((c) => c[0] === 'connections:save')).toBe(false)
  })

  it('shows the saved-password chip when editing', async () => {
    const pinia = freshPinia()
    useUiStore().connectionDialog = {
      open: true,
      editing: makeConnection({ id: 'c1', name: 'Local' })
    }
    wrapper = mountWith(ConnectionDialog, pinia)
    await settle()
    expect(wrapper.get('[data-test="conn-password-saved"]').text()).toContain('contraseña guardada')
  })
})
