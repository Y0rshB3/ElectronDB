import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppContext } from '../context'
import { fileCreatedAt, listBackups } from './scan'
import { connectionFixture, connectionsOf } from './testing/fakeSession'

let root: string
let ctx: AppContext

const touch = (path: string, content = 'not a real tar'): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'electrondb-scan-'))
  const own = join(root, 'own')
  const navicat = join(root, 'navicat')
  touch(join(own, 'shop', '20260101090000.nb3'))
  touch(join(own, 'shop', '20260301090000-nightly.nb3'))
  touch(join(own, 'loose.nb3'))
  touch(join(own, 'shop', 'notes.txt'))
  touch(join(own, 'shop', '.hidden.nb3'))
  touch(join(navicat, 'shop', '20260317145120 antes de migrar.nb3'))
  touch(join(navicat, 'billing', '20260201000000-staging.nb3'))
  touch(join(navicat, 'id_cache.db'))
  const old = new Date(2020, 0, 1)
  utimesSync(join(own, 'loose.nb3'), old, old)
  ctx = {
    connections: connectionsOf(
      connectionFixture({ backupDir: own, extraBackupDirs: [navicat, join(root, 'missing')] })
    )
  } as unknown as AppContext
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('listBackups', () => {
  it('lists own and Navicat files newest first without opening them', async () => {
    const files = await listBackups(ctx, 'conn-1')
    expect(files.map((f) => [f.fileName, f.schema, f.source, f.label])).toEqual([
      ['20260317145120 antes de migrar.nb3', 'shop', 'navicat', 'antes de migrar'],
      ['20260301090000-nightly.nb3', 'shop', 'electrondb', 'nightly'],
      ['20260201000000-staging.nb3', 'billing', 'navicat', 'staging'],
      ['20260101090000.nb3', 'shop', 'electrondb', null],
      ['loose.nb3', null, 'electrondb', null]
    ])
    expect(files[0].connectionId).toBe('conn-1')
    expect(files[0].sizeBytes).toBe('not a real tar'.length)
    expect(files[0].createdAt).toBe(new Date(2026, 2, 17, 14, 51, 20).toISOString())
  })

  it('attaches the automation run that wrote a file (matched by path in the run history)', async () => {
    const own = join(root, 'own')
    const runs = [
      {
        id: 'r1',
        jobId: 'j1',
        jobName: 'Nightly (old name)',
        status: 'success',
        trigger: 'schedule',
        startedAt: '2026-03-01T09:00:00.000Z',
        finishedAt: null,
        logPath: '',
        tasks: [
          {
            taskId: 'b1',
            referenceName: 'Backup shop',
            status: 'success',
            startedAt: null,
            finishedAt: null,
            message: null,
            // Spelled differently from the scan: normalised before matching.
            outputPath: join(own, 'shop', '..', 'shop', '20260301090000-nightly.nb3'),
            type: 'backupschema',
            includeData: false
          }
        ]
      },
      {
        // A rollback's outputs are safety copies, never job backups.
        id: 'rb',
        jobId: 'j1',
        jobName: 'x',
        kind: 'rollback',
        status: 'success',
        trigger: 'manual',
        startedAt: '2026-03-02T09:00:00.000Z',
        finishedAt: null,
        logPath: '',
        tasks: [
          {
            taskId: 't',
            referenceName: 'x',
            status: 'success',
            startedAt: null,
            finishedAt: null,
            message: null,
            outputPath: join(own, 'shop', '20260101090000.nb3'),
            type: 'restoreschema'
          }
        ]
      }
    ]
    const withRuns = {
      ...ctx,
      runs: { list: () => runs },
      jobs: { get: (id: string) => (id === 'j1' ? { id, name: 'Nightly', tasks: [] } : null) }
    } as unknown as AppContext
    const files = await listBackups(withRuns, 'conn-1', 'shop')
    const byName = new Map(files.map((f) => [f.fileName, f.run]))
    expect(byName.get('20260301090000-nightly.nb3')).toEqual({
      runId: 'r1',
      jobId: 'j1',
      jobName: 'Nightly',
      startedAt: '2026-03-01T09:00:00.000Z',
      taskId: 'b1',
      includeData: false
    })
    expect(byName.get('20260101090000.nb3')).toBeNull()
  })

  it('filters by schema (loose files have no schema)', async () => {
    const files = await listBackups(ctx, 'conn-1', 'billing')
    expect(files.map((f) => f.fileName)).toEqual(['20260201000000-staging.nb3'])
  })

  it('labels files as navicat when backupDir is also one of the extraBackupDirs', async () => {
    const navicat = join(root, 'navicat')
    const shared = {
      connections: connectionsOf(
        connectionFixture({ backupDir: navicat, extraBackupDirs: [navicat] })
      )
    } as unknown as AppContext
    const files = await listBackups(shared, 'conn-1')
    expect(files).toHaveLength(2)
    expect(files.every((f) => f.source === 'navicat')).toBe(true)
  })

  it('labels files as navicat when an extra dir is nested inside backupDir', async () => {
    const nested = {
      connections: connectionsOf(
        connectionFixture({ backupDir: root, extraBackupDirs: [join(root, 'navicat')] })
      )
    } as unknown as AppContext
    const files = await listBackups(nested, 'conn-1')
    const byName = new Map(files.map((f) => [f.fileName, f.source]))
    expect(byName.get('20260201000000-staging.nb3')).toBe('navicat')
  })

  it('throws for unknown connections', async () => {
    await expect(listBackups(ctx, 'nope')).rejects.toThrow(/Conexión no encontrada/)
  })
})

describe('fileCreatedAt', () => {
  const at = (iso: string): Date => new Date(iso)
  const stat = (birth: string | null, mtime: string) => ({
    birthtime: birth ? at(birth) : new Date(0),
    birthtimeMs: birth ? at(birth).getTime() : 0,
    mtime: at(mtime),
    mtimeMs: at(mtime).getTime()
  })

  it('uses birthtime when it is plausible', () => {
    expect(fileCreatedAt(stat('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'))).toEqual(
      at('2026-01-01T00:00:00Z')
    )
  })

  it('falls back to mtime for copies with preserved times (Linux) or no birthtime', () => {
    expect(fileCreatedAt(stat('2026-03-01T00:00:00Z', '2020-01-01T00:00:00Z'))).toEqual(
      at('2020-01-01T00:00:00Z')
    )
    expect(fileCreatedAt(stat(null, '2020-01-01T00:00:00Z'))).toEqual(at('2020-01-01T00:00:00Z'))
  })
})

describe('listBackups ordering on a timestamp tie', () => {
  it('two files of the same second: the one written last comes first (not the label name)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'electrondb-scan-tie-'))
    try {
      const own = join(dir, 'own')
      touch(join(own, 'shop', '20260401000000-struct.nb3'))
      touch(join(own, 'shop', '20260401000000-manual.nb3'))
      utimesSync(
        join(own, 'shop', '20260401000000-struct.nb3'),
        new Date(2026, 3, 1),
        new Date(2026, 3, 1)
      )
      utimesSync(
        join(own, 'shop', '20260401000000-manual.nb3'),
        new Date(2026, 3, 2),
        new Date(2026, 3, 2)
      )
      const tieCtx = {
        connections: connectionsOf(connectionFixture({ backupDir: own, extraBackupDirs: [] }))
      } as unknown as AppContext
      const files = await listBackups(tieCtx, 'conn-1', 'shop')
      expect(files.map((f) => f.fileName)).toEqual([
        '20260401000000-manual.nb3',
        '20260401000000-struct.nb3'
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
