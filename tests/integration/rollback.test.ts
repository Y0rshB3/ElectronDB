import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionInput, JobRun } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { envVar } from '@main/env'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { getConnectionManager, getSessionFactory } from '@main/mysql/manager'
import type { MysqlSession } from '@main/mysql/types'
import { createBackupService, type BackupService } from '@main/backup/index'
import { indexTar } from '@main/backup/nb3/tar'
import {
  buildRollbackPlan,
  createRollbackInspector,
  prepareRollback
} from '@main/automation/rollback'
import { runJob, startJobWith, type RunnerDeps } from '@main/automation/runner'
import { validateJobInput } from '@main/ipc/jobValidation'

/**
 * «Restaurar todo en Local» end to end across server versions: a job backs up
 * two schemas on MySQL 5.7 ("staging") and the run is restored with REPLACE
 * semantics into MySQL 8.4 ("local"), which already holds an older rb_a.
 *
 *   ELECTRONDB_TEST_MYSQL_URL=mysql://root:navidog@127.0.0.1:33306/navidog_test     (8.4)
 *   ELECTRONDB_TEST_MYSQL57_URL=mysql://root:navidog@127.0.0.1:33357/navidog_test   (5.7)
 */

const url84 = envVar('TEST_MYSQL_URL')
const url57 = envVar('TEST_MYSQL57_URL')
const A = 'rb_a'
const B = 'rb_b'
const A_OLD = 'rb_a_old_local'
const PROD_GUARD = 'rb_prod_guard'
/** 5.7 schema with a function 8.4 refuses while binary logging is on (no DETERMINISTIC...). */
const C = 'rb_c'
const USERS = 600
const ITEMS = 2500

const DIGITS =
  '(SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)'
const SEQ = `(SELECT a.d + b.d * 10 + c.d * 100 + e.d * 1000 + 1 AS n FROM ${DIGITS} a CROSS JOIN ${DIGITS} b CROSS JOIN ${DIGITS} c CROSS JOIN ${DIGITS} e) seq`

/** Staging 5.7: definer account the 8.4 server does not have, unicode_ci schema, zero dates. */
const SETUP_57: string[] = [
  "CREATE USER IF NOT EXISTS 'rb_app'@'%' IDENTIFIED BY 'rb_app_pw'",
  `DROP DATABASE IF EXISTS ${A}`,
  `DROP DATABASE IF EXISTS ${B}`,
  `CREATE DATABASE ${A} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE ${A}.users (
     id INT NOT NULL AUTO_INCREMENT,
     name VARCHAR(80) NOT NULL,
     email VARCHAR(120) NOT NULL,
     created DATETIME NULL,
     score DECIMAL(10,2) NULL,
     bio TEXT NULL,
     avatar BLOB NULL,
     flags SET('a','b','c') NULL,
     kind ENUM('x','y') NOT NULL DEFAULT 'x',
     PRIMARY KEY (id),
     UNIQUE KEY uq_email (email)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE ${A}.orders (
     id INT NOT NULL AUTO_INCREMENT,
     user_id INT NOT NULL,
     total DECIMAL(12,2) NOT NULL,
     placed DATETIME NOT NULL,
     PRIMARY KEY (id),
     KEY idx_user (user_id),
     CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users (id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `INSERT INTO ${A}.users (name, email, created, score, bio, avatar, flags, kind)
   SELECT CONCAT('ñandú 😀 ', n), CONCAT('u', n, '@example.test'),
          DATE_ADD('2024-01-01 00:00:00', INTERVAL n MINUTE),
          IF(n % 9 = 0, NULL, n * 1.5),
          CONCAT('línea 1\\nlínea ''2'' ', REPEAT('z', n % 50)),
          IF(n % 5 = 0, NULL, UNHEX(MD5(n))),
          IF(n % 3 = 0, 'a,c', 'b'),
          IF(n % 2 = 0, 'x', 'y')
   FROM ${SEQ} WHERE n <= ${USERS}`,
  `INSERT INTO ${A}.orders (user_id, total, placed)
   SELECT 1 + (n % ${USERS}), n * 3.25, DATE_ADD('2025-06-01 08:00:00', INTERVAL n HOUR)
   FROM ${SEQ} WHERE n <= ${USERS * 2}`,
  // A zero date, accepted on 5.7 with a relaxed sql_mode (the restore must keep it).
  `SET SESSION sql_mode = ''`,
  `INSERT INTO ${A}.users (name, email, created, kind) VALUES ('cero', 'zero@example.test', '0000-00-00 00:00:00', 'x')`,
  `SET SESSION sql_mode = DEFAULT`,
  // The definer can use its own objects on 5.7 (on 8.4 the account does not exist at all).
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ${A}.* TO 'rb_app'@'%'`,
  `CREATE DEFINER='rb_app'@'%' SQL SECURITY DEFINER VIEW ${A}.v_user_totals AS
     SELECT u.id, u.name, COUNT(o.id) AS orders, COALESCE(SUM(o.total), 0) AS total
     FROM ${A}.users u LEFT JOIN ${A}.orders o ON o.user_id = u.id GROUP BY u.id, u.name`,
  `CREATE DEFINER='rb_app'@'%' TRIGGER ${A}.users_bi BEFORE INSERT ON ${A}.users
     FOR EACH ROW SET NEW.name = TRIM(NEW.name)`,
  `CREATE DEFINER='rb_app'@'%' FUNCTION ${A}.f_tax(x DECIMAL(10,2)) RETURNS DECIMAL(10,2)
     DETERMINISTIC NO SQL RETURN x * 1.21`,
  `CREATE DEFINER='rb_app'@'%' PROCEDURE ${A}.p_count(OUT n INT) READS SQL DATA
     SELECT COUNT(*) INTO n FROM ${A}.users`,
  `CREATE DATABASE ${B} CHARACTER SET utf8mb4`,
  `CREATE TABLE ${B}.items (id INT NOT NULL PRIMARY KEY, label VARCHAR(50) NOT NULL, qty INT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `INSERT INTO ${B}.items SELECT n, CONCAT('item-', n), IF(n % 4 = 0, NULL, n % 17) FROM ${SEQ} WHERE n <= ${ITEMS}`,
  `CREATE VIEW ${B}.v_items AS SELECT id, label FROM ${B}.items WHERE qty > 5`
]

/** Local 8.4: an older rb_a with other tables and data that the rollback must replace. */
const SETUP_84: string[] = [
  `DROP DATABASE IF EXISTS ${A}`,
  `DROP DATABASE IF EXISTS ${B}`,
  `DROP DATABASE IF EXISTS ${A_OLD}`,
  `DROP DATABASE IF EXISTS ${PROD_GUARD}`,
  `CREATE DATABASE ${A}`,
  `CREATE TABLE ${A}.users (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL)`,
  `INSERT INTO ${A}.users VALUES (1, 'old-local-1'), (2, 'old-local-2'), (3, 'old-local-3')`,
  `CREATE TABLE ${A}.local_only (id INT PRIMARY KEY)`,
  `INSERT INTO ${A}.local_only VALUES (42)`
]

function connectionInput(
  u: URL,
  dir: string,
  name: string,
  environment: ConnectionInput['environment']
): ConnectionInput {
  return {
    name,
    color: null,
    environment,
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
    backupDir: join(dir, 'backups', name),
    extraBackupDirs: []
  }
}

/** Row count + order-independent checksum of every column (HEX, so charsets do not matter). */
async function tableChecksum(
  session: MysqlSession,
  schema: string,
  table: string
): Promise<{ count: number; md5: string }> {
  const cols = await session.query<{ name: string }>(
    'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [schema, table]
  )
  const parts = cols.map((c) => `IFNULL(HEX(${session.escapeId(c.name)}), 'N')`).join(", '|', ")
  const rowHash = `MD5(CONCAT(${parts}))`
  const [row] = await session.query<{ cnt: number | string; md5: string | null }>(
    `SELECT COUNT(*) AS cnt, MD5(IFNULL(GROUP_CONCAT(${rowHash} ORDER BY ${rowHash} SEPARATOR ''), '')) AS md5 FROM ${session.escapeId(schema)}.${session.escapeId(table)}`
  )
  return { count: Number(row.cnt), md5: String(row.md5) }
}

async function objectNames(session: MysqlSession, schema: string): Promise<string[]> {
  const rows = await session.query<{ kind: string; name: string }>(
    `SELECT CONCAT(TABLE_TYPE, ':', TABLE_NAME) AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?
     UNION ALL SELECT CONCAT(ROUTINE_TYPE, ':', ROUTINE_NAME) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
     UNION ALL SELECT CONCAT('TRIGGER:', TRIGGER_NAME) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`,
    [schema, schema, schema]
  )
  return rows.map((r) => r.name).sort()
}

describe.skipIf(!url84 || !url57)('rollback of a run: MySQL 5.7 -> 8.4 (integration)', () => {
  let dir: string
  let ctx: AppContext
  let deps: RunnerDeps
  let service: BackupService
  let stagingId: string
  let localId: string
  let prodId: string
  let s57: MysqlSession
  let s84: MysqlSession
  let backupRun: JobRun
  let rollbackRun: JobRun

  beforeAll(async () => {
    const u84 = new URL(url84!)
    const u57 = new URL(url57!)
    dir = mkdtempSync(join(tmpdir(), 'electrondb-rollback-it-'))
    ctx = {
      userDataPath: dir,
      logDir: join(dir, 'logs'),
      connections: new ConnectionsRepo(dir),
      jobs: new JobsRepo(dir),
      runs: new RunsRepo(dir),
      settings: new SettingsRepo(dir, dir),
      credentials: new CredentialStore(dir, plainCodec, 'plain'),
      emit: <E extends IpcEventChannel>(_channel: E, _payload: IpcEventMap[E]) => {},
      headless: true
    }
    const add = (u: URL, name: string, env: ConnectionInput['environment']): string => {
      const id = ctx.connections.save(connectionInput(u, dir, name, env)).id
      ctx.credentials.set('mysql', id, decodeURIComponent(u.password))
      return id
    }
    stagingId = add(u57, 'Staging 5.7', 'staging')
    localId = add(u84, 'Local 8.4', 'local')
    prodId = add(u84, 'Prod 8.4', 'production')

    const sessions = getSessionFactory(ctx)
    service = createBackupService(ctx, sessions)
    deps = { backups: service, sessions }
    s57 = await sessions.acquire(stagingId)
    s84 = await sessions.acquire(localId)
    for (const s of [s57, s84]) await s.execute('SET SESSION group_concat_max_len = 67108864')
    for (const sql of SETUP_57) await s57.execute(sql)
    for (const sql of SETUP_84) await s84.execute(sql)
  }, 120_000)

  afterAll(async () => {
    try {
      for (const db of [A, B, C]) await s57?.execute(`DROP DATABASE IF EXISTS ${db}`)
      await s57?.execute("DROP USER IF EXISTS 'rb_app'@'%'")
      for (const db of [A, B, C, A_OLD, PROD_GUARD])
        await s84?.execute(`DROP DATABASE IF EXISTS ${db}`)
    } catch {
      /* best effort */
    }
    await s57?.release().catch(() => undefined)
    await s84?.release().catch(() => undefined)
    await getConnectionManager(ctx).closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('backs up rb_a and rb_b on 5.7 through a job run', async () => {
    const job = ctx.jobs.save({
      name: 'Backup staging',
      continueOnError: false,
      tasks: [
        {
          id: 'ba',
          type: 'backupschema',
          connectionId: stagingId,
          schema: A,
          referenceName: `Backup ${A}`,
          includeData: true
        },
        {
          id: 'bb',
          type: 'backupschema',
          connectionId: stagingId,
          schema: B,
          referenceName: `Backup ${B}`,
          includeData: true
        }
      ],
      schedule: { enabled: false, cron: '', launchAgent: false }
    })
    backupRun = await runJob(ctx, deps, job.id, 'manual')
    expect(backupRun.status).toBe('success')
    expect(backupRun.tasks.map((t) => t.outputPath && existsSync(t.outputPath))).toEqual([
      true,
      true
    ])
  }, 120_000)

  it('plans the run into 8.4: rb_a will be replaced, rb_b created', async () => {
    const inspector = createRollbackInspector(ctx, () => getSessionFactory(ctx))
    const plan = await buildRollbackPlan(ctx, backupRun.id, localId, inspector)
    expect(plan.targetError).toBeNull()
    expect(plan.items.map((i) => [i.schema, i.targetSchema, i.targetExists, i.problem])).toEqual([
      [A, A, true, null],
      [B, B, false, null]
    ])
    expect(plan.items.every((i) => (i.sizeBytes ?? 0) > 0)).toBe(true)
  })

  it('restores the whole run into 8.4 with REPLACE + safety backup: 8.4 equals 5.7', async () => {
    const inspector = createRollbackInspector(ctx, () => getSessionFactory(ctx))
    const plan = await buildRollbackPlan(ctx, backupRun.id, localId, inspector)
    const prepared = prepareRollback(
      ctx,
      plan,
      {
        runId: backupRun.id,
        targetConnectionId: localId,
        taskIds: ['ba', 'bb'],
        safetyBackup: true
      },
      ctx.connections.get(localId)!,
      false
    )
    rollbackRun = await startJobWith(ctx, deps, prepared.job, 'manual', prepared.options).done
    expect(rollbackRun.tasks.map((t) => [t.status, t.message])).toEqual([
      ['success', null],
      ['success', null]
    ])
    expect(rollbackRun).toMatchObject({
      status: 'success',
      kind: 'rollback',
      rollbackOf: backupRun.id
    })

    // Same objects (the old local-only table is gone: a true replace).
    expect(await objectNames(s84, A)).toEqual(await objectNames(s57, A))
    expect(await objectNames(s84, B)).toEqual(await objectNames(s57, B))
    expect(await objectNames(s84, A)).not.toContain('BASE TABLE:local_only')
    // Same rows, byte for byte.
    for (const [schema, table] of [
      [A, 'users'],
      [A, 'orders'],
      [B, 'items']
    ]) {
      const source = await tableChecksum(s57, schema, table)
      expect(await tableChecksum(s84, schema, table)).toEqual(source)
      expect(source.count).toBeGreaterThan(0)
    }
    expect((await tableChecksum(s84, A, 'users')).count).toBe(USERS + 1)
    expect((await tableChecksum(s84, B, 'items')).count).toBe(ITEMS)
    // Schema charset/collation come from the backup (unicode_ci survives the move to 8.4).
    const [coll] = await s84.query<{ cs: string; co: string }>(
      'SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS co FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [A]
    )
    expect(coll).toEqual({ cs: 'utf8mb4', co: 'utf8mb4_unicode_ci' })
    // Objects defined by an account 8.4 does not have still work (DEFINER dropped).
    const [view57] = await s57.query<{ n: number; t: string }>(
      `SELECT COUNT(*) AS n, SUM(total) AS t FROM ${A}.v_user_totals`
    )
    const [view84] = await s84.query<{ n: number; t: string }>(
      `SELECT COUNT(*) AS n, SUM(total) AS t FROM ${A}.v_user_totals`
    )
    expect(view84).toEqual(view57)
    const [tax] = await s84.query<{ v: string }>(`SELECT ${A}.f_tax(100) AS v`)
    expect(String(tax.v)).toBe('121.00')
    await s84.execute(`CALL ${A}.p_count(@n)`)
    const [count] = await s84.query<{ n: number }>('SELECT @n AS n')
    expect(Number(count.n)).toBe(USERS + 1)
    const definers = await s84.query<{ d: string }>(
      'SELECT DEFINER AS d FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? UNION ALL SELECT DEFINER FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? UNION ALL SELECT DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?',
      [A, A, A]
    )
    expect(definers.length).toBe(4)
    for (const d of definers) expect(d.d).not.toMatch(/^rb_app@/)
    const [{ zeros }] = await s84.query<{ zeros: number }>(
      `SELECT COUNT(*) AS zeros FROM ${A}.users WHERE CAST(created AS CHAR) = '0000-00-00 00:00:00'`
    )
    expect(Number(zeros)).toBe(1)
    // The trigger fires on 8.4 (done last: it changes the data).
    await s84.execute(
      `INSERT INTO ${A}.users (name, email, kind) VALUES ('  con espacios  ', 'trigger@example.test', 'x')`
    )
    const [trimmed] = await s84.query<{ name: string }>(
      `SELECT name FROM ${A}.users WHERE email = 'trigger@example.test'`
    )
    expect(trimmed.name).toBe('con espacios')

    // Live log format: one heading per database, safety backup, drop/create, objects, result.
    const log = readFileSync(rollbackRun.logPath, 'utf8')
    expect(log).toContain(`Inicio de «Rollback a Local 8.4 · Backup staging»`)
    expect(log).toContain(`Paso 1/2 · Base de datos ${A}: Staging 5.7 -> Local 8.4`)
    expect(log).toContain(`Paso 2/2 · Base de datos ${B}: Staging 5.7 -> Local 8.4`)
    expect(log).toMatch(new RegExp(`Copia previa de ${A} \\.+ .*OK`))
    expect(log).toMatch(new RegExp(`Reemplazar base de datos ${A} \\.+ +utf8mb4_unicode_ci {2}OK`))
    expect(log).toMatch(new RegExp(`Crear base de datos ${B} \\.+`))
    expect(log).toMatch(/Tabla users \.+ +601 filas {2}OK/)
    expect(log).toContain('Finalizado correctamente: 2 de 2 pasos OK.')
    expect(log).not.toContain('ñandú')
  }, 180_000)

  it('kept a safety backup of the old 8.4 rb_a that restores the old data', async () => {
    const safety = rollbackRun.tasks[0].outputPath
    expect(safety).toBeTruthy()
    expect(safety!.startsWith(join(dir, 'backups', 'Local 8.4', A))).toBe(true)
    expect(safety).toMatch(/-previo-rollback\.nb3$/)
    expect(existsSync(safety!)).toBe(true)
    // rb_b did not exist on 8.4: nothing to save.
    expect(rollbackRun.tasks[1].outputPath).toBeNull()

    const restored = await service.restore({
      backupPath: safety!,
      connectionId: localId,
      targetSchema: A_OLD,
      createSchema: true,
      dropObjectsFirst: true,
      includeStructure: true,
      includeData: true,
      continueOnError: false
    })
    expect(restored.errors).toEqual([])
    const rows = await s84.query<{ id: number; name: string }>(
      `SELECT id, name FROM ${A_OLD}.users ORDER BY id`
    )
    expect(rows.map((r) => r.name)).toEqual(['old-local-1', 'old-local-2', 'old-local-3'])
    const [only] = await s84.query<{ id: number }>(`SELECT id FROM ${A_OLD}.local_only`)
    expect(Number(only.id)).toBe(42)
  }, 120_000)

  it('refuses a scheduled-style run whose restore step targets production', async () => {
    const tasks = [
      {
        id: 'ba',
        type: 'backupschema' as const,
        connectionId: stagingId,
        schema: B,
        referenceName: `Backup ${B}`,
        includeData: true
      },
      {
        id: 'r1',
        type: 'restoreschema' as const,
        connectionId: prodId,
        schema: PROD_GUARD,
        referenceName: 'Restaurar en producción',
        restoreSource: { kind: 'task' as const, taskId: 'ba' },
        safetyBackup: true
      }
    ]
    const input = {
      name: 'Nocturna a producción',
      continueOnError: true,
      tasks,
      schedule: { enabled: true, cron: '0 3 * * *', launchAgent: false }
    }
    // Refused at save...
    expect(() => validateJobInput(input, (id) => ctx.connections.get(id))).toThrow(
      /«Prod 8.4», una conexión de producción/
    )
    // ...and at run time even when stored by other means (an older version, a hand-edited file).
    const job = ctx.jobs.save(input)
    const run = await runJob(ctx, deps, job.id, 'schedule')
    expect(run.tasks.map((t) => t.status)).toEqual(['success', 'failed'])
    expect(run.tasks[1].message).toMatch(/no pueden escribir en producción/)
    const dbs = await s84.query<{ name: string }>(
      'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [PROD_GUARD]
    )
    expect(dbs).toEqual([])
  }, 120_000)

  it('refuses a backup with a damaged data chunk BEFORE dropping anything (8.4 keeps its data)', async () => {
    const before = await tableChecksum(s84, B, 'items')
    const damaged = join(dir, 'damaged.nb3')
    copyFileSync(backupRun.tasks[1].outputPath!, damaged)
    const chunk = (await indexTar(damaged)).find((e) => e.name.endsWith('.data.00000.sql.gz'))!
    const fd = openSync(damaged, 'r+')
    writeSync(fd, Buffer.alloc(64, 0x5a), 0, 64, chunk.offset + Math.floor(chunk.size * 0.3))
    closeSync(fd)
    // The manifest still reads fine: only a full read finds the damage.
    expect((await service.readMeta(damaged)).schema).toBe(B)
    const lines: string[] = []
    await expect(
      service.replace(
        {
          backupPath: damaged,
          expectedSchema: B,
          connectionId: localId,
          targetSchema: B,
          safetyBackup: false,
          continueOnError: false
        },
        { line: (l) => lines.push(l) }
      )
    ).rejects.toThrow(/El backup está dañado.*«rb_b» no se ha modificado en «Local 8.4»/)
    expect(lines.join('\n')).not.toMatch(/Reemplazar base de datos/)
    expect(await tableChecksum(s84, B, 'items')).toEqual(before)
  }, 120_000)

  it('undoes the rollback with the safety copy in REPLACE mode: 8.4 rb_a is exactly the old local one', async () => {
    const safety = rollbackRun.tasks[0].outputPath!
    const result = await service.replace({
      backupPath: safety,
      expectedSchema: A,
      connectionId: localId,
      targetSchema: A,
      safetyBackup: true,
      continueOnError: false
    })
    expect(result.restore.errors).toEqual([])
    // Only the old objects: everything the rollback brought from staging is gone.
    expect(await objectNames(s84, A)).toEqual(['BASE TABLE:local_only', 'BASE TABLE:users'])
    const rows = await s84.query<{ name: string }>(`SELECT name FROM ${A}.users ORDER BY id`)
    expect(rows.map((r) => r.name)).toEqual(['old-local-1', 'old-local-2', 'old-local-3'])
    // ...and undoing kept its own safety copy of the rolled-back state.
    expect(result.safetyBackup?.path).toMatch(/-previo-rollback(-\d+)?\.nb3$/)
    expect(existsSync(result.safetyBackup!.path)).toBe(true)
  }, 180_000)

  it('a 5.7 routine 8.4 refuses (binlog on): the step names it, hints the fix and points to the safety copy', async () => {
    const [{ binlog, trust }] = await s84.query<{ binlog: number; trust: number }>(
      'SELECT @@GLOBAL.log_bin AS binlog, @@GLOBAL.log_bin_trust_function_creators AS trust'
    )
    for (const sql of [
      `DROP DATABASE IF EXISTS ${C}`,
      `CREATE DATABASE ${C}`,
      `CREATE TABLE ${C}.t (id INT PRIMARY KEY)`,
      `INSERT INTO ${C}.t VALUES (1), (2), (3)`,
      `CREATE FUNCTION ${C}.f_nd(x INT) RETURNS INT RETURN x + 1`
    ])
      await s57.execute(sql)
    await s84.execute(`DROP DATABASE IF EXISTS ${C}`)
    await s84.execute(`CREATE DATABASE ${C}`)
    await s84.execute(`CREATE TABLE ${C}.keep (id INT PRIMARY KEY)`)
    const job = ctx.jobs.save({
      name: 'Staging C -> Local',
      continueOnError: true,
      tasks: [
        {
          id: 'bc',
          type: 'backupschema',
          connectionId: stagingId,
          schema: C,
          referenceName: `Backup ${C}`,
          includeData: true
        },
        {
          id: 'rc',
          type: 'restoreschema',
          connectionId: localId,
          schema: '',
          referenceName: `Restaurar ${C}`,
          restoreSource: { kind: 'task', taskId: 'bc' },
          safetyBackup: true
        }
      ],
      schedule: { enabled: false, cron: '', launchAgent: false }
    })
    const run = await runJob(ctx, deps, job.id, 'manual')
    if (Number(binlog) !== 1 || Number(trust) === 1) {
      // The server accepts the routine: nothing to report.
      expect(run.status).toBe('success')
      return
    }
    expect(run.tasks.map((t) => t.status)).toEqual(['success', 'failed'])
    const message = run.tasks[1].message!
    expect(message).toMatch(
      /^1 objeto con error al restaurar «rb_c»: f_nd \(1 objeto, 3 filas restaurados\)\./
    )
    expect(message).toContain('ER_BINLOG_UNSAFE_ROUTINE 1418')
    expect(message).toContain('SET GLOBAL log_bin_trust_function_creators = 1')
    expect(message).toContain('«rb_c» ha quedado incompleta en «Local 8.4».')
    expect(message).toMatch(
      /restaura la copia previa \d{14}-previo-rollback\.nb3 \(Copias de seguridad › Local 8\.4 › rb_c\)/
    )
    const log = readFileSync(run.logPath, 'utf8')
    expect(log).toMatch(/Función f_nd \.+ +ERROR: This function has none of DETERMINISTIC/)
    expect(log).toMatch(/ {4}rb_c en Local 8\.4: \d{14}-previo-rollback\.nb3/)
  }, 180_000)
})
