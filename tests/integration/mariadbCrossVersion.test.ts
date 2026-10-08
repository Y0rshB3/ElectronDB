/**
 * System-versioned history between MariaDB versions with different TIMESTAMP ranges: 11.5+
 * ends current rows in 2106, earlier versions in 2038. Optional: runs only with both
 * VORTAQ_TEST_MARIADB_URL (11.8, compose `mariadb11`) and VORTAQ_TEST_MARIADB_OLD_URL (a
 * throwaway 10.11 or 11.4, e.g. `docker run -e MARIADB_ROOT_PASSWORD=navidog
 * -p 127.0.0.1:33310:3306 mariadb:10.11`).
 *
 * - a .vqb restored on the other side keeps current rows current (not clipped, not history);
 * - a .sql dump writes current rows without their end column, so they import on either.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { AppContext } from '@main/context'
import { envVar } from '@main/env'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { ConnectionManager, getConnectionManager, getSessionFactory } from '@main/db/manager'
import { createBackupService, type BackupService } from '@main/backup/index'
import { importSqlDump } from '@main/importers/sql/execute'

const NEW_URL = envVar('TEST_MARIADB_URL')?.trim()
const OLD_URL = envVar('TEST_MARIADB_OLD_URL')?.trim()
const DB = `vq_xver_${process.pid}`

describe.skipIf(!NEW_URL || !OLD_URL)('MariaDB versioned history across TIMESTAMP ranges', () => {
  let dir: string
  let ctx: AppContext
  let manager: ConnectionManager
  let service: BackupService
  const ids = { old: '', new: '' }

  const q = async (id: string, sql: string): Promise<Record<string, unknown>[]> => {
    const s = await manager.acquire(id)
    try {
      return await s.query(sql)
    } finally {
      await s.release()
    }
  }
  const run = async (id: string, statements: string[]): Promise<void> => {
    const s = await manager.acquire(id)
    try {
      for (const sql of statements) await s.execute(sql)
    } finally {
      await s.release()
    }
  }
  /** Current rows, and how many row versions there are. */
  const state = async (id: string, db: string): Promise<[string[], number]> => [
    (await q(id, `SELECT id, v FROM \`${db}\`.h ORDER BY id`)).map((r) => `${r.id}:${r.v}`),
    Number((await q(id, `SELECT COUNT(*) AS n FROM \`${db}\`.h FOR SYSTEM_TIME ALL`))[0].n)
  ]
  const seed = (id: string): Promise<void> =>
    run(id, [
      `DROP DATABASE IF EXISTS \`${DB}\``,
      `CREATE DATABASE \`${DB}\``,
      `CREATE TABLE \`${DB}\`.h (id INT PRIMARY KEY, v INT) WITH SYSTEM VERSIONING`,
      `INSERT INTO \`${DB}\`.h VALUES (1, 1), (2, 2), (3, 3)`,
      `UPDATE \`${DB}\`.h SET v = 10 WHERE id = 1`,
      `DELETE FROM \`${DB}\`.h WHERE id = 3`
    ])
  const EXPECTED: [string[], number] = [['1:10', '2:2'], 4]

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-maria-xver-'))
    ctx = {
      userDataPath: dir,
      logDir: join(dir, 'logs'),
      connections: new ConnectionsRepo(dir),
      jobs: new JobsRepo(dir),
      runs: new RunsRepo(dir),
      settings: new SettingsRepo(dir, dir),
      credentials: new CredentialStore(dir, plainCodec, 'plain'),
      emit: <E extends IpcEventChannel>(_c: E, _p: IpcEventMap[E]) => {},
      headless: true
    }
    for (const [key, raw] of [
      ['old', OLD_URL!],
      ['new', NEW_URL!]
    ] as const) {
      const u = new URL(raw)
      ids[key] = ctx.connections.save({
        name: `MariaDB ${key}`,
        engine: 'mariadb',
        color: null,
        environment: 'local',
        host: u.hostname,
        port: Number(u.port || 3306),
        username: decodeURIComponent(u.username),
        savePassword: true,
        customDatabases: [],
        initialQueries: '',
        ssh: {
          enabled: false,
          host: '',
          port: 22,
          username: '',
          authType: 'password',
          savePassword: false
        },
        ssl: { enabled: false, verifyServer: false },
        backupDir: join(dir, 'backups'),
        extraBackupDirs: []
      }).id
      ctx.credentials.set('mysql', ids[key], decodeURIComponent(u.password))
    }
    manager = getConnectionManager(ctx)
    service = createBackupService(ctx, getSessionFactory(ctx))
  }, 60_000)

  afterAll(async () => {
    for (const id of Object.values(ids))
      for (const db of [DB, `${DB}_copia`])
        await q(id, `DROP DATABASE IF EXISTS \`${db}\``).catch(() => undefined)
    await manager.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  for (const [from, to] of [
    ['new', 'old'],
    ['old', 'new']
  ] as const) {
    it(`restores a .vqb from the ${from} server on the ${to} one`, async () => {
      await seed(ids[from])
      const backup = await service.create({
        connectionId: ids[from],
        schema: DB,
        includeData: true,
        format: 'vqb'
      })
      const result = await service.replace({
        backupPath: backup.path,
        expectedSchema: DB,
        connectionId: ids[to],
        targetSchema: `${DB}_copia`,
        safetyBackup: false,
        continueOnError: false
      })
      expect(result.restore.errors).toEqual([])
      expect(await state(ids[to], `${DB}_copia`)).toEqual(EXPECTED)
    }, 60_000)

    it(`imports a .sql from the ${from} server on the ${to} one`, async () => {
      await seed(ids[from])
      const dump = await service.exportSql({
        connectionId: ids[from],
        schema: DB,
        includeStructure: true,
        includeData: true,
        includeCreateDatabase: false
      })
      await q(ids[to], `DROP DATABASE IF EXISTS \`${DB}_copia\``)
      const result = await importSqlDump(
        { connections: ctx.connections, sessions: getSessionFactory(ctx), backups: service },
        {
          path: dump.path,
          connectionId: ids[to],
          mode: 'intoSchema',
          targetSchema: `${DB}_copia`,
          createSchema: true,
          replaceSchema: false,
          safetyBackup: false,
          continueOnError: false
        }
      )
      expect(result.errors).toEqual([])
      expect(await state(ids[to], `${DB}_copia`)).toEqual(EXPECTED)
    }, 60_000)
  }
})
