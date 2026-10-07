import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppContext } from '../context'
import { DbUserError } from '../db/errors'
import { createBackup } from './create'
import { createBackupService } from './index'
import { restoreBackup } from './restore'
import { FakeSessionFactory, connectionFixture, connectionsOf } from './testing/fakeSession'

// .nb3 backups stay MySQL-only (docs/multi-engine-design.md, section 11); PostgreSQL has .vqb only.
describe('backup capability gates', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-backup-gate-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const pg = (): ReturnType<typeof connectionFixture> =>
    connectionFixture({ id: 'pg-1', name: 'PG local', engine: 'postgresql', backupDir: dir })

  it('refuses to create a backup of a PostgreSQL connection before opening a session', async () => {
    const sessions = new FakeSessionFactory()
    const err = await createBackup(
      { connections: connectionsOf(pg()), sessions },
      { connectionId: 'pg-1', schema: 'public', includeData: true }
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DbUserError)
    expect((err as Error).message).toBe(
      'Las copias de seguridad .nb3 solo están disponibles para conexiones MySQL; «PG local» es PostgreSQL.'
    )
    expect(sessions.sessions).toHaveLength(0)
  })

  it('refuses to restore into a PostgreSQL connection before reading the file', async () => {
    const sessions = new FakeSessionFactory()
    const err = await restoreBackup(
      { connections: connectionsOf(pg()), sessions },
      {
        backupPath: join(dir, 'does-not-exist.nb3'),
        connectionId: 'pg-1',
        targetSchema: 'public',
        createSchema: false,
        dropObjectsFirst: false,
        includeStructure: true,
        includeData: true,
        continueOnError: false
      }
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DbUserError)
    expect((err as Error).message).toMatch(/solo están disponibles para conexiones MySQL/)
    expect(sessions.sessions).toHaveLength(0)
  })

  it("lists only .vqb backups for a PostgreSQL connection, never its folder's .nb3 files", async () => {
    mkdirSync(join(dir, 'public'))
    writeFileSync(join(dir, 'public', '20240101000000.nb3'), 'x')
    writeFileSync(join(dir, 'public', '20240102000000.vqb'), 'x')
    const mysql = connectionFixture({ id: 'my-1', backupDir: dir })
    const ctx = {
      userDataPath: dir,
      connections: connectionsOf(pg(), mysql)
    } as unknown as AppContext
    const service = createBackupService(ctx, new FakeSessionFactory())
    expect((await service.list('pg-1', null)).map((f) => f.fileName)).toEqual([
      '20240102000000.vqb'
    ])
    // MySQL lists both formats
    expect((await service.list('my-1', null)).map((f) => f.fileName)).toEqual([
      '20240102000000.vqb',
      '20240101000000.nb3'
    ])
  })
})
