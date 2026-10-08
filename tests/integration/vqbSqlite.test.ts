/**
 * .vqb backups of SQLite (P3) on real database files in a temp folder:
 * backup → restore into a new file (identical rows and storage classes,
 * sqlite_sequence, indexes, views and triggers), encrypted copies, REPLACE
 * with a VACUUM INTO safety copy, and the refusals (open transaction in a
 * query tab, production without confirmation).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionInput, QueryStatementResult } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import { defaultSqliteOptions } from '@shared/engines'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { ConnectionManager } from '@main/db/manager'
import { createSqliteDbHandlers, type SqliteDbHandlers } from '@main/ipc/dbSqlite'
import { createSqliteDriver, createSqliteFile } from '@main/sqlite/driver'
import { inProcessSpawner } from '@main/sqlite/spawner'
import { isSqliteConnection } from '@main/sqlite/connection'
import { createBackupService, type BackupService } from '@main/backup/index'
import { createBackupHandlers, replaceRestore } from '@main/backup/handlers'
import { SQLITE_TX_OPEN_MESSAGE } from '@main/backup/vqb/sqliteBackup'

const CHEAP = { N: 1024, r: 8, p: 1 }

function input(filePath: string, overrides: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    name: 'VQB SQLite',
    color: null,
    environment: 'local',
    host: '',
    port: 0,
    username: '',
    authMode: 'none',
    savePassword: false,
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
    backupDir: '',
    extraBackupDirs: [],
    engine: 'sqlite',
    sqlite: { ...defaultSqliteOptions(false), filePath, foreignKeys: true },
    ...overrides
  }
}

const ok = (results: QueryStatementResult[]): QueryStatementResult[] => {
  const failed = results.find((r) => r.error)
  if (failed) throw new Error(`${failed.sql}: ${failed.error}`)
  return results
}

const DUMP = `SELECT 'author' AS t, id, typeof(name), name FROM author
  UNION ALL SELECT 'cell', id, typeof(v), quote(v) FROM cell
  UNION ALL SELECT 'seq', 0, name, seq FROM sqlite_sequence
  ORDER BY 1, 2`
const SCHEMA = `SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`

describe('.vqb backups of SQLite (integration, real files)', () => {
  let dir: string
  let ctx: AppContext
  let manager: ConnectionManager
  let lite: SqliteDbHandlers
  let service: BackupService
  let id: string
  let mainPath: string
  const spawner = inProcessSpawner()

  const exec = (cid: string, sql: string, tab = 'tab', extra = {}) =>
    lite.execute(cid, sql, { sessionKey: tab, ...extra })

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-vqb-sqlite-'))
    const files = join(dir, 'files')
    mkdirSync(files)
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
    manager = new ConnectionManager(ctx, { drivers: async () => createSqliteDriver(() => spawner) })
    lite = createSqliteDbHandlers(ctx, manager)
    service = createBackupService(
      ctx,
      { acquire: () => Promise.reject(new Error('MySQL')) },
      {
        scrypt: CHEAP,
        sqliteSpawner: () => spawner,
        sqlite: {
          async connection(cid) {
            const c = await manager.connection(cid)
            if (!isSqliteConnection(c)) throw new Error('no SQLite')
            return c
          }
        }
      }
    )
    mainPath = join(files, 'app.db')
    await createSqliteFile(mainPath, spawner)
    id = ctx.connections.save(input(mainPath, { backupDir: join(dir, 'backups') })).id
    ok(
      await exec(
        id,
        `
        CREATE TABLE author (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
        CREATE TABLE cell (id INTEGER PRIMARY KEY, v, author_id INTEGER REFERENCES author(id));
        CREATE TABLE pair (a TEXT, b TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID;
        CREATE TABLE gen (x INTEGER, y INTEGER GENERATED ALWAYS AS (x * 2) STORED);
        CREATE INDEX ix_cell_v ON cell(v);
        CREATE VIEW v_cells AS SELECT c.id, c.v, a.name FROM cell c LEFT JOIN author a ON a.id = c.author_id;
        CREATE TRIGGER trg_author AFTER INSERT ON author BEGIN
          UPDATE author SET name = upper(name) WHERE id = NEW.id;
        END;
        CREATE TRIGGER trg_view INSTEAD OF INSERT ON v_cells BEGIN
          INSERT INTO cell (v) VALUES (NEW.v);
        END;
        INSERT INTO author (name) VALUES ('ana'), ('luis'), ('tmp');
        DELETE FROM author WHERE name = 'TMP';
        PRAGMA foreign_keys = OFF;
        INSERT INTO cell (id, v, author_id) VALUES
          (1, 9007199254740993, 1), (2, 1.0, 1), (3, -0.0, 2), (4, 2.5, NULL),
          (5, 'texto ñ €', 2), (6, x'00ff10', NULL), (7, NULL, NULL), (8, 42, 99);
        PRAGMA foreign_keys = ON;
        INSERT INTO pair VALUES ('x', '1'), ('y', '2');
        INSERT INTO gen (x) VALUES (3);
      `
      )
    )
  })

  afterAll(async () => {
    await manager.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  async function dump(cid: string): Promise<unknown[][]> {
    const [r] = ok(await exec(cid, DUMP))
    return r.resultSet!.rows
  }

  it('backs up and restores into a new file with identical rows and storage classes', async () => {
    const backup = await service.create({
      connectionId: id,
      schema: 'main',
      includeData: true,
      format: 'vqb'
    })
    expect(backup.path.endsWith('.vqb')).toBe(true)
    expect(backup.path).toContain(join('backups', 'main'))
    const meta = await service.readMeta(backup.path)
    expect(meta).toMatchObject({ engine: 'sqlite', databaseType: 'SQLITE', schema: 'main' })
    expect(meta.objects.map((o) => o.name)).toEqual(['author', 'cell', 'pair', 'gen', 'v_cells'])
    expect((await service.list(id)).map((f) => f.path)).toContain(backup.path)

    const target = join(dir, 'files', 'restored.db')
    const result = await service.restore({
      backupPath: backup.path,
      connectionId: '',
      targetSchema: 'main',
      createSchema: false,
      dropObjectsFirst: false,
      includeStructure: true,
      includeData: true,
      continueOnError: false,
      newFilePath: target,
      createConnection: true
    })
    expect(result.errors).toEqual([])
    expect(result.restoredFilePath).toBe(target)
    const restoredId = result.newConnectionId!
    expect(ctx.connections.get(restoredId)?.sqlite).toMatchObject({
      filePath: target,
      foreignKeys: true
    })
    expect(await dump(restoredId)).toEqual(await dump(id))
    const [schema] = ok(await exec(restoredId, SCHEMA))
    const [orig] = ok(await exec(id, SCHEMA))
    expect(schema.resultSet!.rows).toEqual(orig.resultSet!.rows)
    const [rows] = ok(
      await exec(restoredId, 'SELECT (SELECT y FROM gen), (SELECT count(*) FROM pair)')
    )
    expect(rows.resultSet!.rows).toEqual([[6, 2]])
    // Triggers came back and work (the counter continues after the deleted id 3).
    ok(await exec(restoredId, "INSERT INTO author (name) VALUES ('eva')"))
    const [eva] = ok(await exec(restoredId, "SELECT id, name FROM author WHERE name = 'EVA'"))
    expect(eva.resultSet!.rows).toEqual([[4, 'EVA']])
    await manager.close(restoredId)
  })

  it('round-trips an encrypted copy and refuses a missing or wrong password', async () => {
    const backup = await service.create({
      connectionId: id,
      schema: 'main',
      includeData: true,
      format: 'vqb',
      password: 'secreto-largo'
    })
    expect((await service.readMeta(backup.path)).locked).toBe(true)
    const target = join(dir, 'files', 'enc.db')
    const restore = {
      backupPath: backup.path,
      connectionId: '',
      targetSchema: 'main',
      createSchema: false,
      dropObjectsFirst: false,
      includeStructure: true,
      includeData: true,
      continueOnError: false,
      newFilePath: target
    }
    await expect(service.restore({ ...restore, password: 'otra-clave-x' })).rejects.toThrow()
    expect(existsSync(target)).toBe(false)
    const result = await service.restore({
      ...restore,
      password: 'secreto-largo',
      createConnection: true
    })
    expect(await dump(result.newConnectionId!)).toEqual(await dump(id))
    await manager.close(result.newConnectionId!)
  })

  it('replaces the database after a VACUUM INTO safety copy, in one transaction', async () => {
    const backup = await service.create({
      connectionId: id,
      schema: 'main',
      includeData: true,
      format: 'vqb'
    })
    const before = await dump(id)
    ok(await exec(id, "INSERT INTO author (name) VALUES ('extra'); CREATE TABLE junk (z)"))
    const handlers = createBackupHandlers(ctx, async () => service)
    expect(handlers).toBeTruthy()
    const result = await replaceRestore(
      service,
      {
        backupPath: backup.path,
        connectionId: id,
        targetSchema: 'main',
        createSchema: false,
        dropObjectsFirst: false,
        includeStructure: true,
        includeData: true,
        continueOnError: false,
        replaceSchema: true,
        safetyBackup: true
      },
      () => {},
      new AbortController().signal
    )
    expect(result.errors).toEqual([])
    expect(result.safetyBackupPath).toMatch(/\.db$/)
    expect(existsSync(result.safetyBackupPath!)).toBe(true)
    expect(await dump(id)).toEqual(before)
    const [tables] = ok(await exec(id, "SELECT count(*) FROM sqlite_schema WHERE name = 'junk'"))
    expect(tables.resultSet!.rows).toEqual([[0]])
    // The safety copy is a real database with the replaced content.
    const safetyId = ctx.connections.save(input(result.safetyBackupPath!, { name: 'safety' })).id
    const [junk] = ok(
      await exec(safetyId, "SELECT count(*) FROM sqlite_schema WHERE name = 'junk'")
    )
    expect(junk.resultSet!.rows).toEqual([[1]])
    await manager.close(safetyId)
  })

  it('refuses a backup while a query tab owns a transaction', async () => {
    ok(await exec(id, "BEGIN; INSERT INTO author (name) VALUES ('tx')", 'owner'))
    await expect(
      service.create({ connectionId: id, schema: 'main', includeData: true, format: 'vqb' })
    ).rejects.toThrow(SQLITE_TX_OPEN_MESSAGE)
    await lite.rollback(id, 'owner')
  })

  it('needs the production confirmation to restore over a guarded connection', async () => {
    const backup = await service.create({
      connectionId: id,
      schema: 'main',
      includeData: false,
      format: 'vqb'
    })
    const prodPath = join(dir, 'files', 'prod.db')
    await createSqliteFile(prodPath, spawner)
    const prodId = ctx.connections.save(
      input(prodPath, {
        name: 'Prod',
        environment: 'production',
        sqlite: { ...defaultSqliteOptions(true), filePath: prodPath, readOnly: false }
      })
    ).id
    const options = {
      backupPath: backup.path,
      connectionId: prodId,
      targetSchema: 'main',
      createSchema: false,
      dropObjectsFirst: false,
      includeStructure: true,
      includeData: true,
      continueOnError: false
    }
    await expect(service.restore(options)).rejects.toThrow('producción')
    const handlers = createBackupHandlers(ctx, async () => service)
    await expect(handlers.restore('op-prod', options)).rejects.toThrow('confirmación explícita')
    const result = await service.restore({ ...options, confirmProduction: true })
    expect(result.errors).toEqual([])
    const [r] = ok(await exec(prodId, SCHEMA))
    expect(r.resultSet!.rows.length).toBeGreaterThan(3)
    await manager.close(prodId)
  })

  it('refuses a SQLite copy on another engine and another engine on SQLite', async () => {
    const backup = await service.create({
      connectionId: id,
      schema: 'main',
      includeData: false,
      format: 'vqb'
    })
    const pgId = ctx.connections.save({
      ...input(mainPath),
      name: 'pg',
      engine: 'postgresql',
      host: 'localhost',
      port: 5432,
      username: 'x',
      postgres: { initialDatabase: 'x', showSystemSchemas: false, timeZone: '', searchPath: '' }
    }).id
    await expect(
      service.restore({
        backupPath: backup.path,
        connectionId: pgId,
        targetSchema: 'x',
        createSchema: false,
        dropObjectsFirst: false,
        includeStructure: true,
        includeData: true,
        continueOnError: false
      })
    ).rejects.toThrow('La copia es de SQLite')
  })
})
