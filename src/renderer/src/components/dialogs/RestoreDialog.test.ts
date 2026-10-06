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
    expect('replaceSchema' in options).toBe(false)
  })

  it('a safety copy opens in «Reemplazar la base de datos completa» mode and undoes with a confirmed replace', async () => {
    const safety = makeBackup({
      path: '/b/local/billing/20261006001037-previo-rollback.nb3',
      fileName: '20261006001037-previo-rollback.nb3',
      connectionId: 'local',
      schema: 'billing',
      source: 'electrondb',
      label: 'previo-rollback'
    })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'backups:meta') return meta
      if (channel === 'backups:restore')
        return {
          objectsRestored: 1,
          rowsInserted: 3,
          errors: [],
          durationMs: 12,
          safetyBackupPath: '/b/local/billing/20261006002000-previo-rollback.nb3'
        }
      return []
    })
    const pinia = freshPinia()
    const connections = useConnectionsStore()
    connections.items = [
      makeConnection({ id: 'prod', name: 'Production', environment: 'production' }),
      makeConnection({ id: 'local', name: 'Local', environment: 'local' })
    ]
    connections.loaded = true
    const ui = useUiStore()
    ui.restoreDialog = { open: true, backup: safety, connectionId: null }
    wrapper = mountWith(RestoreDialog, pinia)
    await settle()
    const w = wrapper
    expect(w.find('[data-test="restore-safety-copy-info"]').exists()).toBe(true)
    expect(w.find('[data-test="restore-replace-options"]').exists()).toBe(true)
    expect(w.get('[data-test="restore-replace-warning"]').text()).toContain(
      'lo que no esté en la copia desaparece'
    )
    await w.get('[data-test="restore-submit"]').trigger('click')
    await settle()
    expect(ui.confirm.open).toBe(true)
    expect(ui.confirm.message).toContain('«billing» se borrará en «Local»')
    ui.answer(true)
    await settle()
    const [[, options]] = calls(invoke, 'backups:restore') as [[string, Record<string, unknown>]]
    expect(options).toMatchObject({
      backupPath: safety.path,
      connectionId: 'local',
      targetSchema: 'billing',
      replaceSchema: true,
      safetyBackup: true
    })
    expect(options.objects).toBeUndefined()
    expect(w.get('[data-test="restore-result-safety"]').text()).toContain(
      '20261006002000-previo-rollback.nb3'
    )
  })
})
