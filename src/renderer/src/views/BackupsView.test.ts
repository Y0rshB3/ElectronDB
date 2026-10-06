import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useTabsStore } from '@renderer/stores/tabs'
import { useUiStore } from '@renderer/stores/ui'
import BackupsView from './BackupsView.vue'
import {
  freshPinia,
  makeBackup,
  makeConnection,
  mockElectronDB,
  mountWith,
  settle
} from '@renderer/components/dialogs/testing'

const navicatFile = makeBackup({
  path: '/nav/billing/20260317145120-staging.nb3',
  source: 'navicat',
  label: 'staging'
})
const electronDBFile = makeBackup({
  path: '/nd/billing/20260401100000-manual.nb3',
  source: 'electrondb',
  createdAt: '2026-04-01T10:00:00.000Z'
})

describe('BackupsView', () => {
  let wrapper: ReturnType<typeof mountWith> | null = null

  beforeEach(() => {
    mockElectronDB({
      'backups:list': () => [navicatFile, electronDBFile],
      'backups:meta': () => ({
        metaVersion: '30101',
        databaseType: 'MYSQL',
        schema: 'billing',
        startTime: null,
        endTime: null,
        encryption: 'None',
        comment: '',
        objects: []
      })
    })
  })
  afterEach(() => wrapper?.unmount())

  async function mountView() {
    const pinia = freshPinia()
    const connections = useConnectionsStore()
    connections.items = [
      makeConnection({ id: 'c1', name: 'Staging', environment: 'staging' }),
      makeConnection({ id: 'loc', name: 'Local', environment: 'local' })
    ]
    const tab = useTabsStore().open({
      kind: 'backups',
      id: 'backups:c1:*',
      title: 'Copias',
      connectionId: 'c1'
    })
    wrapper = mountWith(BackupsView, pinia, { props: { tab } })
    await settle()
    return wrapper
  }

  function rowFor(w: NonNullable<typeof wrapper>, fileName: string) {
    const row = w.findAll('tbody tr').find((tr) => tr.text().includes(fileName))
    if (!row) throw new Error(`row ${fileName} not found`)
    return row
  }

  it('disables Eliminar for Navicat backups and enables it for ElectronDB ones', async () => {
    const w = await mountView()
    expect(w.findAll('tbody tr')).toHaveLength(2)

    await rowFor(w, navicatFile.fileName).trigger('click')
    await settle()
    expect(w.get('[data-test="backups-delete"]').attributes('disabled')).toBeDefined()

    await rowFor(w, electronDBFile.fileName).trigger('click')
    await settle()
    expect(w.get('[data-test="backups-delete"]').attributes('disabled')).toBeUndefined()
  })

  it('opens the restore dialog targeting the Local connection', async () => {
    const w = await mountView()
    await rowFor(w, navicatFile.fileName).trigger('click')
    await settle()
    await w.get('[data-test="backups-restore-local"]').trigger('click')
    const ui = useUiStore()
    expect(ui.restoreDialog).toMatchObject({ open: true, connectionId: 'loc' })
    expect(ui.restoreDialog.backup?.path).toBe(navicatFile.path)
  })
})
