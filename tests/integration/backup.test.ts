import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ConnectionInput, ProgressEvent } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { getConnectionManager, getSessionFactory } from '@main/mysql/manager'
import type { MysqlSession } from '@main/mysql/types'
import { createBackupService, type BackupService } from '@main/backup/index'
import { Nb3Reader } from '@main/backup/nb3/reader'
import { PRODUCTION_GUARD_MESSAGE } from '@main/backup/restore'
import { describeMysql } from './targets'

/**
 * End-to-end .nb3 backup/restore against a throwaway MySQL server
 * (VORTAQ_TEST_MYSQL_URL, e.g. mysql://root:navidog@127.0.0.1:33306/navidog_test, and
 * VORTAQ_TEST_MYSQL57_URL, e.g. mysql://root:navidog@127.0.0.1:33357/navidog_test).
 */

const SRC = 'nb_src'
const DST = 'nb_dst'
const FX = 'nb_fx'
const PROD_TARGET = 'nb_prod_guard'
const GEO_SRC = 'nb_geo_src'
const GEO_DST = 'nb_geo_dst'
const ROWS = 12000
const FIXTURE = resolve('tests/fixtures/navicat/backups/demo/20260317144801-fixture.nb3')

function connectionInput(
  u: URL,
  dir: string,
  overrides: Partial<ConnectionInput> = {}
): ConnectionInput {
  return {
    name: 'Backup IT',
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
    extraBackupDirs: [],
    ...overrides
  }
}

const DIGITS =
  '(SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)'

// 5.7 split: utf8mb4_0900_ai_ci is new in 8.0; 5.7 uses the closest Unicode collation it has.
const setupSql = (is57: boolean): string[] => [
  `CREATE DATABASE ${SRC} CHARACTER SET utf8mb4 COLLATE ${is57 ? 'utf8mb4_unicode_ci' : 'utf8mb4_0900_ai_ci'}`,
  `USE ${SRC}`,
  `CREATE TABLE items (
     id INT NOT NULL AUTO_INCREMENT,
     name VARCHAR(100) NOT NULL,
     doc JSON NULL,
     bin BLOB NULL,
     created DATETIME(3) NULL,
     price DECIMAL(14,2) NULL,
     big BIGINT UNSIGNED NULL,
     note TEXT NULL,
     price_x2 DECIMAL(15,2) GENERATED ALWAYS AS (price * 2) STORED,
     PRIMARY KEY (id),
     KEY idx_name (name)
   ) ENGINE=InnoDB`,
  `INSERT INTO items (name, doc, bin, created, price, big, note)
   SELECT CONCAT('ñandú 😀 ', n),
          IF(n % 7 = 0, NULL, JSON_OBJECT('n', n, 's', CONCAT('q"''\\\\', n), 'arr', JSON_ARRAY(1, 2, n))),
          IF(n % 11 = 0, NULL, UNHEX(CONCAT('00', SHA2(n, 256), '1A0D0A27'))),
          DATE_ADD('2026-01-01 00:00:00.000', INTERVAL n * 1001 MICROSECOND),
          n * 1.25,
          18446744073709551615 - n,
          CONCAT(REPEAT('x', 480), '\\n\\r\\t''"\\\\ \\0 fin ', n)
   FROM (SELECT a.d + b.d * 10 + c.d * 100 + e.d * 1000 + f.d * 10000 + 1 AS n
         FROM ${DIGITS} a CROSS JOIN ${DIGITS} b CROSS JOIN ${DIGITS} c CROSS JOIN ${DIGITS} e CROSS JOIN ${DIGITS} f) seq
   WHERE n <= ${ROWS}`,
  `CREATE TABLE empty_one (id INT PRIMARY KEY, label VARCHAR(10)) ENGINE=InnoDB`,
  `CREATE TRIGGER items_bu BEFORE UPDATE ON items FOR EACH ROW SET NEW.note = CONCAT(NEW.note, '')`,
  `CREATE VIEW v_items AS SELECT id, name FROM items WHERE price > 100`,
  `CREATE FUNCTION f_double(x INT) RETURNS INT DETERMINISTIC NO SQL RETURN x * 2`
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

describeMysql('backup module (integration)', ({ url, is57 }) => {
  let dir: string
  let ctx: AppContext
  let service: BackupService
  let connectionId: string
  let prodId: string
  let admin: MysqlSession
  let backupPath: string

  const dropAll = async (): Promise<void> => {
    for (const db of [SRC, DST, FX, PROD_TARGET, GEO_SRC, GEO_DST])
      await admin.execute(`DROP DATABASE IF EXISTS ${db}`)
  }

  beforeAll(async () => {
    const u = new URL(url)
    dir = mkdtempSync(join(tmpdir(), 'vortaq-backup-it-'))
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
    ctx.credentials.set('mysql', connectionId, decodeURIComponent(u.password))
    prodId = ctx.connections.save(
      connectionInput(u, dir, { name: 'Backup IT prod', environment: 'production' })
    ).id
    ctx.credentials.set('mysql', prodId, decodeURIComponent(u.password))

    const sessions = getSessionFactory(ctx)
    service = createBackupService(ctx, sessions)
    admin = await sessions.acquire(connectionId)
    await admin.execute('SET SESSION group_concat_max_len = 67108864')
    await dropAll()
    for (const sql of setupSql(is57)) await admin.execute(sql)
    // 5.7 split: 5.7 has no information_schema_stats_expiry (withFreshStats skips it), and
    // TABLE_ROWS can come from InnoDB's persisted statistics, which a background thread
    // refreshes at most every 10 s after a bulk load. Under parallel load the backup then
    // saw a stale estimate of 0 rows for a table filled a moment ago. ANALYZE TABLE brings
    // the fixture to the settled state any real table has; 8.4 keeps relying on stats
    // expiry 0, which is what the estimate assertion below checks there.
    if (is57) await admin.query(`ANALYZE TABLE ${SRC}.items`)
    await admin.useSchema(null)
  }, 120_000)

  afterAll(async () => {
    try {
      await dropAll()
    } catch {
      /* best effort */
    }
    await admin?.release().catch(() => undefined)
    await getConnectionManager(ctx).closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a multi-chunk .nb3 with every object type', async () => {
    const progress: string[] = []
    const details: NonNullable<ProgressEvent['detail']>[] = []
    const result = await service.create(
      { connectionId, schema: SRC, includeData: true, label: 'it' },
      (e) => {
        progress.push(e.phase)
        if (e.detail) details.push(e.detail)
      }
    )
    // Fresh InnoDB estimates (stats expiry 0) weight the progress: the bar moves inside items.
    const itemsStart = details.find((d) => d.objectName === 'items' && d.rows === 0)
    expect(itemsStart?.rowsEstimate).toBeGreaterThan(0)
    expect(details[0].workTotal).toBeGreaterThan(4)
    expect(details.at(-1)?.workDone).toBeCloseTo(details[0].workTotal!, 5)
    backupPath = result.path
    expect(result.path.startsWith(join(dir, 'backups', SRC))).toBe(true)
    expect(result.rows).toBe(ROWS)
    expect(result.objects).toBe(4)
    expect(progress).toContain('object')
    // Per-object completion events feed the automation run log.
    expect(progress.filter((p) => p === 'objectDone')).toHaveLength(4)
    expect(progress[0]).toBe('list')

    const meta = await service.readMeta(result.path)
    expect(meta.objects.map((o) => `${o.type}:${o.name}`)).toEqual([
      'Table:empty_one',
      'Table:items',
      'View:v_items',
      'Function:f_double'
    ])
    const reader = await Nb3Reader.open(result.path)
    const items = await reader.objectMeta(meta.objects[1].uuid)
    expect(items.Data.length).toBeGreaterThanOrEqual(2)
    expect(items.Fields).not.toContain('price_x2')
    // INSERT ... SELECT reserves ids in bulk, so compare with the server's own value.
    const [srcCreate] = await admin.query<Record<string, string>>(`SHOW CREATE TABLE ${SRC}.items`)
    expect(srcCreate['Create Table']).toContain(`AUTO_INCREMENT=${items.AutoIncrement}`)
    expect(Number(items.AutoIncrement)).toBeGreaterThan(ROWS)
    expect(items.TriggerDDL).toHaveLength(1)

    const listed = await service.list(connectionId, SRC)
    expect(listed.map((f) => f.path)).toContain(result.path)
  }, 120_000)

  it('restores into another schema with identical data, objects and AUTO_INCREMENT', async () => {
    const result = await service.restore({
      backupPath,
      connectionId,
      targetSchema: DST,
      createSchema: true,
      dropObjectsFirst: true,
      includeStructure: true,
      includeData: true,
      continueOnError: false
    })
    expect(result.errors).toEqual([])
    expect(result.rowsInserted).toBe(ROWS)
    expect(result.objectsRestored).toBe(4)

    for (const table of ['items', 'empty_one']) {
      const src = await tableChecksum(admin, SRC, table)
      const dst = await tableChecksum(admin, DST, table)
      expect(dst).toEqual(src)
    }
    expect((await tableChecksum(admin, DST, 'items')).count).toBe(ROWS)

    const [view] = await admin.query<{ c: number }>(`SELECT COUNT(*) AS c FROM ${DST}.v_items`)
    const [srcView] = await admin.query<{ c: number }>(`SELECT COUNT(*) AS c FROM ${SRC}.v_items`)
    expect(Number(view.c)).toBe(Number(srcView.c))
    const [fn] = await admin.query<{ v: number }>(`SELECT ${DST}.f_double(21) AS v`)
    expect(Number(fn.v)).toBe(42)
    const triggers = await admin.query<{ name: string }>(
      'SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?',
      [DST]
    )
    expect(triggers.map((t) => t.name)).toEqual(['items_bu'])
    const autoIncrement = async (schema: string): Promise<string | undefined> => {
      const [create] = await admin.query<Record<string, string>>(
        `SHOW CREATE TABLE ${schema}.items`
      )
      return /AUTO_INCREMENT=(\d+)/.exec(create['Create Table'])?.[1]
    }
    expect(await autoIncrement(DST)).toBe(await autoIncrement(SRC))
    // The view must point at the restored schema, not at the source one.
    const [viewDef] = await admin.query<Record<string, string>>(`SHOW CREATE VIEW ${DST}.v_items`)
    expect(viewDef['Create View']).not.toContain(SRC)

    // Session state is restored on the pooled connection.
    const s = await getSessionFactory(ctx).acquire(connectionId)
    try {
      const [vars] = await s.query<{ fk: number; uq: number }>(
        'SELECT @@SESSION.foreign_key_checks AS fk, @@SESSION.unique_checks AS uq'
      )
      expect(Number(vars.fk)).toBe(1)
      expect(Number(vars.uq)).toBe(1)
    } finally {
      await s.release()
    }
  }, 180_000)

  it('round-trips GEOMETRY columns (POINT with SRID, POLYGON, NULL) byte for byte', async () => {
    await admin.execute(`CREATE DATABASE ${GEO_SRC}`)
    // 5.7 split: the SRID column attribute is new in 8.0. On 5.7 the SRID lives only in each
    // value (ST_GeomFromText(..., 4326)), which the byte-for-byte and ST_SRID checks still cover.
    await admin.execute(
      `CREATE TABLE ${GEO_SRC}.places (
         id INT PRIMARY KEY,
         pt POINT NULL,
         loc POINT NOT NULL${is57 ? '' : ' SRID 4326'},
         area POLYGON NULL
       ) ENGINE=InnoDB`
    )
    await admin.execute(
      `INSERT INTO ${GEO_SRC}.places VALUES
         (1, ST_GeomFromText('POINT(1.5 -2.25)'), ST_GeomFromText('POINT(40.4168 -3.7038)', 4326),
          ST_GeomFromText('POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))')),
         (2, NULL, ST_GeomFromText('POINT(-33.45 -70.66)', 4326), NULL)`
    )
    const created = await service.create({ connectionId, schema: GEO_SRC, includeData: true })
    expect(created.rows).toBe(2)
    const restored = await service.restore({
      backupPath: created.path,
      connectionId,
      targetSchema: GEO_DST,
      createSchema: true,
      dropObjectsFirst: true,
      includeStructure: true,
      includeData: true,
      continueOnError: false
    })
    expect(restored.errors).toEqual([])
    expect(restored.rowsInserted).toBe(2)
    expect(await tableChecksum(admin, GEO_DST, 'places')).toEqual(
      await tableChecksum(admin, GEO_SRC, 'places')
    )
    const [row] = await admin.query<{ srid: number; txt: string }>(
      `SELECT ST_SRID(loc) AS srid, ST_AsText(pt) AS txt FROM ${GEO_DST}.places WHERE id = 1`
    )
    expect(Number(row.srid)).toBe(4326)
    expect(row.txt).toBe('POINT(1.5 -2.25)')
  }, 60_000)

  it('restores the Navicat fixture', async () => {
    const base = {
      backupPath: FIXTURE,
      connectionId,
      targetSchema: FX,
      createSchema: true,
      dropObjectsFirst: true,
      continueOnError: false
    }
    // The synthetic fixture stores invalid JSON in the `payload json` column: '' (row 2) and
    // 'x' (row 3). MySQL rejects both in any SQL mode, so a restore using the fixture's own DDL
    // cannot load the rows. Restore the structure, relax that column, then load the rows.
    const structure = await service.restore({ ...base, includeStructure: true, includeData: false })
    expect(structure.errors).toEqual([])
    expect(structure.objectsRestored).toBe(3)
    await admin.execute(`ALTER TABLE ${FX}.account MODIFY payload TEXT NULL`)
    const data = await service.restore({
      ...base,
      includeStructure: false,
      includeData: true,
      objects: ['account']
    })
    expect(data.errors).toEqual([])
    expect(data.rowsInserted).toBe(3)

    const rows = await admin.query<{
      id: number
      note: string | null
      name: string
      payload: string
    }>(`SELECT id, name, note, payload FROM ${FX}.account ORDER BY id`)
    expect(rows).toHaveLength(3)
    expect(rows[0].note).toBe("O'Reilly")
    expect(rows[0].payload).toBe('{"k":"v"}')
    expect(rows[1].note).toBe('Line1\nLine2')
    expect(rows[2].note).toBe('back\\slash')
    const [active] = await admin.query<{ c: number }>(`SELECT COUNT(*) AS c FROM ${FX}.v_active`)
    expect(Number(active.c)).toBe(2)
  }, 60_000)

  it('refuses to restore into a production connection without confirmation', async () => {
    await expect(
      service.restore({
        backupPath,
        connectionId: prodId,
        targetSchema: PROD_TARGET,
        createSchema: true,
        dropObjectsFirst: true,
        includeStructure: true,
        includeData: true,
        continueOnError: false
      })
    ).rejects.toThrow(PRODUCTION_GUARD_MESSAGE)
    const dbs = await admin.query<{ name: string }>(
      'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [PROD_TARGET]
    )
    expect(dbs).toEqual([])
  })
})
