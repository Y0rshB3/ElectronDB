import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { envVar } from '@main/env'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { getConnectionManager, getSessionFactory } from '@main/mysql/manager'
import type { MysqlSession, SessionFactory } from '@main/mysql/types'
import { createBackupService } from '@main/backup/index'
import { exportSchemaToSql } from '@main/backup/sqlExport'
import { runJob } from '@main/automation/runner'
import { describeMysql } from './targets'

/**
 * «Exportar a .sql» round trip: a seeded schema with every awkward type and
 * object kind is exported with exportSchemaToSql, then imported with the
 * server container's own `mysql` client, and both databases must hold the
 * same rows (COUNT + CHECKSUM TABLE) and the same objects.
 *
 *   VORTAQ_TEST_MYSQL_URL / VORTAQ_TEST_MYSQL57_URL as for the other suites;
 *   containers: VORTAQ_TEST_MYSQL_CONTAINER (default navidog-test-mysql) and
 *   VORTAQ_TEST_MYSQL57_CONTAINER (default electrondb-test-mysql57-1).
 */

const SRC = 'sqlexp_src'
const DST = 'sqlexp_dst'
const DST_GZ = 'sqlexp_dst_gz'
const DST_JOB = 'sqlexp_dst_job'
const TABLES = ['customers', 'orders', 'types']

const SEED = [
  `DROP DATABASE IF EXISTS ${SRC}`,
  `CREATE DATABASE ${SRC} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE ${SRC}.customers (
     id INT PRIMARY KEY AUTO_INCREMENT,
     name VARCHAR(80) NOT NULL,
     note TEXT NULL,
     full_name VARCHAR(100) GENERATED ALWAYS AS (CONCAT(name, '!')) VIRTUAL
   ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE ${SRC}.orders (
     id INT PRIMARY KEY,
     customer_id INT NOT NULL,
     total DECIMAL(20,6) NOT NULL,
     CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES ${SRC}.customers (id)
   ) DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE ${SRC}.types (
     id INT PRIMARY KEY,
     big BIGINT UNSIGNED NULL,
     bin BLOB NULL,
     dt DATETIME(6) NULL,
     ts TIMESTAMP NULL,
     d DATE NULL,
     t TIME NULL,
     b BIT(3) NULL,
     j JSON NULL
   ) DEFAULT CHARSET=utf8mb4`,
  `INSERT INTO ${SRC}.customers (id, name, note) VALUES
     (1, 'ñandú 😀', 'línea ''1''\\n"dos"\\\\ fin'),
     (2, 'b', NULL),
     (3, 'semi;colon -- not a comment', '/* nor this */ # or this')`,
  `INSERT INTO ${SRC}.orders VALUES (1, 1, 12345678901234.123456), (2, 1, -0.000001), (3, 3, 0)`,
  `INSERT INTO ${SRC}.types VALUES
     (1, 18446744073709551615, 0x00FF00DEADBEEF00, '2026-03-17 14:51:20.123456', '2026-03-17 14:51:20',
      '1999-12-31', '-838:59:59', b'101', '{"a": [1, "x"], "b": null}'),
     (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
     (3, 0, '', '1970-01-01 00:00:01.000001', '2038-01-19 03:14:07', '2000-02-29', '12:00:00', b'000', '[]')`,
  `CREATE VIEW ${SRC}.b_base AS SELECT id, name FROM ${SRC}.customers`,
  `CREATE VIEW ${SRC}.a_top AS SELECT id FROM ${SRC}.b_base WHERE id > 1`,
  `CREATE FUNCTION ${SRC}.f_double(x INT) RETURNS INT DETERMINISTIC NO SQL RETURN x * 2`,
  `CREATE PROCEDURE ${SRC}.p_count(OUT n INT) READS SQL DATA BEGIN SELECT COUNT(*) INTO n FROM customers; SELECT n; END`,
  // Qualified on purpose: 5.7 keeps the typed text in SHOW CREATE TRIGGER.
  `CREATE TRIGGER ${SRC}.customers_bi BEFORE INSERT ON ${SRC}.customers FOR EACH ROW BEGIN SET NEW.note = CONCAT(IFNULL(NEW.note, ''), ';'); END`,
  `CREATE EVENT ${SRC}.e_daily ON SCHEDULE EVERY 1 DAY STARTS '2030-01-01 00:00:00' DO DELETE FROM orders WHERE id < 0`
]

function connectionInput(u: URL, dir: string): ConnectionInput {
  return {
    name: 'Export IT',
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

describeMysql('export to .sql re-imported with the mysql client (integration)', (target) => {
  let dir: string
  let ctx: AppContext
  let sessions: SessionFactory
  let connectionId: string
  let admin: MysqlSession
  let user = ''
  let password = ''
  const container = target.is57
    ? envVar('TEST_MYSQL57_CONTAINER')?.trim() || 'electrondb-test-mysql57-1'
    : envVar('TEST_MYSQL_CONTAINER')?.trim() || 'navidog-test-mysql'

  /** Runs `sql` through the container's own mysql client into `db`. */
  const mysqlClient = (db: string, sql: Buffer): void => {
    execFileSync('docker', ['exec', '-i', container, 'mysql', `-u${user}`, `-p${password}`, db], {
      input: sql,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024
    })
  }

  const recreate = async (db: string): Promise<void> => {
    await admin.execute(`DROP DATABASE IF EXISTS ${db}`)
    await admin.execute(`CREATE DATABASE ${db} CHARACTER SET utf8mb4`)
  }

  async function fingerprint(db: string): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {}
    for (const table of TABLES) {
      const [count] = await admin.query<{ n: unknown }>(
        `SELECT COUNT(*) AS n FROM \`${db}\`.\`${table}\``
      )
      // 5.7 split: CHECKSUM TABLE of a table with a JSON column changes every time the table
      // is reopened on 5.7 (same rows, different value); the content digest below covers it.
      if (target.is57 && table === 'types') {
        out[table] = [String(count.n)]
        continue
      }
      const [sum] = await admin.query<{ Checksum: unknown }>(
        `CHECKSUM TABLE \`${db}\`.\`${table}\``
      )
      out[table] = [String(count.n), String(sum.Checksum)]
    }
    const [digest] = await admin.query<{ d: unknown }>(
      `SELECT MD5(GROUP_CONCAT(CONCAT_WS('|', id, IFNULL(big, 'N'), IFNULL(HEX(bin), 'N'),
         IFNULL(dt, 'N'), IFNULL(ts, 'N'), IFNULL(d, 'N'), IFNULL(t, 'N'), IFNULL(HEX(b), 'N'),
         IFNULL(CAST(j AS CHAR), 'N')) ORDER BY id SEPARATOR '#')) AS d FROM \`${db}\`.types`
    )
    out.typesDigest = String(digest.d)
    const names = async (sql: string): Promise<string[]> =>
      (await admin.query<{ n: unknown }>(sql, [db])).map((r) => String(r.n)).sort()
    out.tables = await names(
      'SELECT CONCAT(TABLE_TYPE, ":", TABLE_NAME) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?'
    )
    out.routines = await names(
      'SELECT CONCAT(ROUTINE_TYPE, ":", ROUTINE_NAME) AS n FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?'
    )
    out.triggers = await names(
      'SELECT TRIGGER_NAME AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?'
    )
    out.events = await names(
      'SELECT EVENT_NAME AS n FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?'
    )
    out.fks = await names(
      'SELECT CONSTRAINT_NAME AS n FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?'
    )
    return out
  }

  beforeAll(async () => {
    const u = new URL(target.url)
    user = decodeURIComponent(u.username)
    password = decodeURIComponent(u.password)
    dir = mkdtempSync(join(tmpdir(), 'vortaq-sqlexport-it-'))
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
    connectionId = ctx.connections.save(connectionInput(u, dir)).id
    ctx.credentials.set('mysql', connectionId, password)
    sessions = getSessionFactory(ctx)
    admin = await sessions.acquire(connectionId)
    for (const sql of SEED) await admin.execute(sql)
  }, 120_000)

  afterAll(async () => {
    try {
      for (const db of [SRC, DST, DST_GZ, DST_JOB])
        await admin?.execute(`DROP DATABASE IF EXISTS ${db}`)
    } catch {
      /* best effort */
    }
    await admin?.release().catch(() => undefined)
    await getConnectionManager(ctx).closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('exports every object and value; the mysql client rebuilds an identical database', async () => {
    const result = await exportSchemaToSql(
      { connections: ctx.connections, sessions },
      {
        connectionId,
        schema: SRC,
        includeStructure: true,
        includeData: true,
        includeCreateDatabase: false
      }
    )
    expect(result.path).toMatch(/\.sql$/)
    // 3 tables, 2 views, 1 function, 1 procedure, 1 event (the trigger goes with its table).
    expect(result.objects).toBe(8)
    expect(result.rows).toBe(9)
    const sql = readFileSync(result.path)
    // Nothing but the header names the source database: the dump imports anywhere.
    const code = sql
      .toString('utf8')
      .split('\n')
      .filter((l) => !l.startsWith('--'))
    expect(code.filter((l) => l.includes(SRC))).toEqual([])

    await recreate(DST)
    mysqlClient(DST, sql)
    expect(await fingerprint(DST)).toEqual(await fingerprint(SRC))
    // Routines, views and the trigger work in the copy.
    const [{ v }] = await admin.query<{ v: unknown }>(`SELECT ${DST}.f_double(21) AS v`)
    expect(Number(v)).toBe(42)
    const top = await admin.query<{ id: unknown }>(`SELECT id FROM ${DST}.a_top ORDER BY id`)
    expect(top.map((r) => Number(r.id))).toEqual([2, 3])
    await admin.execute(`INSERT INTO ${DST}.customers (id, name) VALUES (9, 'trigger')`)
    const [{ note }] = await admin.query<{ note: unknown }>(
      `SELECT note FROM ${DST}.customers WHERE id = 9`
    )
    expect(note).toBe(';')
    // TIMESTAMP text is identical (UTC in the dump, session time zone when read).
    const ts = async (db: string) =>
      (await admin.query<{ ts: unknown }>(`SELECT ts FROM ${db}.types ORDER BY id`)).map((r) =>
        r.ts === null ? null : String(r.ts)
      )
    expect(await ts(DST)).toEqual(await ts(SRC))
  }, 120_000)

  it('gzip export with CREATE DATABASE imports into the database named in the file', async () => {
    const result = await exportSchemaToSql(
      { connections: ctx.connections, sessions },
      {
        connectionId,
        schema: SRC,
        includeStructure: true,
        includeData: true,
        includeCreateDatabase: false,
        gzip: true
      }
    )
    expect(result.path).toMatch(/\.sql\.gz$/)
    await recreate(DST_GZ)
    mysqlClient(DST_GZ, gunzipSync(readFileSync(result.path)))
    expect(await fingerprint(DST_GZ)).toEqual(await fingerprint(SRC))

    const withDb = await exportSchemaToSql(
      { connections: ctx.connections, sessions },
      {
        connectionId,
        schema: SRC,
        includeStructure: true,
        includeData: false,
        includeCreateDatabase: true,
        objects: ['types']
      }
    )
    const text = readFileSync(withDb.path, 'utf8')
    expect(text).toMatch(
      /CREATE DATABASE \/\*!32312 IF NOT EXISTS\*\/ `sqlexp_src` \/\*!40100 DEFAULT CHARACTER SET utf8mb4/
    )
    expect(text).toContain('USE `sqlexp_src`;')
    expect(text).not.toContain('INSERT INTO')
  }, 120_000)

  it('a job step with «Formato: .sql» writes a dump the client can import', async () => {
    const job = ctx.jobs.save({
      name: 'Export sql',
      continueOnError: false,
      tasks: [
        {
          id: 'b1',
          type: 'backupschema',
          connectionId,
          schema: SRC,
          referenceName: `Backup ${SRC}`,
          includeData: true,
          format: 'sql'
        }
      ],
      schedule: { enabled: false, cron: '', launchAgent: false }
    })
    const run = await runJob(
      ctx,
      { backups: createBackupService(ctx, sessions), sessions },
      job.id,
      'manual'
    )
    expect(run.status).toBe('success')
    const output = run.tasks[0].outputPath!
    expect(output).toMatch(new RegExp(`${SRC}[\\\\/]\\d{14}-export-sql\\.sql$`))
    expect(existsSync(output)).toBe(true)
    await recreate(DST_JOB)
    mysqlClient(DST_JOB, readFileSync(output))
    expect(await fingerprint(DST_JOB)).toEqual(await fingerprint(SRC))
  }, 120_000)
})
