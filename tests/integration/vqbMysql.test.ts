/**
 * MySQL 8.4, MySQL 5.7 and MariaDB 11 .vqb backups end to end
 * (docs/vqb-format.md): a seeded schema with foreign keys, views, routines,
 * triggers, an event and every value family is backed up to .vqb (plain and
 * encrypted), restored into another schema and compared table by table
 * (count + md5 of every row's HEX), object by object. Also: a job whose
 * backup step writes an encrypted .vqb with its stored password, a restore
 * step reading it, and «Restaurar todo» (rollback) from that run.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ConnectionInput, JobInput } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { getConnectionManager, getSessionFactory } from '@main/db/manager'
import type { MysqlSession } from '@main/mysql/types'
import { createBackupService, type BackupService } from '@main/backup/index'
import { VqbReader } from '@main/backup/vqb/reader'
import { runJob } from '@main/automation/runner'
import {
  buildRollbackPlan,
  createRollbackInspector,
  prepareRollback
} from '@main/automation/rollback'
import { startJobWith } from '@main/automation/runner'
import { setJobBackupPassword } from '@main/automation/backupKeys'
import { MARIADB_TARGET, describeMysql, describeServer } from './targets'

const CHEAP = { N: 1024, r: 8, p: 1 }

function connectionInput(u: URL, dir: string, name: string): ConnectionInput {
  return {
    name,
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
  }
}

const seed = (src: string, maria: boolean, is57: boolean): string[] => [
  `CREATE DATABASE ${src} CHARACTER SET utf8mb4 COLLATE ${is57 || maria ? 'utf8mb4_unicode_ci' : 'utf8mb4_0900_ai_ci'}`,
  `USE ${src}`,
  `CREATE TABLE customers (
     id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     name VARCHAR(80) NOT NULL,
     kind ENUM('a','b','c') NULL,
     flags SET('x','y','z') NULL,
     doc JSON NULL,
     bin VARBINARY(40) NULL,
     blobby MEDIUMBLOB NULL,
     bits BIT(10) NULL,
     price DECIMAL(30,10) NULL,
     big BIGINT UNSIGNED NULL,
     small TINYINT NULL,
     yr YEAR NULL,
     f FLOAT NULL,
     d DOUBLE NULL,
     dt DATETIME(6) NULL,
     ts TIMESTAMP(3) NULL DEFAULT NULL,
     tm TIME(2) NULL,
     dd DATE NULL,
     note TEXT NULL,
     twice INT AS (small * 2) STORED,
     KEY idx_name (name)
   ) ENGINE=InnoDB`,
  `INSERT INTO customers (name, kind, flags, doc, bin, blobby, bits, price, big, small, yr, f, d, dt, ts, tm, dd, note)
   SELECT CONCAT('cliente ', n, ' ñandú 😀'),
          ELT(1 + n % 3, 'a', 'b', 'c'),
          IF(n % 4 = 0, NULL, 'x,z'),
          IF(n % 6 = 0, NULL, JSON_OBJECT('n', n, 'big', 12345678901234567, 's', CONCAT('q"''\\\\', n))),
          UNHEX(CONCAT('00', LPAD(HEX(n), 8, '0'), '1A0D0A27')),
          IF(n % 9 = 0, NULL, REPEAT(UNHEX('00FF'), 300 + n)),
          b'1010101010' >> (n % 5),
          n * 1.0000000001,
          18446744073709551615 - n,
          -128 + n % 256,
          1901 + n % 254,
          n / 7,
          n / 3,
          DATE_ADD('2026-03-29 01:30:00.123456', INTERVAL n MINUTE),
          DATE_ADD('2026-03-29 01:30:00.125', INTERVAL n MINUTE),
          SEC_TO_TIME(n * 37),
          DATE_ADD('2000-02-29', INTERVAL n DAY),
          CONCAT(REPEAT('x', 200), '\\n\\r\\t''"\\\\ \\0 fin ', n)
   FROM (SELECT a.n + b.n * 10 + c.n * 100 + 1 AS n FROM
          (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a,
          (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b,
          (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) c) seq`,
  `INSERT INTO customers (name) VALUES ('vacío')`,
  `CREATE TABLE orders (
     id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
     customer_id INT UNSIGNED NOT NULL,
     total DECIMAL(12,2) NOT NULL,
     note VARCHAR(20) NULL,
     CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
   ) ENGINE=InnoDB`,
  `INSERT INTO orders (customer_id, total) SELECT 1 + id % 100, id * 2.5 FROM customers WHERE id <= 600`,
  `CREATE TRIGGER orders_bi BEFORE INSERT ON orders FOR EACH ROW SET NEW.note = COALESCE(NEW.note, 'auto')`,
  `CREATE VIEW v_big AS SELECT id, name FROM customers WHERE price > 500`,
  `CREATE VIEW v_big_count AS SELECT COUNT(*) AS n FROM v_big`,
  `CREATE FUNCTION f_total(cid INT) RETURNS DECIMAL(14,2) READS SQL DATA RETURN (SELECT COALESCE(SUM(total), 0) FROM orders WHERE customer_id = cid)`,
  `CREATE PROCEDURE p_noop() BEGIN END`,
  `CREATE EVENT e_tick ON SCHEDULE EVERY 1 DAY DISABLE DO DELETE FROM orders WHERE total < 0`
]

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

function suite(url: string, label: string, maria: boolean, is57: boolean): void {
  const tag = `${label.replace(/\W+/g, '').toLowerCase()}_${process.pid}`
  const SRC = `vqb_src_${tag}`
  const DST = `vqb_dst_${tag}`
  const DST_ENC = `vqb_enc_${tag}`
  const JOB_DST = `vqb_job_${tag}`
  const ROLLBACK_DST = SRC
  let dir: string
  let ctx: AppContext
  let service: BackupService
  let id: string
  let otherId: string
  let admin: MysqlSession
  let plainPath: string

  const compare = async (target: string): Promise<void> => {
    for (const table of ['customers', 'orders']) {
      expect(await tableChecksum(admin, target, table), `${target}.${table}`).toEqual(
        await tableChecksum(admin, SRC, table)
      )
    }
    const objects = async (schema: string): Promise<string[]> => {
      const routines = await admin.query<{ n: string }>(
        `SELECT CONCAT(ROUTINE_TYPE, ':', ROUTINE_NAME) AS n FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?`,
        [schema]
      )
      const triggers = await admin.query<{ n: string }>(
        `SELECT CONCAT('TRIGGER:', TRIGGER_NAME) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`,
        [schema]
      )
      const events = await admin.query<{ n: string }>(
        `SELECT CONCAT('EVENT:', EVENT_NAME, ':', STATUS) AS n FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?`,
        [schema]
      )
      const views = await admin.query<{ n: string }>(
        `SELECT CONCAT('VIEW:', TABLE_NAME) AS n FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?`,
        [schema]
      )
      const fks = await admin.query<{ n: string }>(
        `SELECT CONCAT('FK:', CONSTRAINT_NAME) AS n FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?`,
        [schema]
      )
      return [...routines, ...triggers, ...events, ...views, ...fks].map((r) => String(r.n)).sort()
    }
    expect(await objects(target)).toEqual(await objects(SRC))
    const [fn] = await admin.query<{ v: string }>(`SELECT ${target}.f_total(2) AS v`)
    const [srcFn] = await admin.query<{ v: string }>(`SELECT ${SRC}.f_total(2) AS v`)
    expect(String(fn.v)).toBe(String(srcFn.v))
    const ai = async (schema: string): Promise<string | undefined> => {
      const [create] = await admin.query<Record<string, string>>(
        `SHOW CREATE TABLE ${schema}.orders`
      )
      return /AUTO_INCREMENT=(\d+)/.exec(create['Create Table'])?.[1]
    }
    expect(await ai(target)).toBe(await ai(SRC))
  }

  beforeAll(async () => {
    const u = new URL(url)
    dir = mkdtempSync(join(tmpdir(), 'vortaq-vqb-my-'))
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
    id = ctx.connections.save(connectionInput(u, dir, 'Origen VQB')).id
    ctx.credentials.set('mysql', id, decodeURIComponent(u.password))
    otherId = ctx.connections.save(connectionInput(u, dir, 'Destino VQB')).id
    ctx.credentials.set('mysql', otherId, decodeURIComponent(u.password))
    const sessions = getSessionFactory(ctx)
    service = createBackupService(ctx, sessions, { scrypt: CHEAP })
    admin = await sessions.acquire(id)
    await admin.execute('SET SESSION group_concat_max_len = 67108864')
    for (const db of [SRC, DST, DST_ENC, JOB_DST])
      await admin.execute(`DROP DATABASE IF EXISTS ${db}`)
    for (const sql of seed(SRC, maria, is57)) await admin.execute(sql)
    await admin.useSchema(null)
  }, 120_000)

  afterAll(async () => {
    try {
      for (const db of [SRC, DST, DST_ENC, JOB_DST])
        await admin.execute(`DROP DATABASE IF EXISTS ${db}`)
    } catch {
      /* best effort */
    }
    await admin?.release().catch(() => undefined)
    await getConnectionManager(ctx).closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('backs up to .vqb with typed values and restores an identical schema', async () => {
    const result = await service.create({
      connectionId: id,
      schema: SRC,
      includeData: true,
      format: 'vqb',
      label: 'it'
    })
    plainPath = result.path
    expect(result.path.endsWith('-it.vqb')).toBe(true)
    expect(result.rows).toBe(1001 + 600)
    const reader = await VqbReader.open(result.path)
    try {
      const m = await reader.manifest()
      expect(m.engine).toMatchObject({ id: 'mysql', flavor: maria ? 'mariadb' : 'mysql' })
      expect(m.source).toMatchObject({ database: SRC, charset: 'utf8mb4', timeZone: '+00:00' })
      expect(m.objects.map((o) => `${o.type}:${o.name}`)).toEqual([
        'table:customers',
        'table:orders',
        'view:v_big',
        'view:v_big_count',
        'function:f_total',
        'procedure:p_noop',
        'event:e_tick'
      ])
      expect((await reader.verify()).rows).toBe(1601)
    } finally {
      await reader.close()
    }
    const restored = await service.restore({
      backupPath: plainPath,
      connectionId: id,
      targetSchema: DST,
      createSchema: true,
      dropObjectsFirst: true,
      includeStructure: true,
      includeData: true,
      continueOnError: false
    })
    expect(restored.errors).toEqual([])
    expect(restored.rowsInserted).toBe(1601)
    await compare(DST)
  }, 180_000)

  it('encrypts with a password, refuses a wrong one before touching the server and restores', async () => {
    const result = await service.create({
      connectionId: id,
      schema: SRC,
      includeData: true,
      format: 'vqb',
      password: 'mysql secreto'
    })
    expect(readFileSync(result.path).includes(Buffer.from('customers'))).toBe(false)
    const restore = (password?: string) =>
      service.restore({
        backupPath: result.path,
        connectionId: id,
        targetSchema: DST_ENC,
        createSchema: true,
        dropObjectsFirst: true,
        includeStructure: true,
        includeData: true,
        continueOnError: false,
        password
      })
    await expect(restore('no es esta')).rejects.toThrow('Contraseña incorrecta')
    const [none] = await admin.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [DST_ENC]
    )
    expect(Number(none.n)).toBe(0)
    expect((await restore('mysql secreto')).errors).toEqual([])
    await compare(DST_ENC)
  }, 180_000)

  it('runs a job: encrypted .vqb backup with the stored password, then a restore step; rollback from the run', async () => {
    const input: JobInput = {
      name: 'Copia cifrada VQB',
      continueOnError: false,
      schedule: { enabled: false, cron: '', launchAgent: false },
      tasks: [
        {
          id: 'b1',
          type: 'backupschema',
          connectionId: id,
          schema: SRC,
          referenceName: 'Copiar origen',
          includeData: true,
          format: 'vqb',
          encrypt: true
        },
        {
          id: 'r1',
          type: 'restoreschema',
          connectionId: otherId,
          schema: JOB_DST,
          referenceName: 'Restaurar en destino',
          restoreSource: { kind: 'task', taskId: 'b1' },
          safetyBackup: true,
          includeData: true
        }
      ]
    }
    const job = ctx.jobs.save(input)
    setJobBackupPassword(ctx, job.id, 'clave del trabajo')
    const deps = { sessions: getSessionFactory(ctx), backups: service }
    const run = await runJob(ctx, deps, job.id, 'manual')
    expect(run.status, run.tasks.map((t) => t.message).join(' / ')).toBe('success')
    const backupFile = run.tasks[0].outputPath!
    expect(backupFile.endsWith('.vqb')).toBe(true)
    expect((await service.readMeta(backupFile)).locked).toBe(true)
    await compare(JOB_DST)
    const log = readFileSync(run.logPath, 'utf8')
    expect(log).toContain('cifrada')
    expect(log).not.toContain('clave del trabajo')

    // «Restaurar todo» of that run over the source schema: the stored job key opens it.
    await admin.execute(`DELETE FROM ${ROLLBACK_DST}.orders WHERE id % 2 = 0`)
    const inspector = createRollbackInspector(ctx, () => getSessionFactory(ctx))
    const plan = await buildRollbackPlan(ctx, run.id, id, inspector)
    expect(plan.items[0]).toMatchObject({ problem: null, encrypted: true, locked: false })
    const prepared = prepareRollback(
      ctx,
      plan,
      { runId: run.id, targetConnectionId: id, taskIds: ['b1'], safetyBackup: true },
      ctx.connections.get(id)!,
      false
    )
    const rollback = await startJobWith(ctx, deps, prepared.job, 'manual', prepared.options).done
    expect(rollback.status, rollback.tasks.map((t) => t.message).join(' / ')).toBe('success')
    const safety = rollback.tasks[0].outputPath!
    expect(safety.endsWith('-previo-rollback.vqb')).toBe(true)
    expect(existsSync(safety)).toBe(true)
    const [count] = await admin.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${ROLLBACK_DST}.orders`
    )
    expect(Number(count.n)).toBe(600)
  }, 240_000)
}

describeMysql('.vqb backups of MySQL (integration)', ({ url, label, is57 }) =>
  suite(url, label, false, is57)
)
describeServer(MARIADB_TARGET, '.vqb backups of MySQL (integration)', (url) =>
  suite(url, 'MariaDB 11', true, false)
)
