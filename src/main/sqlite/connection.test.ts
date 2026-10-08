import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '@shared/types'
import { defaultSqliteOptions } from '@shared/engines'
import { SqliteCore } from './core'
import { SqliteDriverConnection } from './connection'
import { createSqliteDriver, createSqliteFile, MAX_OPEN_SQLITE, openSqliteCount } from './driver'
import { CANCELLED_MESSAGE, OTHER_TAB_TRANSACTION } from './errors'
import { executeSqliteScript, KEYLESS_TRANSACTION_NOTE } from './query'
import { inProcessSpawner, type ProcessSpawner } from './spawner'
import type { WorkerRequest } from './protocol'

let dir: string
let open: SqliteDriverConnection[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vortaq-sqlite-conn-'))
})
afterEach(async () => {
  await Promise.all(open.map((c) => c.close().catch(() => undefined)))
  open = []
  rmSync(dir, { recursive: true, force: true })
})

function seed(name: string, sql: string): string {
  const core = new SqliteCore()
  const path = join(dir, name)
  core.open({
    filePath: path,
    readOnly: false,
    foreignKeys: false,
    busyTimeoutMs: 1000,
    attached: [],
    initialStatements: [],
    queryOnly: false,
    create: true
  })
  for (const s of sql.split(';').filter((x) => x.trim())) core.query(s)
  core.close()
  return path
}

function config(filePath: string, over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: 'lite',
    name: 'Lite',
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
    createdAt: '',
    updatedAt: '',
    engine: 'sqlite',
    sqlite: { ...defaultSqliteOptions(false), filePath },
    ...over
  }
}

async function connect(
  cfg: ConnectionConfig,
  options: { spawner?: ProcessSpawner; guarded?: () => boolean; onFatal?: (r: string) => void } = {}
): Promise<SqliteDriverConnection> {
  const c = new SqliteDriverConnection({
    config: cfg,
    spawner: options.spawner ?? inProcessSpawner(),
    isGuarded: options.guarded ?? (() => false),
    onFatal: options.onFatal ?? (() => undefined)
  })
  await c.probe()
  open.push(c)
  return c
}

const run = (c: SqliteDriverConnection, sql: string, tab = 'tabA', extra = {}) =>
  executeSqliteScript(c, sql, { sessionKey: tab, ...extra })

describe('cancel by killing the worker', () => {
  it('ends a statement that never answers in under a second and reopens the file', async () => {
    const aux = seed('aux.db', 'CREATE TABLE a (x)')
    const main = seed('main.db', 'CREATE TABLE t (x)')
    const spawner = inProcessSpawner({
      intercept: (req: WorkerRequest) =>
        req.op === 'run' && String(req.args[0]).includes('HANG') ? 'hang' : undefined
    })
    const c = await connect(
      config(main, {
        initialQueries: 'CREATE TEMP TABLE marker (x)',
        sqlite: {
          ...defaultSqliteOptions(false),
          filePath: main,
          attached: [{ alias: 'aux', filePath: aux }]
        }
      }),
      { spawner }
    )
    await run(c, 'BEGIN; INSERT INTO t VALUES (1)')
    expect(c.transactionOwner).toBe('tabA')
    const started = performance.now()
    const pending = run(c, "SELECT 'HANG'; SELECT 2", 'tabA', { executionId: 'e1' })
    await new Promise((r) => setTimeout(r, 30))
    expect(await c.cancel('e1')).toBe(true)
    const results = await pending
    expect(performance.now() - started).toBeLessThan(1000)
    expect(results).toHaveLength(1)
    expect(results[0].error).toBe(CANCELLED_MESSAGE)
    expect(spawner.spawned).toBe(2)
    // The open transaction is gone; attachments and initial queries are back.
    expect(c.transactionOwner).toBeNull()
    const [check] = await run(
      c,
      "SELECT (SELECT count(*) FROM t) AS n, (SELECT count(*) FROM pragma_database_list WHERE name = 'aux') AS aux, (SELECT count(*) FROM temp.sqlite_schema WHERE name = 'marker') AS marker"
    )
    expect(check.resultSet?.rows).toEqual([[0, 1, 1]])
  })

  it('only cancels the execution that is running now', async () => {
    const c = await connect(config(seed('m.db', 'CREATE TABLE t (x)')))
    expect(await c.cancel('nothing-running')).toBe(false)
    await run(c, 'SELECT 1', 'tabA', { executionId: 'done' })
    expect(await c.cancel('done')).toBe(false)
  })

  it('tells the manager when the worker dies on its own', async () => {
    let reason = ''
    let proc: { kill(): void } | null = null
    const base = inProcessSpawner()
    const spawner: ProcessSpawner = () => {
      const p = base()
      proc = p
      return p
    }
    const c = await connect(config(seed('d.db', 'CREATE TABLE t (x)')), {
      spawner,
      onFatal: (r) => (reason = r)
    })
    expect(c).toBeTruthy()
    proc!.kill()
    await new Promise((r) => setTimeout(r, 20))
    expect(reason).toContain('terminó inesperadamente')
  })
})

describe('shared transaction across query tabs', () => {
  it('lets other tabs read (uncommitted data visible) but refuses their writes', async () => {
    const c = await connect(config(seed('tx.db', 'CREATE TABLE t (x)')))
    const [, ins] = await run(c, 'BEGIN; INSERT INTO t VALUES (1)', 'tabA')
    expect(ins.transactionStatus).toBe('in')
    expect(c.tabState('tabA')).toMatchObject({
      transactionStatus: 'in',
      transactionElsewhere: false
    })
    expect(c.tabState('tabB')).toMatchObject({
      transactionStatus: 'idle',
      transactionElsewhere: true
    })
    const [read] = await run(c, 'SELECT count(*) FROM t', 'tabB')
    expect(read.resultSet?.rows).toEqual([[1]])
    expect(read.transactionStatus).toBe('idle')
    await expect(run(c, 'INSERT INTO t VALUES (2)', 'tabB')).rejects.toThrow(OTHER_TAB_TRANSACTION)
    await expect(run(c, 'COMMIT', 'tabB')).rejects.toThrow(OTHER_TAB_TRANSACTION)
    await expect(c.endTransaction('tabB', 'COMMIT')).rejects.toThrow('otra pestaña')
    expect(() => c.assertCanWrite('', 'Guardar')).toThrow('Guardar: hay una transacción abierta')
    await c.endTransaction('tabA', 'COMMIT')
    expect(c.transactionOwner).toBeNull()
    const [ok] = await run(c, 'INSERT INTO t VALUES (2)', 'tabB')
    expect(ok.affectedRows).toBe(1)
  })

  it('rolls back the owner tab transaction when the tab closes', async () => {
    const c = await connect(config(seed('close.db', 'CREATE TABLE t (x)')))
    await run(c, 'BEGIN; INSERT INTO t VALUES (1)', 'tabA')
    await c.closeTab('tabA')
    const [r] = await run(c, 'SELECT count(*) FROM t', 'tabB')
    expect(r.resultSet?.rows).toEqual([[0]])
  })

  it('never leaves a transaction open for a run without a tab', async () => {
    const c = await connect(config(seed('keyless.db', 'CREATE TABLE t (x)')))
    const results = await executeSqliteScript(c, 'BEGIN; INSERT INTO t VALUES (1)', {})
    expect(results[1].notices).toEqual([KEYLESS_TRANSACTION_NOTE])
    expect(c.transactionOwner).toBeNull()
  })
})

describe('guarded connections run with query_only', () => {
  it('refuses unconfirmed writes and lifts query_only only for a confirmed script', async () => {
    const c = await connect(config(seed('g.db', 'CREATE TABLE t (x)')), { guarded: () => true })
    const qo = async () =>
      (await run(c, 'SELECT query_only FROM pragma_query_only'))[0].resultSet?.rows[0][0]
    expect(await qo()).toBe(1)
    const [denied] = await run(c, 'INSERT INTO t VALUES (1)')
    expect(denied.error).toMatch(/query_only|readonly|solo lectura/i)
    const [ok] = await run(c, 'INSERT INTO t VALUES (1)', 'tabA', { confirmProduction: true })
    expect(ok.error).toBeNull()
    expect(await qo()).toBe(1)
    // A confirmed transaction keeps writes possible until it ends.
    await run(c, 'BEGIN; INSERT INTO t VALUES (2)', 'tabA', { confirmProduction: true })
    expect(await qo()).toBe(0)
    await c.endTransaction('tabA', 'COMMIT')
    expect(await qo()).toBe(1)
  })
})

describe('driver', () => {
  it('opens at most four SQLite connections at once', async () => {
    const driver = createSqliteDriver(() => inProcessSpawner())
    const path = seed('cap.db', 'CREATE TABLE t (x)')
    const hooks = { onFatal: () => undefined }
    const conns = []
    for (let i = 0; i < MAX_OPEN_SQLITE; i++)
      conns.push(
        await driver.open(
          config(path, { id: `c${i}` }),
          { password: null, sshPassword: null },
          null,
          hooks
        )
      )
    expect(openSqliteCount()).toBe(MAX_OPEN_SQLITE)
    await expect(
      driver.open(config(path, { id: 'c5' }), { password: null, sshPassword: null }, null, hooks)
    ).rejects.toThrow('Demasiados archivos SQLite abiertos')
    await conns[0].close()
    const again = await driver.open(
      config(path, { id: 'c6' }),
      { password: null, sshPassword: null },
      null,
      hooks
    )
    await Promise.all([...conns.slice(1), again].map((c) => c.close()))
    expect(openSqliteCount()).toBe(0)
  })

  it('tests a file read-only and never creates one', async () => {
    const driver = createSqliteDriver(() => inProcessSpawner())
    const path = seed('t.db', 'CREATE TABLE t (x); CREATE TABLE u (y)')
    const ok = await driver.test(
      config(path),
      { password: null, sshPassword: null },
      null,
      performance.now()
    )
    expect(ok).toMatchObject({ ok: true, serverVersion: expect.stringMatching(/^SQLite 3\./) })
    expect(ok.details).toContain('2 tabla(s)')
    await expect(
      driver.test(config(join(dir, 'nope.db')), { password: null, sshPassword: null }, null, 0)
    ).rejects.toThrow('Archivo no encontrado')
    await expect(
      driver.open(
        config(path, {
          sqlite: { ...defaultSqliteOptions(false), filePath: path, pathNeedsReview: true }
        }),
        { password: null, sshPassword: null },
        null,
        { onFatal: () => undefined }
      )
    ).rejects.toThrow('viene de otro equipo')
  })

  it('creates a new file only through createSqliteFile', async () => {
    const path = join(dir, 'brand-new.db')
    const created = await createSqliteFile(path, inProcessSpawner())
    expect(created.sqliteVersion).toMatch(/^3\./)
    await expect(createSqliteFile(path, inProcessSpawner())).rejects.toThrow('Ya existe')
  })
})
