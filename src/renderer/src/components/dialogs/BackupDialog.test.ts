import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mock } from 'vitest'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useUiStore } from '@renderer/stores/ui'
import BackupDialog from './BackupDialog.vue'
import { calls, freshPinia, makeConnection, mockVortaq, mountWith, settle } from './testing'

describe('BackupDialog formats', () => {
  let invoke: Mock
  let wrapper: ReturnType<typeof mountWith> | null = null

  beforeEach(() => {
    invoke = mockVortaq({
      'db:databases': () => [{ name: 'billing' }],
      'db:tables': () => [{ name: 'account' }],
      'db:views': () => [],
      'backups:create': () => ({
        path: '/b/billing/20261005101112.nb3',
        sizeBytes: 10,
        objects: 1,
        rows: 3,
        durationMs: 5
      }),
      'backups:exportSql': () => ({
        path: '/b/billing/20261005101112.sql.gz',
        sizeBytes: 10,
        objects: 1,
        rows: 3,
        durationMs: 5
      })
    })
  })
  afterEach(() => wrapper?.unmount())

  async function mountFor(format?: 'nb3' | 'sql') {
    const pinia = freshPinia()
    useConnectionsStore().items = [makeConnection({ id: 'c1', name: 'Local' })]
    useUiStore().openBackupDialog('c1', 'billing', format ? { format } : {})
    wrapper = mountWith(BackupDialog, pinia)
    await settle()
    return wrapper
  }

  it('keeps .nb3 by default and creates a backup', async () => {
    const w = await mountFor()
    expect(w.find('[data-test="backup-create-database"]').exists()).toBe(false)
    await w.get('[data-test="backup-start"]').trigger('click')
    await settle()
    expect(calls(invoke, 'backups:create')).toHaveLength(1)
    expect(calls(invoke, 'backups:exportSql')).toHaveLength(0)
  })

  it('«Exportar a .sql…» opens on .sql and sends the export options', async () => {
    const w = await mountFor('sql')
    expect(w.text()).toContain('Exportar a .sql')
    await w.get('[data-test="backup-create-database"] input').setValue(true)
    await w.get('[data-test="backup-gzip"] input').setValue(true)
    await w.get('[data-test="backup-start"]').trigger('click')
    await settle()
    const [[opId, options]] = calls(invoke, 'backups:exportSql') as [[string, unknown]]
    expect(opId).toMatch(/^backup-/)
    expect(options).toMatchObject({
      connectionId: 'c1',
      schema: 'billing',
      includeStructure: true,
      includeData: true,
      includeCreateDatabase: true,
      gzip: true
    })
    expect(calls(invoke, 'backups:create')).toHaveLength(0)
    expect(w.get('[data-test="backup-result"]').text()).toContain('.sql.gz')
  })

  it('needs structure or data for a .sql export', async () => {
    const w = await mountFor('sql')
    await w.get('[data-test="backup-include-structure"] input').setValue(false)
    await w.get('[data-test="backup-include-data"] input').setValue(false)
    expect(w.find('[data-test="backup-nothing"]').exists()).toBe(true)
    expect(w.get('[data-test="backup-start"]').attributes('disabled')).toBeDefined()
  })
})
