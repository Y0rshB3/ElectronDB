import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { envVar } from '@main/env'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { getConnectionManager, getSessionFactory } from '@main/mysql/manager'
import type { MysqlSession } from '@main/mysql/types'
import { createBackupService, type BackupService } from '@main/backup/index'

/**
 * «Reemplazar la base de datos completa» with «Solo estructura» on each
 * server version: tables, foreign keys, indexes, view and trigger are created
 * exactly as with data, every table stays empty and AUTO_INCREMENT starts at
 * 1; the default mode still restores the rows and the counters.
 *
 *   ELECTRONDB_TEST_MYSQL_URL=mysql://root:navidog@127.0.0.1:33306/navidog_test     (8.4)
 *   ELECTRONDB_TEST_MYSQL57_URL=mysql://root:navidog@127.0.0.1:33357/navidog_test   (5.7)
 */

const servers = [
  { label: 'MySQL 8.4', url: envVar('TEST_MYSQL_URL') },
  { label: 'MySQL 5.7', url: envVar('TEST_MYSQL57_URL') }
].filter((s): s is { label: string; url: string } => !!s.url)

const SRC = 'rs_src'
const STRUCT = 'rs_struct'
const FULL = 'rs_full'
const TABLES = ['customers', 'orders', 'order_lines']

const SETUP: string[] = [
  `DROP DATABASE IF EXISTS ${SRC}`,
  `DROP DATABASE IF EXISTS ${STRUCT}`,
  `DROP DATABASE IF EXISTS ${FULL}`,
  `CREATE DATABASE ${SRC} CHARACTER SET utf8mb4`,
  // Unqualified names, like a real schema: MySQL keeps a trigger's text as written.
  `USE ${SRC}`,
  `CREATE TABLE ${SRC}.customers (
     id INT NOT NULL AUTO_INCREMENT,
     email VARCHAR(120) NOT NULL,
     name VARCHAR(80) NOT NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uq_customers_email (email)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE ${SRC}.orders (
     id INT NOT NULL AUTO_INCREMENT,
     customer_id INT NOT NULL,
     placed DATETIME NOT NULL,
     PRIMARY KEY (id),
     KEY idx_orders_placed (placed),
     CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE ${SRC}.order_lines (
     id INT NOT NULL AUTO_INCREMENT,
     order_id INT NOT NULL,
     sku VARCHAR(20) NOT NULL,
     qty INT NOT NULL,
     PRIMARY KEY (id),
     KEY idx_lines_sku (sku),
     CONSTRAINT fk_lines_order FOREIGN KEY (order_id) REFERENCES orders (id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // High counters so a restored AUTO_INCREMENT is unmistakable.
  `ALTER TABLE ${SRC}.customers AUTO_INCREMENT = 1000`,
  `INSERT INTO ${SRC}.customers (email, name) VALUES ('a@example.test', 'Ana'), ('b@example.test', 'Bea'), ('c@example.test', 'Carlos')`,
  `INSERT INTO ${SRC}.orders (customer_id, placed) SELECT id, '2026-01-02 10:00:00' FROM ${SRC}.customers`,
  `INSERT INTO ${SRC}.order_lines (order_id, sku, qty) SELECT id, CONCAT('SKU-', id), 2 FROM ${SRC}.orders`,
  `INSERT INTO ${SRC}.order_lines (order_id, sku, qty) SELECT id, CONCAT('SKU-X', id), 5 FROM ${SRC}.orders`,
  `CREATE VIEW v_order_totals AS
     SELECT o.id, c.email, SUM(l.qty) AS units
     FROM orders o JOIN customers c ON c.id = o.customer_id
     JOIN order_lines l ON l.order_id = o.id GROUP BY o.id, c.email`,
  `CREATE TRIGGER customers_bi BEFORE INSERT ON customers
     FOR EACH ROW SET NEW.email = LOWER(NEW.email)`
]

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
    backupDir: join(dir, 'backups', name),
    extraBackupDirs: []
  }
}

async function foreignKeys(session: MysqlSession, schema: string): Promise<string[]> {
  const rows = await session.query<{ v: string }>(
    `SELECT CONCAT(TABLE_NAME, '.', CONSTRAINT_NAME, '->', REFERENCED_TABLE_NAME, ':', DELETE_RULE) AS v
     FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?`,
    [schema]
  )
  return rows.map((r) => r.v).sort()
}

async function indexes(session: MysqlSession, schema: string): Promise<string[]> {
  const rows = await session.query<{ v: string }>(
    `SELECT DISTINCT CONCAT(TABLE_NAME, '.', INDEX_NAME, ':', NON_UNIQUE) AS v
     FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?`,
    [schema]
  )
  return rows.map((r) => r.v).sort()
}

async function objects(session: MysqlSession, schema: string): Promise<string[]> {
  const rows = await session.query<{ v: string }>(
    `SELECT CONCAT(TABLE_TYPE, ':', TABLE_NAME) AS v FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?
     UNION ALL SELECT CONCAT('TRIGGER:', TRIGGER_NAME) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`,
    [schema, schema]
  )
  return rows.map((r) => r.v).sort()
}

async function count(session: MysqlSession, schema: string, table: string): Promise<number> {
  const [row] = await session.query<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM ${session.escapeId(schema)}.${session.escapeId(table)}`
  )
  return Number(row.n)
}

async function createTable(session: MysqlSession, schema: string, table: string): Promise<string> {
  const [row] = await session.query<Record<string, string>>(
    `SHOW CREATE TABLE ${session.escapeId(schema)}.${session.escapeId(table)}`
  )
  return row['Create Table']
}

// Vitest needs at least one case to report the suite as skipped.
const cases = servers.length ? servers : [{ label: 'MySQL', url: '' }]

describe.skipIf(servers.length === 0).each(cases)(
  'replace with «Solo estructura» on $label (integration)',
  ({ url }) => {
    let dir: string
    let ctx: AppContext
    let service: BackupService
    let connectionId: string
    let session: MysqlSession
    let backupPath: string

    beforeAll(async () => {
      const u = new URL(url)
      dir = mkdtempSync(join(tmpdir(), 'electrondb-replace-structure-it-'))
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
      connectionId = ctx.connections.save(connectionInput(u, dir, 'Local')).id
      ctx.credentials.set('mysql', connectionId, decodeURIComponent(u.password))
      const sessions = getSessionFactory(ctx)
      service = createBackupService(ctx, sessions)
      session = await sessions.acquire(connectionId)
      for (const sql of SETUP) await session.execute(sql)
      await session.useSchema(null)
      const created = await service.create({ connectionId, schema: SRC, includeData: true })
      backupPath = created.path
      expect(created.rows).toBe(12)
    }, 120_000)

    afterAll(async () => {
      try {
        for (const db of [SRC, STRUCT, FULL]) await session?.execute(`DROP DATABASE IF EXISTS ${db}`)
      } catch {
        /* best effort */
      }
      await session?.release().catch(() => undefined)
      await getConnectionManager(ctx).closeAll()
      rmSync(dir, { recursive: true, force: true })
    })

    it('creates tables, FKs, indexes, view and trigger with 0 rows and AUTO_INCREMENT from 1', async () => {
      // An existing target with other content: it is replaced (and backed up first).
      await session.execute(`CREATE DATABASE ${STRUCT}`)
      await session.execute(`CREATE TABLE ${STRUCT}.leftover (id INT PRIMARY KEY)`)
      const lines: string[] = []
      const result = await service.replace(
        {
          backupPath,
          expectedSchema: SRC,
          connectionId,
          targetSchema: STRUCT,
          safetyBackup: true,
          continueOnError: false,
          includeData: false
        },
        { line: (l) => lines.push(l) }
      )
      expect(result.includeData).toBe(false)
      expect(result.safetyBackup?.path).toContain('previo-rollback')
      expect(result.restore).toMatchObject({ rowsInserted: 0, errors: [], structureOnly: true })
      expect(result.restore.objectsRestored).toBe(4)
      expect(lines.join('\n')).toContain('Contenido: solo estructura')

      expect(await objects(session, STRUCT)).toEqual(await objects(session, SRC))
      expect(await objects(session, STRUCT)).not.toContain('BASE TABLE:leftover')
      // DELETE_RULE of the default is RESTRICT on 5.7 and NO ACTION on 8.4: compare the names here.
      expect((await foreignKeys(session, STRUCT)).map((fk) => fk.split(':')[0])).toEqual([
        'order_lines.fk_lines_order->orders',
        'orders.fk_orders_customer->customers'
      ])
      expect(await foreignKeys(session, STRUCT)).toEqual(await foreignKeys(session, SRC))
      expect(await indexes(session, STRUCT)).toEqual(await indexes(session, SRC))
      for (const table of TABLES) {
        expect(await count(session, STRUCT, table)).toBe(0)
        expect(await createTable(session, STRUCT, table)).not.toMatch(/AUTO_INCREMENT\s*=/)
      }
      expect(await count(session, STRUCT, 'v_order_totals')).toBe(0)
      // The view reads the replaced schema, not the source one.
      const [view] = await session.query<Record<string, string>>(
        `SHOW CREATE VIEW ${STRUCT}.v_order_totals`
      )
      expect(view['Create View']).not.toContain(SRC)

      // Counters start at 1, the trigger runs and the foreign keys are enforced.
      await session.execute(
        `INSERT INTO ${STRUCT}.customers (email, name) VALUES ('NEW@Example.TEST', 'Nuevo')`
      )
      const [customer] = await session.query<{ id: number; email: string }>(
        `SELECT id, email FROM ${STRUCT}.customers`
      )
      expect(Number(customer.id)).toBe(1)
      expect(customer.email).toBe('new@example.test')
      await session.execute(
        `INSERT INTO ${STRUCT}.orders (customer_id, placed) VALUES (1, '2026-01-01 00:00:00')`
      )
      const [order] = await session.query<{ id: number }>(`SELECT id FROM ${STRUCT}.orders`)
      expect(Number(order.id)).toBe(1)
      await expect(
        session.execute(
          `INSERT INTO ${STRUCT}.orders (customer_id, placed) VALUES (999, '2026-01-01 00:00:00')`
        )
      ).rejects.toThrow(/foreign key constraint fails/i)
    }, 120_000)

    it('the default mode (includeData absent) still restores every row and the counters', async () => {
      const result = await service.replace({
        backupPath,
        expectedSchema: SRC,
        connectionId,
        targetSchema: FULL,
        safetyBackup: true,
        continueOnError: false
      })
      expect(result.includeData).toBe(true)
      expect(result.restore).toMatchObject({ rowsInserted: 12, errors: [] })
      expect(result.restore.structureOnly).toBeUndefined()
      for (const table of TABLES)
        expect(await count(session, FULL, table)).toBe(await count(session, SRC, table))
      expect(await foreignKeys(session, FULL)).toEqual(await foreignKeys(session, SRC))
      expect(await createTable(session, FULL, 'customers')).toMatch(/AUTO_INCREMENT=1003\b/)
    }, 120_000)
  }
)
