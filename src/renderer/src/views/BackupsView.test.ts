import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackupFile, RollbackPlan } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useTabsStore } from '@renderer/stores/tabs'
import { useUiStore } from '@renderer/stores/ui'
import BackupsView from './BackupsView.vue'
import {
  calls,
  freshPinia,
  makeBackup,
  makeConnection,
  mockVortaq,
  mountWith,
  settle
} from '@renderer/components/dialogs/testing'

const navicatFile = makeBackup({
  path: '/nav/billing/20260317145120-staging.nb3',
  source: 'navicat',
  label: 'staging'
})
const vortaqFile = makeBackup({
  path: '/nd/billing/20260401100000-manual.nb3',
  source: 'electrondb',
  createdAt: '2026-04-01T10:00:00.000Z'
})

describe('BackupsView', () => {
  let wrapper: ReturnType<typeof mountWith> | null = null

  beforeEach(() => {
    mockVortaq({
      'backups:list': () => [navicatFile, vortaqFile],
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

  it('«Exportar a .sql…» opens the backup dialog on the .sql format', async () => {
    const w = await mountView()
    await w.get('[data-test="backups-export-sql"]').trigger('click')
    expect(useUiStore().backupDialog).toMatchObject({
      open: true,
      connectionId: 'c1',
      format: 'sql'
    })
    await w.get('[data-test="backups-new"]').trigger('click')
    expect(useUiStore().backupDialog.format).toBe('nb3')
  })

  it('disables Eliminar for Navicat backups and enables it for Vortaq ones', async () => {
    const w = await mountView()
    expect(w.findAll('tbody tr')).toHaveLength(2)

    await rowFor(w, navicatFile.fileName).trigger('click')
    await settle()
    expect(w.get('[data-test="backups-delete"]').attributes('disabled')).toBeDefined()

    await rowFor(w, vortaqFile.fileName).trigger('click')
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

/** Local-time ISO (package titles are in local time). */
const at = (h: number, mi: number): string => new Date(2026, 9, 5, h, mi).toISOString()

/** A Navicat batch: three copies labelled backup-staging a minute apart, plus a lone file. */
const navicatBatch: BackupFile[] = ['auth', 'billing', 'venue'].map((schema, i) =>
  makeBackup({
    path: `/nav/${schema}/2026100523${16 + i}00-backup-staging.nb3`,
    schema,
    source: 'navicat',
    label: 'backup-staging',
    createdAt: at(23, 16 + i)
  })
)
const lone = makeBackup({
  path: '/nd/auth/20260401100000-manual.nb3',
  schema: 'auth',
  createdAt: '2026-04-01T10:00:00.000Z'
})
const runStart = at(3, 0)
/** Two copies written by one automation run. */
const runFiles: BackupFile[] = ['auth', 'crm'].map((schema, i) =>
  makeBackup({
    path: `/nd/${schema}/20261005030${i}00-nightly.nb3`,
    schema,
    label: 'nightly',
    createdAt: at(3, i),
    run: {
      runId: 'r1',
      jobId: 'job-1',
      jobName: 'Backup staging',
      startedAt: runStart,
      taskId: `b${i + 1}`,
      includeData: true
    }
  })
)

function planOf(source: unknown, target: unknown): RollbackPlan {
  const paths =
    typeof source === 'string'
      ? runFiles.map((f) => f.path)
      : (source as { backupPaths: string[] }).backupPaths
  return {
    source: typeof source === 'string' ? 'run' : 'files',
    runId: typeof source === 'string' ? source : '',
    jobId: 'manual-rollbacks',
    jobName: typeof source === 'string' ? 'Backup staging' : 'backup-staging · 2026-10-05 23:16',
    runStartedAt: runStart,
    targetConnectionId: target as string,
    targetError: null,
    items: paths.map((path, i) => ({
      taskId: typeof source === 'string' ? `b${i + 1}` : path,
      referenceName: path,
      sourceConnectionId: 'c1',
      sourceConnectionName: 'Staging',
      schema: path.split('/')[2],
      targetSchema: path.split('/')[2],
      backupPath: path,
      sizeBytes: 10,
      targetExists: i === 0,
      problem: null,
      objects: 1,
      rows: 1,
      structureOnly: false,
      warning: null
    }))
  }
}

describe('BackupsView packages', () => {
  let wrapper: ReturnType<typeof mountWith> | null = null
  let invoke: ReturnType<typeof mockVortaq>

  function mockList(list: BackupFile[]) {
    invoke = mockVortaq({
      'backups:list': () => list,
      'jobs:rollbackPlan': planOf
    })
  }

  beforeEach(() => {
    localStorage.clear()
    mockList([...navicatBatch, lone, ...runFiles])
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

  const fileRows = (w: NonNullable<typeof wrapper>) =>
    w.findAll('[data-test="backup-row"]').map((r) => r.text())

  it('groups by package by default: collapsed headers with title and count, single files as rows', async () => {
    const w = await mountView()
    const headers = w.findAll('[data-test="backup-package"]')
    expect(headers.map((h) => h.get('[data-test="backup-package-title"]').text())).toEqual([
      'backup-staging · 2026-10-05 23:16',
      'Backup staging · 2026-10-05 03:00'
    ])
    expect(headers[0].get('[data-test="backup-package-count"]').text()).toMatch(/^3 copias/)
    // Packages start collapsed; the lone copy is a plain row.
    expect(fileRows(w)).toHaveLength(1)
    expect(fileRows(w)[0]).toContain(lone.fileName)
    await headers[0].get('[data-test="backup-package-toggle"]').trigger('click')
    await settle()
    expect(fileRows(w)).toHaveLength(4)
    expect(w.get('[data-test="backups-restore-package"]').attributes('disabled')).toBeDefined()
  })

  it('clicking a Navicat package header selects it and opens the file-based dialog with every database checked', async () => {
    const w = await mountView()
    await w.findAll('[data-test="backup-package"]')[0].trigger('click')
    await settle()
    expect(w.get('[data-test="backups-package-count"]').text()).toBe('3')
    const button = w.get('[data-test="backups-restore-package"]')
    expect(button.attributes('disabled')).toBeUndefined()
    await button.trigger('click')
    await settle()
    expect(calls(invoke, 'jobs:rollbackPlan')).toEqual([
      [
        {
          source: 'files',
          backupPaths: navicatBatch.map((f) => f.path),
          sourceConnectionId: 'c1',
          title: 'backup-staging · 2026-10-05 23:16'
        },
        'loc'
      ]
    ])
    const dialog = w.get('[data-test="rollback-dialog"]')
    expect(dialog.text()).toContain('Restaurar paquete en Local')
    const checks = dialog.findAll('[data-test="rollback-item-check"] input')
    expect(checks).toHaveLength(3)
    for (const c of checks) expect((c.element as HTMLInputElement).checked).toBe(true)
    // Clicking the header again clears the package.
    await w.findAll('[data-test="backup-package"]')[0].trigger('click')
    await settle()
    expect(w.find('[data-test="backups-package-count"]').exists()).toBe(false)
  })

  it('files of one run reuse the run rollback, pre-checking only the checked copies', async () => {
    const w = await mountView()
    const runHeader = w.findAll('[data-test="backup-package"]')[1]
    await runHeader.get('[data-test="backup-package-toggle"]').trigger('click')
    await settle()
    const row = w
      .findAll('[data-test="backup-row"]')
      .find((r) => r.text().includes(runFiles[0].fileName))!
    await row.get('input[type="checkbox"]').trigger('click')
    await settle()
    expect(w.get('[data-test="backups-package-count"]').text()).toBe('1')
    await w.get('[data-test="backups-restore-package"]').trigger('click')
    await settle()
    expect(calls(invoke, 'jobs:rollbackPlan')).toEqual([['r1', 'loc']])
    const checks = w.findAll('[data-test="rollback-item-check"] input')
    expect(checks.map((c) => (c.element as HTMLInputElement).checked)).toEqual([true, false])
    expect(w.get('[data-test="rollback-dialog"]').text()).toContain('Restaurar todo en Local')
  })

  it('the selected row of a package restores its whole package; the toggle is remembered', async () => {
    const w = await mountView()
    await w
      .findAll('[data-test="backup-package"]')[0]
      .get('[data-test="backup-package-toggle"]')
      .trigger('click')
    await settle()
    const row = w
      .findAll('[data-test="backup-row"]')
      .find((r) => r.text().includes(navicatBatch[1].fileName))!
    await row.trigger('click')
    await settle()
    expect(w.get('[data-test="backups-package-count"]').text()).toBe('3')

    await w.get('[data-test="backups-group-toggle"] input').setValue(false)
    await settle()
    expect(localStorage.getItem('electrondb.backups.groupByPackage')).toBe('0')
    expect(w.find('[data-test="backup-package"]').exists()).toBe(false)
    expect(fileRows(w)).toHaveLength(6)
  })

  it('starts ungrouped when the user turned grouping off', async () => {
    localStorage.setItem('electrondb.backups.groupByPackage', '0')
    const w = await mountView()
    expect(w.find('[data-test="backup-package"]').exists()).toBe(false)
    expect(fileRows(w)).toHaveLength(6)
  })
})
