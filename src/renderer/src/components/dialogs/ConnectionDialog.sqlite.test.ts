import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mock } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import { defaultSqliteOptions } from '@shared/engines'
import { useUiStore } from '@renderer/stores/ui'
import ConnectionDialog from './ConnectionDialog.vue'
import { emptyConnectionInput, sqliteNameFromPath } from './connectionForm'
import { freshPinia, makeConnection, mockVortaq, mountWith, settle } from './testing'
import { installDomPolyfills } from '@renderer/__tests__/shellTestUtils'

describe('ConnectionDialog · SQLite', () => {
  let invoke: Mock
  let wrapper: ReturnType<typeof mountWith> | null = null
  let picked: string | null
  let saveTarget: string | null

  beforeEach(() => {
    picked = '/data/shop.sqlite3'
    saveTarget = '/data/nueva.db'
    invoke = mockVortaq({
      'app:pickFile': () => picked,
      'app:pickSaveFile': () => saveTarget,
      'sqlite:createFile': (path) => ({ filePath: path, sqliteVersion: '3.53.4' }),
      'connections:save': (input) =>
        makeConnection({ ...(input as ConnectionInput), id: 'lite-1' }),
      'connections:hasPassword': () => false,
      'connections:hasSshPassword': () => false
    })
  })
  afterEach(() => wrapper?.unmount())

  async function openNew(): Promise<void> {
    const pinia = freshPinia()
    useUiStore().connectionDialog = { open: true, editing: null, engine: 'sqlite' }
    wrapper = mountWith(ConnectionDialog, pinia)
    await settle()
  }

  const savedInput = (): ConnectionInput =>
    invoke.mock.calls.find((c) => c[0] === 'connections:save')![1] as ConnectionInput

  it('shows the file section instead of host, user, password, SSH and SSL', async () => {
    await openNew()
    expect(wrapper!.find('[data-test="sqlite-path"]').exists()).toBe(true)
    expect(wrapper!.find('[data-test="conn-host"]').exists()).toBe(false)
    expect(wrapper!.find('[data-test="conn-password"]').exists()).toBe(false)
    expect(wrapper!.text()).not.toContain('SSH')
  })

  it('«Abrir archivo…» sets the path and the default name, and saves without a password', async () => {
    await openNew()
    await wrapper!.get('[data-test="sqlite-open-file"]').trigger('click')
    await settle()
    expect(
      (wrapper!.get('[data-test="sqlite-path"] input').element as HTMLInputElement).value
    ).toBe('/data/shop.sqlite3')
    expect((wrapper!.get('[data-test="conn-name"] input').element as HTMLInputElement).value).toBe(
      'shop'
    )
    await wrapper!.get('[data-test="conn-save"]').trigger('click')
    await settle()
    expect(savedInput()).toMatchObject({
      engine: 'sqlite',
      host: '',
      port: 0,
      authMode: 'none',
      sqlite: { filePath: '/data/shop.sqlite3', foreignKeys: false, readOnly: false }
    })
    expect(invoke.mock.calls.some((c) => c[0] === 'connections:setPassword')).toBe(false)
    expect(invoke.mock.calls.some((c) => c[0] === 'sqlite:createFile')).toBe(false)
  })

  it('offers the recent SQLite files of earlier connections («Recientes»)', async () => {
    installDomPolyfills()
    localStorage.removeItem('electrondb.sqlite.recentFiles')
    await openNew()
    expect(wrapper!.find('[data-test="sqlite-recent"]').exists()).toBe(false)
    await wrapper!.get('[data-test="sqlite-open-file"]').trigger('click')
    await settle()
    wrapper!.unmount()
    // A new dialog lists the file picked before; choosing it fills the path.
    localStorage.setItem(
      'electrondb.sqlite.recentFiles',
      JSON.stringify(['/data/notas.db', '/data/shop.sqlite3'])
    )
    await openNew()
    await wrapper!.get('[data-test="sqlite-recent"]').trigger('click')
    await settle()
    const item = document.querySelector('[data-test="sqlite-recent-notas.db"]') as HTMLElement
    expect(item).not.toBeNull()
    item.click()
    await settle()
    expect(
      (wrapper!.get('[data-test="sqlite-path"] input').element as HTMLInputElement).value
    ).toBe('/data/notas.db')
    localStorage.removeItem('electrondb.sqlite.recentFiles')
  })

  it('«Crear base de datos nueva…» creates the file and turns foreign keys on', async () => {
    await openNew()
    await wrapper!.get('[data-test="sqlite-create-file"]').trigger('click')
    await settle()
    const order = invoke.mock.calls.map((c) => c[0])
    expect(order.indexOf('app:pickSaveFile')).toBeLessThan(order.indexOf('sqlite:createFile'))
    expect(invoke.mock.calls.find((c) => c[0] === 'sqlite:createFile')![1]).toBe('/data/nueva.db')
    await wrapper!.get('[data-test="conn-save"]').trigger('click')
    await settle()
    expect(savedInput().sqlite).toMatchObject({ filePath: '/data/nueva.db', foreignKeys: true })
  })

  it('a cancelled save dialog creates nothing', async () => {
    saveTarget = null
    await openNew()
    await wrapper!.get('[data-test="sqlite-create-file"]').trigger('click')
    await settle()
    expect(invoke.mock.calls.some((c) => c[0] === 'sqlite:createFile')).toBe(false)
  })

  it('warns about a path from another computer until a file is picked', async () => {
    const pinia = freshPinia()
    const editing = makeConnection({
      id: 'lite-2',
      name: 'Imported',
      engine: 'sqlite',
      host: '',
      port: 0,
      sqlite: {
        ...defaultSqliteOptions(false),
        filePath: 'C:\\data\\app.db',
        pathNeedsReview: true
      }
    })
    useUiStore().connectionDialog = { open: true, editing }
    wrapper = mountWith(ConnectionDialog, pinia)
    await settle()
    expect(wrapper.find('[data-test="sqlite-path-review"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="conn-engine-chip"]').text()).toContain('SQLite')
    await wrapper.get('[data-test="sqlite-open-file"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="sqlite-path-review"]').exists()).toBe(false)
    await wrapper.get('[data-test="conn-save"]').trigger('click')
    await settle()
    expect(savedInput().sqlite).toMatchObject({
      filePath: '/data/shop.sqlite3',
      pathNeedsReview: false
    })
    expect(savedInput().name).toBe('Imported')
  })

  it('adds and removes attached databases and reports repeated aliases', async () => {
    await openNew()
    await wrapper!.get('[data-test="sqlite-open-file"]').trigger('click')
    await settle()
    await wrapper!.get('[data-test="sqlite-attach-add"]').trigger('click')
    await settle()
    picked = '/data/aux.db'
    await wrapper!.get('[data-test="sqlite-attach-pick-0"]').trigger('click')
    await settle()
    expect(
      (wrapper!.get('[data-test="sqlite-attach-alias-0"] input').element as HTMLInputElement).value
    ).toBe('aux')
    await wrapper!.get('[data-test="sqlite-attach-add"]').trigger('click')
    await settle()
    await wrapper!.get('[data-test="sqlite-attach-pick-1"]').trigger('click')
    await settle()
    await wrapper!.get('[data-test="conn-save"]').trigger('click')
    await settle()
    expect(wrapper!.get('[data-test="conn-errors"]').text()).toContain('está repetido')
    await wrapper!.get('[data-test="sqlite-attach-remove-1"]').trigger('click')
    await settle()
    await wrapper!.get('[data-test="conn-save"]').trigger('click')
    await settle()
    expect(savedInput().sqlite?.attached).toEqual([
      { alias: 'aux', filePath: '/data/aux.db', pathNeedsReview: false }
    ])
  })

  it('read-only follows production for a new connection and can be switched', async () => {
    await openNew()
    await wrapper!.get('[data-test="sqlite-open-file"]').trigger('click')
    await settle()
    const readOnly = (): boolean =>
      (wrapper!.get('[data-test="sqlite-readonly"] input').element as HTMLInputElement).checked
    expect(readOnly()).toBe(false)
    await wrapper!.get('[data-test="sqlite-readonly"] input').trigger('click')
    await settle()
    expect(readOnly()).toBe(true)
    await wrapper!.get('[data-test="conn-save"]').trigger('click')
    await settle()
    expect(savedInput().sqlite?.readOnly).toBe(true)
  })
})

describe('connectionForm · SQLite helpers', () => {
  it('builds an empty SQLite input without host, user or password', () => {
    expect(emptyConnectionInput('sqlite')).toMatchObject({
      engine: 'sqlite',
      host: '',
      port: 0,
      username: '',
      authMode: 'none',
      savePassword: false,
      sqlite: defaultSqliteOptions(false)
    })
  })

  it('names a connection after its file', () => {
    expect(sqliteNameFromPath('/a/b/shop.sqlite3')).toBe('shop')
    expect(sqliteNameFromPath('C:\\x\\Data.db')).toBe('Data')
    expect(sqliteNameFromPath('/a/noext')).toBe('noext')
  })
})
