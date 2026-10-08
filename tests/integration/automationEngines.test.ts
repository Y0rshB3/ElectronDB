/**
 * Automation jobs on PostgreSQL, SQLite and MongoDB, end to end in a scratch
 * profile: a backup step (.vqb, encrypted with the job's password) and a
 * restore step that replaces another database of the same engine from that
 * copy, run through the automation service (manual and headless runs). The
 * launchd agent is written into a scratch home folder with a fake launchctl:
 * no real LaunchAgent is installed. SQLite needs no server; PostgreSQL and
 * MongoDB use VORTAQ_TEST_PG_URL / VORTAQ_TEST_MONGO_URL.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionInput, Environment, Job, JobTask } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import { defaultSqliteOptions } from '@shared/engines'
import { parseMongoUri } from '@shared/mongo/uri'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { ConnectionManager, getSessionFactory } from '@main/db/manager'
import { createSqliteDriver, createSqliteFile } from '@main/sqlite/driver'
import { inProcessSpawner } from '@main/sqlite/spawner'
import { isSqliteConnection } from '@main/sqlite/connection'
import { isMongoConnection } from '@main/mongo/connection'
import { isPgConnection } from '@main/postgres/connection'
import { createBackupService, type BackupService } from '@main/backup/index'
import { readArchiveMeta } from '@main/backup/archive'
import { createAutomationService, getAutomationService } from '@main/automation/index'
import { runJobHeadless } from '@main/automation/headless'
import { launchAgentStatus, type PlatformInfo } from '@main/automation/launchAgent'
import { setJobBackupPassword } from '@main/automation/backupKeys'
import { validateJobInput } from '@main/ipc/jobValidation'
import type { Logger } from '@main/log'
import { MONGO_TARGET, POSTGRES_TARGET, describeServer } from './targets'

const CHEAP = { N: 1024, r: 8, p: 1 }
const JOB_PASSWORD = 'clave de la tarea 2026'
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} }
const noSessions = { acquire: () => Promise.reject(new Error('MySQL no se usa aquí')) }

function scratchContext(dir: string, headless = false): AppContext {
  return {
    userDataPath: dir,
    logDir: join(dir, 'logs'),
    connections: new ConnectionsRepo(dir),
    jobs: new JobsRepo(dir),
    runs: new RunsRepo(dir),
    settings: new SettingsRepo(dir, dir),
    credentials: new CredentialStore(dir, plainCodec, 'plain'),
    emit: <E extends IpcEventChannel>(_c: E, _p: IpcEventMap[E]) => {},
    headless
  }
}

function baseInput(name: string, environment: Environment, backupDir: string): ConnectionInput {
  return {
    name,
    color: null,
    environment,
    host: '',
    port: 0,
    username: '',
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
    backupDir,
    extraBackupDirs: []
  }
}

/** Backup step (.vqb, encrypted) of `source`/`db`, then a restore of it into `target`/`targetDb`. */
function backupAndRestore(source: string, db: string, target: string, targetDb: string): JobTask[] {
  return [
    {
      id: 'b1',
      type: 'backupschema',
      connectionId: source,
      schema: db,
      referenceName: `Backup ${db}`,
      includeData: true,
      format: 'vqb',
      encrypt: true
    },
    {
      id: 'r1',
      type: 'restoreschema',
      connectionId: target,
      schema: targetDb,
      referenceName: `Restaurar ${targetDb}`,
      restoreSource: { kind: 'task', taskId: 'b1' },
      safetyBackup: true,
      includeData: true
    }
  ]
}

function saveJob(ctx: AppContext, name: string, tasks: JobTask[], launchAgent = false): Job {
  const input = {
    name,
    continueOnError: false,
    tasks,
    schedule: { enabled: launchAgent, cron: launchAgent ? '30 2 * * *' : '', launchAgent }
  }
  validateJobInput(input, (id) => ctx.connections.get(id))
  const job = ctx.jobs.save(input)
  setJobBackupPassword(ctx, job.id, JOB_PASSWORD)
  return job
}

function fakePlatform(dir: string): PlatformInfo {
  return {
    os: 'darwin',
    execPath: '/bin/vortaq',
    appArgs: [],
    uid: 501,
    homeDir: join(dir, 'home')
  }
}

describe('automation jobs on SQLite (integration, real files)', () => {
  let dir: string
  let ctx: AppContext
  let manager: ConnectionManager
  let service: BackupService
  const spawner = inProcessSpawner()
  let sourceId: string
  let targetId: string
  let targetPath: string

  const sqliteInput = (name: string, filePath: string, env: Environment = 'local') => ({
    ...baseInput(name, env, join(dir, 'backups')),
    authMode: 'none' as const,
    engine: 'sqlite' as const,
    sqlite: { ...defaultSqliteOptions(false), filePath, foreignKeys: true }
  })

  const rows = async (id: string, sql: string): Promise<unknown[]> => {
    const c = await manager.connection(id)
    if (!isSqliteConnection(c)) throw new Error('no SQLite')
    return c.exclusive((s) => s.query(sql))
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-jobs-sqlite-'))
    mkdirSync(join(dir, 'files'))
    ctx = scratchContext(dir)
    manager = new ConnectionManager(ctx, { drivers: async () => createSqliteDriver(() => spawner) })
    service = createBackupService(ctx, noSessions, {
      scrypt: CHEAP,
      sqliteSpawner: () => spawner,
      sqlite: {
        async connection(cid) {
          const c = await manager.connection(cid)
          if (!isSqliteConnection(c)) throw new Error('no SQLite')
          return c
        }
      }
    })
    const sourcePath = join(dir, 'files', 'tienda.db')
    targetPath = join(dir, 'files', 'tienda-copia.db')
    await createSqliteFile(sourcePath, spawner)
    await createSqliteFile(targetPath, spawner)
    sourceId = ctx.connections.save(sqliteInput('Tienda', sourcePath)).id
    targetId = ctx.connections.save(sqliteInput('Tienda copia', targetPath)).id
    const c = await manager.connection(sourceId)
    if (!isSqliteConnection(c)) throw new Error('no SQLite')
    await c.exclusive(async (s) => {
      await s.query(
        'CREATE TABLE producto (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, precio REAL)'
      )
      await s.query(
        "INSERT INTO producto (nombre, precio) VALUES ('té', 2.5), ('café', 1.75), ('pan', NULL)"
      )
      await s.query('CREATE VIEW caros AS SELECT nombre FROM producto WHERE precio > 2')
    })
    // The target already has something else: the restore replaces it.
    const t = await manager.connection(targetId)
    if (!isSqliteConnection(t)) throw new Error('no SQLite')
    await t.exclusive((s) => s.query('CREATE TABLE vieja (x)'))
  })

  afterAll(async () => {
    await manager.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('backs up (encrypted .vqb) and replaces another file from that copy', async () => {
    const launchctl: string[][] = []
    const platform = fakePlatform(dir)
    const automation = createAutomationService(ctx, {
      deps: { backups: service, sessions: noSessions },
      platform,
      execFile: async (_file, args) => {
        launchctl.push(args)
        return { stdout: '', stderr: '' }
      },
      log: silent
    })
    try {
      const job = saveJob(
        ctx,
        'Copia SQLite',
        backupAndRestore(sourceId, 'main', targetId, 'main'),
        true
      )
      await automation.resync!(job.id)
      // The launchd agent went to the scratch home, through the fake launchctl.
      expect(launchAgentStatus(job.id, platform.homeDir, platform.os)).toBe(true)
      expect(launchctl.map((a) => a[0])).toEqual(['bootout', 'bootstrap'])

      const initial = await automation.run(job.id, 'manual')
      const run = await automation.wait!(initial.id)
      expect(run.tasks.map((t) => [t.status, t.message])).toEqual([
        ['success', null],
        ['success', null]
      ])
      const backupPath = run.tasks[0].outputPath!
      expect(backupPath).toMatch(/\.vqb$/)
      expect(run.tasks[0].encrypted).toBe(true)
      // Encrypted with the job's password: locked without it.
      expect((await readArchiveMeta(backupPath)).locked).toBe(true)
      // The safety copy of the target (VACUUM INTO) exists.
      expect(run.tasks[1].outputPath && existsSync(run.tasks[1].outputPath)).toBeTruthy()
      expect(await rows(targetId, 'SELECT id, nombre, precio FROM producto ORDER BY id')).toEqual(
        await rows(sourceId, 'SELECT id, nombre, precio FROM producto ORDER BY id')
      )
      expect(
        await rows(targetId, "SELECT name FROM sqlite_schema WHERE name IN ('vieja', 'caros')")
      ).toEqual([{ name: 'caros' }])
      // The password is never written to jobs.json or the run log.
      expect(readFileSync(join(dir, 'jobs.json'), 'utf8')).not.toContain(JOB_PASSWORD)
      expect(readFileSync(run.logPath, 'utf8')).not.toContain(JOB_PASSWORD)
    } finally {
      await automation.stop()
    }
  })

  it('runs headless (the launchd entry point) with the same result', async () => {
    const job = saveJob(ctx, 'Copia SQLite headless', [
      backupAndRestore(sourceId, 'main', targetId, 'main')[0]
    ])
    getAutomationService(ctx, {
      deps: { backups: service, sessions: noSessions },
      platform: fakePlatform(dir),
      execFile: async () => ({ stdout: '', stderr: '' }),
      log: silent
    })
    expect(await runJobHeadless(ctx, job.id)).toBe(0)
    const [run] = ctx.runs.list(job.id, 1)
    expect(run.trigger).toBe('cli')
    expect(run.status).toBe('success')
  })

  it('never restores into a production connection from a job', async () => {
    const prodId = ctx.connections.save(sqliteInput('Tienda prod', targetPath, 'production')).id
    expect(() =>
      validateJobInput(
        {
          name: 'A producción',
          continueOnError: false,
          tasks: backupAndRestore(sourceId, 'main', prodId, 'main'),
          schedule: { enabled: false, cron: '', launchAgent: false }
        },
        (id) => ctx.connections.get(id)
      )
    ).toThrow(/conexión de producción/)
    // A job stored before (or edited by hand) is refused by the runner, nothing touched.
    const job = ctx.jobs.save({
      name: 'Guardada antes',
      continueOnError: true,
      tasks: backupAndRestore(sourceId, 'main', prodId, 'main'),
      schedule: { enabled: false, cron: '', launchAgent: false }
    })
    setJobBackupPassword(ctx, job.id, JOB_PASSWORD)
    const automation = createAutomationService(ctx, {
      deps: { backups: service, sessions: noSessions },
      platform: fakePlatform(dir),
      log: silent
    })
    try {
      const run = await automation.wait!((await automation.run(job.id, 'manual')).id)
      expect(run.tasks[1].status).toBe('failed')
      expect(run.tasks[1].message).toMatch(/producción/)
      expect(run.tasks[1].outputPath).toBeNull()
    } finally {
      await automation.stop()
    }
  })
})

describeServer(MONGO_TARGET, 'automation jobs on MongoDB (integration)', (url) => {
  const SRC = `vortaq_jobs_mongo_${process.pid}`
  const DST = `${SRC}_copia`
  let dir: string
  let ctx: AppContext
  let manager: ConnectionManager
  let id: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-jobs-mongo-'))
    ctx = scratchContext(dir)
    const p = parseMongoUri(url)
    id = ctx.connections.save({
      ...baseInput('Mongo jobs', 'local', join(dir, 'backups')),
      host: p.host,
      port: p.port,
      username: p.username,
      ssl: { enabled: false, verifyServer: true },
      engine: 'mongodb',
      mongo: { ...p.mongo, defaultDatabase: SRC }
    }).id
    ctx.credentials.set('mysql', id, p.password)
    manager = new ConnectionManager(ctx)
    const c = await manager.connection(id)
    if (!isMongoConnection(c)) throw new Error('not mongo')
    for (const db of [SRC, DST]) await c.db(db).dropDatabase()
    await c
      .db(SRC)
      .collection('pedidos')
      .insertMany([
        { n: 1, cliente: 'Ana' },
        { n: 2, cliente: 'Luis' }
      ])
    await c.db(SRC).collection('pedidos').createIndex({ cliente: 1 }, { name: 'por_cliente' })
    await c.db(DST).collection('otra').insertOne({ x: 1 })
  })

  afterAll(async () => {
    const c = await manager.connection(id).catch(() => null)
    if (c && isMongoConnection(c))
      for (const db of [SRC, DST])
        await c
          .db(db)
          .dropDatabase()
          .catch(() => undefined)
    await manager.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('backs up a database and replaces another one from that copy', async () => {
    const service = createBackupService(ctx, noSessions, {
      scrypt: CHEAP,
      mongo: {
        async connection(cid) {
          const c = await manager.connection(cid)
          if (!isMongoConnection(c)) throw new Error('not mongo')
          return c
        }
      }
    })
    const automation = createAutomationService(ctx, {
      deps: { backups: service, sessions: noSessions },
      platform: fakePlatform(dir),
      log: silent
    })
    try {
      const job = saveJob(ctx, 'Copia Mongo', backupAndRestore(id, SRC, id, DST))
      const run = await automation.wait!((await automation.run(job.id, 'manual')).id)
      expect(run.tasks.map((t) => [t.status, t.message])).toEqual([
        ['success', null],
        ['success', null]
      ])
      const c = await manager.connection(id)
      if (!isMongoConnection(c)) throw new Error('not mongo')
      const names = (await c.db(DST).listCollections().toArray()).map((x) => x.name).sort()
      expect(names).toEqual(['pedidos'])
      expect(await c.db(DST).collection('pedidos').countDocuments()).toBe(2)
      const indexes = (await c.db(DST).collection('pedidos').indexes()).map((i) => i.name)
      expect(indexes).toContain('por_cliente')
    } finally {
      await automation.stop()
    }
  })
})

describeServer(POSTGRES_TARGET, 'automation jobs on PostgreSQL (integration)', (url) => {
  const SRC = `vortaq_jobs_pg_${process.pid}`
  const DST = `${SRC}_copia`
  let dir: string
  let ctx: AppContext
  let manager: ConnectionManager
  let id: string

  const admin = async (sql: string): Promise<void> => {
    const c = await manager.connection(id)
    if (!isPgConnection(c)) throw new Error('not pg')
    const s = await c.acquire(null)
    try {
      await s.query(sql)
    } finally {
      await s.release()
    }
  }
  const inDb = async (db: string, sql: string): Promise<Record<string, unknown>[]> => {
    const c = await manager.connection(id)
    if (!isPgConnection(c)) throw new Error('not pg')
    const s = await c.acquire({ database: db, schema: null })
    try {
      return await s.query(sql)
    } finally {
      await s.release()
    }
  }

  beforeAll(async () => {
    const u = new URL(url)
    dir = mkdtempSync(join(tmpdir(), 'vortaq-jobs-pg-'))
    ctx = scratchContext(dir)
    id = ctx.connections.save({
      ...baseInput('PG jobs', 'local', join(dir, 'backups')),
      host: u.hostname,
      port: Number(u.port || 5432),
      username: decodeURIComponent(u.username),
      ssl: { enabled: false, verifyServer: false, mode: 'disable' },
      engine: 'postgresql',
      postgres: {
        initialDatabase: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
        showSystemSchemas: false,
        timeZone: '',
        searchPath: ''
      }
    }).id
    ctx.credentials.set('mysql', id, decodeURIComponent(u.password))
    manager = new ConnectionManager(ctx)
    for (const db of [SRC, DST]) await admin(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`)
    await admin(`CREATE DATABASE "${SRC}"`)
    await inDb(
      SRC,
      'CREATE TABLE cliente (id serial PRIMARY KEY, nombre text NOT NULL); ' +
        "INSERT INTO cliente (nombre) VALUES ('Ana'), ('Luis')"
    )
  }, 60_000)

  afterAll(async () => {
    await manager.closeAll()
    // A fresh manager: the pools of SRC/DST are closed, so the databases can be dropped.
    const cleanup = new ConnectionManager(ctx)
    manager = cleanup
    for (const db of [SRC, DST])
      await admin(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => undefined)
    await cleanup.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('backs up a database and creates another one from that copy', async () => {
    const pgManager = manager
    const service = createBackupService(ctx, getSessionFactory(ctx), {
      scrypt: CHEAP,
      pg: {
        async acquire(cid, database) {
          const c = await pgManager.connection(cid)
          if (!isPgConnection(c)) throw new Error('not pg')
          return c.acquire(database ? { database, schema: null } : null)
        }
      }
    })
    const automation = createAutomationService(ctx, {
      deps: { backups: service, sessions: noSessions },
      platform: fakePlatform(dir),
      log: silent
    })
    try {
      const job = saveJob(ctx, 'Copia PG', backupAndRestore(id, SRC, id, DST))
      const run = await automation.wait!((await automation.run(job.id, 'manual')).id)
      expect(run.tasks.map((t) => [t.status, t.message])).toEqual([
        ['success', null],
        ['success', null]
      ])
      expect(await inDb(DST, 'SELECT id, nombre FROM cliente ORDER BY id')).toEqual([
        { id: 1, nombre: 'Ana' },
        { id: 2, nombre: 'Luis' }
      ])
    } finally {
      await automation.stop()
    }
  }, 60_000)
})
