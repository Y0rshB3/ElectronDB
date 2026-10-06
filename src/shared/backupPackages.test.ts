import { describe, expect, it } from 'vitest'
import type { BackupFile, BackupRunRef } from './types'
import { NO_LABEL, groupBackupPackages, packageDate, packageRestoreSource } from './backupPackages'

/** Local-time ISO string (titles are in local time, whatever the test machine's zone). */
const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0): string =>
  new Date(y, mo - 1, d, h, mi, s).toISOString()

let n = 0
function file(
  schema: string | null,
  createdAt: string,
  extra: Partial<BackupFile> = {}
): BackupFile {
  n++
  return {
    path: `/b/${schema ?? 'root'}/${n}-${extra.label ?? 'x'}.nb3`,
    fileName: `${n}.nb3`,
    connectionId: 'c1',
    schema,
    sizeBytes: 100,
    createdAt,
    modifiedAt: createdAt,
    source: 'navicat',
    label: null,
    ...extra
  }
}

const run = (runId: string, taskId: string, startedAt: string): BackupRunRef => ({
  runId,
  jobId: 'job-1',
  jobName: 'Backup staging',
  startedAt,
  taskId,
  includeData: true
})

describe('groupBackupPackages', () => {
  it('groups the files of one automation run, titled with the job and run date', () => {
    const start = at(2026, 10, 5, 23, 16)
    const files = [
      file('auth', at(2026, 10, 5, 23, 16), { run: run('r1', 'b1', start), label: 'staging' }),
      file('crm', at(2026, 10, 5, 23, 40), { run: run('r1', 'b2', start), label: 'staging' }),
      file('venue', at(2026, 10, 6, 1, 0), { run: run('r1', 'b3', start), label: 'staging' })
    ]
    const { packages, byPath } = groupBackupPackages(files)
    expect(packages).toHaveLength(1)
    expect(packages[0]).toMatchObject({
      id: 'run:r1',
      kind: 'run',
      title: 'Backup staging · 2026-10-05 23:16',
      runId: 'r1',
      jobId: 'job-1',
      sizeBytes: 300
    })
    // Run packages ignore the time gap: the run decides.
    expect(packages[0].files.map((f) => f.schema)).toEqual(['auth', 'crm', 'venue'])
    for (const f of files) expect(byPath.get(f.path)?.id).toBe('run:r1')
  })

  it('falls back to label + consecutive timestamps within 10 minutes', () => {
    const files = [
      file('auth', at(2026, 10, 5, 23, 16), { label: 'backup-staging' }),
      file('billing', at(2026, 10, 5, 23, 17), { label: 'backup-staging' }),
      file('venue', at(2026, 10, 5, 23, 20), { label: 'backup-staging' }),
      // 11 minutes after the previous one: a new batch.
      file('auth', at(2026, 10, 5, 23, 31), { label: 'backup-staging' }),
      file('crm', at(2026, 10, 5, 23, 35), { label: 'backup-staging' }),
      // Other label at the same time: separate.
      file('crm', at(2026, 10, 5, 23, 18), { label: 'prod' })
    ]
    const { packages, byPath } = groupBackupPackages(files)
    expect(packages.map((p) => [p.title, p.files.length])).toEqual([
      ['backup-staging · 2026-10-05 23:31', 2],
      ['backup-staging · 2026-10-05 23:16', 3]
    ])
    expect(packages.every((p) => p.kind === 'label' && p.runId === null)).toBe(true)
    // The lone «prod» copy stays a plain file.
    expect(byPath.has(files[5].path)).toBe(false)
  })

  it('leaves single files as plain files', () => {
    const files = [
      file('auth', at(2026, 10, 5, 23, 16), { label: 'a' }),
      file('crm', at(2026, 10, 5, 23, 17), { label: 'b' }),
      file('venue', at(2026, 10, 5, 23, 18), { run: run('r9', 'b1', at(2026, 10, 5, 23, 18)) })
    ]
    const { packages, byPath } = groupBackupPackages(files)
    expect(packages).toEqual([])
    expect(byPath.size).toBe(0)
  })

  it('files without label form «Sin etiqueta» packages per connection', () => {
    const files = [
      file('auth', at(2026, 3, 1, 10, 0)),
      file('crm', at(2026, 3, 1, 10, 5)),
      file('venue', at(2026, 3, 1, 10, 6), { connectionId: 'c2' })
    ]
    const { packages } = groupBackupPackages(files)
    expect(packages).toHaveLength(1)
    expect(packages[0].title).toBe(`${NO_LABEL} · 2026-03-01 10:00`)
    expect(packages[0].files.map((f) => f.schema)).toEqual(['auth', 'crm'])
  })

  it('a database copied again starts a new package (one copy per database)', () => {
    const files = [
      file('auth', at(2026, 3, 1, 10, 0), { label: 'manual' }),
      file('auth', at(2026, 3, 1, 10, 2), { label: 'manual' }),
      file('crm', at(2026, 3, 1, 10, 3), { label: 'manual' })
    ]
    const { packages, byPath } = groupBackupPackages(files)
    expect(packages).toHaveLength(1)
    expect(packages[0].files.map((f) => f.path)).toEqual([files[1].path, files[2].path])
    expect(byPath.has(files[0].path)).toBe(false)
  })

  it('two runs with the same label stay two packages, newest first', () => {
    const r1 = at(2026, 10, 4, 23, 16)
    const r2 = at(2026, 10, 5, 23, 16)
    const files = [
      file('auth', at(2026, 10, 4, 23, 16), { label: 'backup-staging', run: run('r1', 'b1', r1) }),
      file('crm', at(2026, 10, 4, 23, 17), { label: 'backup-staging', run: run('r1', 'b2', r1) }),
      file('auth', at(2026, 10, 5, 23, 16), { label: 'backup-staging', run: run('r2', 'b1', r2) }),
      file('crm', at(2026, 10, 5, 23, 17), { label: 'backup-staging', run: run('r2', 'b2', r2) })
    ]
    const { packages } = groupBackupPackages(files)
    expect(packages.map((p) => p.id)).toEqual(['run:r2', 'run:r1'])
    expect(packages.map((p) => p.title)).toEqual([
      'Backup staging · 2026-10-05 23:16',
      'Backup staging · 2026-10-04 23:16'
    ])
  })

  it('formats package dates in local time', () => {
    expect(packageDate(at(2026, 1, 2, 3, 4, 59))).toBe('2026-01-02 03:04')
    expect(packageDate('nope')).toBe('nope')
  })
})

describe('packageRestoreSource', () => {
  const start = at(2026, 10, 5, 23, 16)
  const runFiles = [
    file('auth', start, { run: run('r1', 'b1', start) }),
    file('crm', start, { run: run('r1', 'b2', start) })
  ]

  it('one run (all or part of it) reuses the run rollback with its steps', () => {
    expect(packageRestoreSource(runFiles)).toEqual({
      kind: 'run',
      runId: 'r1',
      jobName: 'Backup staging',
      taskIds: ['b1', 'b2']
    })
    expect(packageRestoreSource([runFiles[1]])).toMatchObject({ kind: 'run', taskIds: ['b2'] })
  })

  it('anything else is file-based, titled with the package when it is whole', () => {
    const navicat = [
      file('auth', at(2026, 10, 5, 23, 16), { label: 'backup-staging' }),
      file('crm', at(2026, 10, 5, 23, 18), { label: 'backup-staging' })
    ]
    const packages = groupBackupPackages(navicat)
    expect(packageRestoreSource(navicat, packages)).toEqual({
      kind: 'files',
      backupPaths: navicat.map((f) => f.path),
      title: 'backup-staging · 2026-10-05 23:16'
    })
    expect(packageRestoreSource([navicat[0], runFiles[0]], packages)).toMatchObject({
      kind: 'files',
      title: '2 copias seleccionadas'
    })
    expect(packageRestoreSource([])).toBeNull()
  })
})
