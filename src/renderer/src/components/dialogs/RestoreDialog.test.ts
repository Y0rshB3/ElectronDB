import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mock } from 'vitest'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useUiStore } from '@renderer/stores/ui'
import RestoreDialog from './RestoreDialog.vue'
import {
  calls,
  freshPinia,
  makeBackup,
  makeConnection,
  mockElectronDB,
  mountWith,
  settle
} from './testing'

const backup = makeBackup({
  path: '/b/billing/20260317145120-staging.nb3',
  source: 'navicat',
  label: 'staging'
})
const meta = {
  metaVersion: '30101',
  databaseType: 'MYSQL',
  schema: 'billing',
  startTime: null,
  endTime: null,
  encryption: 'None',
  comment: '',
  objects: [{ uuid: 'u1', type: 'Table', name: 'account', rows: 3 }]
}

describe('RestoreDialog', () => {
  let invoke: Mock
  let wrapper: ReturnType<typeof mountWith> | null = null

  beforeEach(() => {
    invoke = mockElectronDB({
      'backups:meta': () => meta,
      'connections:open': () => ({ version: '8.4.7' }),
      'db:databases': () => [
        { name: 'billing', characterSet: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }
      ],
      'backups:restore': () => ({ objectsRestored: 1, rowsInserted: 3, errors: [], durationMs: 12 })
    })
  })
  afterEach(() => wrapper?.unmount())

  async function mountFor(targetId: string) {
    const pinia = freshPinia()
    const connections = useConnectionsStore()
    connections.items = [
      makeConnection({ id: 'prod', name: 'Production', environment: 'production' }),
      makeConnection({ id: 'local', name: 'Local', environment: 'local' })
    ]
    connections.loaded = true
    useUiStore().restoreDialog = { open: true, backup, connectionId: targetId }
    wrapper = mountWith(RestoreDialog, pinia)
    await settle()
    return wrapper
  }

  it('keeps Restaurar disabled on production until the connection name is typed, then sends confirmProduction', async () => {
    const w = await mountFor('prod')
    expect(w.find('[data-test="restore-production-warning"]').exists()).toBe(true)
    const submit = () => w.get('[data-test="restore-submit"]')
    expect(submit().attributes('disabled')).toBeDefined()

    const input = w.get('[data-test="restore-confirm-name"] input')
    await input.setValue('Product')
    expect(submit().attributes('disabled')).toBeDefined()

    await input.setValue('Production')
    expect(submit().attributes('disabled')).toBeUndefined()

    await submit().trigger('click')
    await settle()
    const restoreCalls = calls(invoke, 'backups:restore')
    expect(restoreCalls).toHaveLength(1)
    expect(restoreCalls[0][0]).toMatch(/^restore-/)
    expect(restoreCalls[0][1]).toMatchObject({
      backupPath: backup.path,
      connectionId: 'prod',
      targetSchema: 'billing',
      confirmProduction: true
    })
    expect(w.find('[data-test="restore-result"]').exists()).toBe(true)
  })

  it('restores into a local connection without the production guard', async () => {
    const w = await mountFor('local')
    expect(w.find('[data-test="restore-production-warning"]').exists()).toBe(false)
    const submit = w.get('[data-test="restore-submit"]')
    expect(submit.attributes('disabled')).toBeUndefined()
    await submit.trigger('click')
    await settle()
    const [[, options]] = calls(invoke, 'backups:restore') as [[string, Record<string, unknown>]]
    expect(options.connectionId).toBe('local')
    expect('confirmProduction' in options).toBe(false)
  })
})
