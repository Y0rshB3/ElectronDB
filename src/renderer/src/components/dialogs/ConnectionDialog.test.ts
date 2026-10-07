import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mock } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import { useUiStore } from '@renderer/stores/ui'
import ConnectionDialog from './ConnectionDialog.vue'
import { calls, freshPinia, makeConnection, mockElectronDB, mountWith, settle } from './testing'

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

  function authSelect(w: NonNullable<typeof wrapper>) {
    const select = w
      .findAllComponents({ name: 'VSelect' })
      .find((c) => c.attributes('data-test') === 'conn-auth-mode')
    if (!select) throw new Error('auth mode select not found')
    return select
  }

  it("saves «Sin contraseña» as authMode 'none', hides the password and tests without one", async () => {
    invoke = mockElectronDB({
      'connections:save': (input) => makeConnection({ ...(input as ConnectionInput), id: 'new-1' }),
      'connections:setPassword': () => undefined,
      'connections:hasPassword': () => false,
      'connections:hasSshPassword': () => false,
      'connections:test': () => ({ ok: true, serverVersion: '8.4.0', durationMs: 3 })
    })
    const pinia = freshPinia()
    const ui = useUiStore()
    ui.connectionDialog = { open: true, editing: null }
    wrapper = mountWith(ConnectionDialog, pinia)
    await settle()

    await wrapper.get('[data-test="conn-name"] input').setValue('Proxy')
    await wrapper.get('[data-test="conn-password"] input').setValue('typed-but-unused')
    authSelect(wrapper).vm.$emit('update:modelValue', 'none')
    await settle()
    expect(wrapper.find('[data-test="conn-password"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Guardar contraseña')
    expect(wrapper.get('[data-test="conn-no-password-hint"]').text()).toContain(
      'Cloud SQL Auth Proxy'
    )

    await wrapper.get('[data-test="conn-test"]').trigger('click')
    await settle()
    const [testInput, testPassword] = calls(invoke, 'connections:test')[0] as [
      ConnectionInput,
      string | null
    ]
    expect(testInput.authMode).toBe('none')
    expect(testPassword).toBeNull()

    await wrapper.get('[data-test="conn-save"]').trigger('click')
    await settle()
    const saved = calls(invoke, 'connections:save')[0][0] as ConnectionInput
    expect(saved.authMode).toBe('none')
    expect(calls(invoke, 'connections:setPassword')).toEqual([])
    expect(ui.connectionDialog.open).toBe(false)
  })

  it("drops the stored password when an edited connection switches to 'none'", async () => {
    const pinia = freshPinia()
    useUiStore().connectionDialog = {
      open: true,
      editing: makeConnection({ id: 'c1', name: 'Local' })
    }
    wrapper = mountWith(ConnectionDialog, pinia)
    await settle()
    authSelect(wrapper).vm.$emit('update:modelValue', 'none')
    await settle()
    expect(wrapper.get('[data-test="conn-no-password-hint"]').text()).toContain('se borrará')
    await wrapper.get('[data-test="conn-save"]').trigger('click')
    await settle()
    expect(calls(invoke, 'connections:setPassword')).toEqual([['new-1', null]]) // the beforeEach mock answers save with id new-1
  })

  it('treats records without authMode as password mode', async () => {
    const pinia = freshPinia()
    useUiStore().connectionDialog = {
      open: true,
      editing: makeConnection({ id: 'c1', name: 'Legacy' })
    }
    wrapper = mountWith(ConnectionDialog, pinia)
    await settle()
    expect(wrapper.find('[data-test="conn-password"]').exists()).toBe(true)
    expect(authSelect(wrapper).props('modelValue')).toBe('password')
  })

  it('suggests «Sin contraseña» when the server accepted an empty password', async () => {
    invoke = mockElectronDB({
      'connections:hasPassword': () => false,
      'connections:hasSshPassword': () => false,
      'connections:test': () => ({
        ok: true,
        serverVersion: '8.4.0',
        durationMs: 3,
        connectedWithoutPassword: true
      })
    })
    const pinia = freshPinia()
    useUiStore().connectionDialog = { open: true, editing: null }
    wrapper = mountWith(ConnectionDialog, pinia)
    await settle()
    await wrapper.get('[data-test="conn-test"]').trigger('click')
    await settle()
    await wrapper.get('[data-test="conn-use-no-password"]').trigger('click')
    await settle()
    expect(authSelect(wrapper).props('modelValue')).toBe('none')
    expect(wrapper.find('[data-test="conn-suggest-no-password"]').exists()).toBe(false)
  })
})
