import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ConnectionInput, ProgressEvent } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { SqlDumpImportOptions } from '@shared/importers'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { envVar } from '@main/env'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { getConnectionManager, getSessionFactory } from '@main/mysql/manager'
import type { MysqlSession } from '@main/mysql/types'
import { createBackupService } from '@main/backup/index'
import {
  importSqlDump,
  importSqlFolder,
  inspectSqlDump,
  previewSqlFolder,
  type SqlImportDeps
} from '@main/importers/sql/index'
import { describeMysql } from './targets'

/**
 * SQL dump import against real servers, with real `mysqldump` output: a seeded
 * schema (utf8mb4 text, NULLs, BLOB, DECIMAL, DATETIME/TIMESTAMP, JSON, a
 * foreign key, a view, a function, a procedure, a trigger and an event) is
 * dumped with the server container's own mysqldump, imported through
 * importSqlDump / importSqlFolder and compared table by table (COUNT(*) and
 * CHECKSUM TABLE) plus the routines, triggers, views and events.
 *
 * Containers: VORTAQ_TEST_MYSQL_CONTAINER (default navidog-test-mysql, 8.4) and
 * VORTAQ_TEST_MYSQL57_CONTAINER (default electrondb-test-mysql57-1, 5.7).
 */

const SRC = 'sqlimp_src'
const SRC2 = 'sqlimp_src2'
const DST = 'sqlimp_dst'
const DST_GZ = 'sqlimp_dst_gz'
const PKG_A = 'sqlimp_pkg_a'
const PKG_B = 'sqlimp_pkg_b'
const ALL = [SRC, SRC2, DST, DST_GZ, PKG_A, PKG_B]

function seed(): string[] {
  const sql = [
    `CREATE DATABASE ${SRC} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `USE ${SRC}`,
    `CREATE TABLE clientes (
       id INT NOT NULL AUTO_INCREMENT,
       nombre VARCHAR(80) NOT NULL,
       nota TEXT NULL,
       saldo DECIMAL(12,2) NULL,
       alta DATETIME NULL,
       cambio TIMESTAMP NULL DEFAULT NULL,
       foto BLOB NULL,
       ajustes JSON NULL,
       PRIMARY KEY (id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE pedidos (
       id INT NOT NULL AUTO_INCREMENT,
       cliente_id INT NOT NULL,
       total DECIMAL(10,2) NOT NULL DEFAULT 0,
       PRIMARY KEY (id),
       CONSTRAINT fk_pedidos_cliente FOREIGN KEY (cliente_id) REFERENCES clientes (id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `INSERT INTO clientes (nombre, nota, saldo, alta, cambio, foto, ajustes) VALUES
       ('Ana Ñandú 😀', 'línea 1\nlínea 2; con «punto y coma»', 10.50, '2026-01-02 03:04:05', '2026-01-02 03:04:05', 0x00FF10275C, '{"a": [1, 2], "b": "x"}'),
       ('O''Brien "Bob" \\\\ barra', NULL, NULL, NULL, NULL, NULL, NULL),
       ('-- no es comentario /* ni esto */ # tampoco', '', -0.01, '1999-12-31 23:59:59', '2038-01-01 00:00:00', '', '[]')`
  ]
  // A few thousand rows so mysqldump writes long extended INSERTs.
  for (let b = 0; b < 4; b++) {
    const rows = Array.from({ length: 750 }, (_, i) => {
      const n = b * 750 + i
      return `('cliente ${n} ✓', 'nota ${n}\\t;''x''', ${n}.25, '2026-03-01 00:00:00', NULL, 0x${(n % 256).toString(16).padStart(2, '0')}AB, NULL)`
    })
    sql.push(
      `INSERT INTO clientes (nombre, nota, saldo, alta, cambio, foto, ajustes) VALUES ${rows.join(',')}`
    )
  }
  sql.push(
    `INSERT INTO pedidos (cliente_id, total) SELECT id, saldo FROM clientes WHERE saldo IS NOT NULL AND saldo >= 0`,
    `CREATE VIEW v_resumen AS SELECT c.id, c.nombre, COUNT(p.id) AS pedidos FROM clientes c LEFT JOIN pedidos p ON p.cliente_id = c.id GROUP BY c.id, c.nombre`,
    `CREATE FUNCTION iva(importe DECIMAL(10,2)) RETURNS DECIMAL(10,2) DETERMINISTIC RETURN importe * 1.21`,
    `CREATE PROCEDURE alta_cliente(IN p_nombre VARCHAR(80))
     BEGIN
       INSERT INTO clientes (nombre) VALUES (p_nombre);
       SELECT 'hecho; listo' AS estado;
     END`,
    `CREATE TRIGGER pedidos_bi BEFORE INSERT ON pedidos FOR EACH ROW
     BEGIN
       IF NEW.total < 0 THEN SET NEW.total = 0; END IF;
     END`,
    `CREATE EVENT limpieza ON SCHEDULE EVERY 1 DAY DISABLE DO DELETE FROM pedidos WHERE total = 0`,
    `CREATE DATABASE ${SRC2} CHARACTER SET utf8mb4`,
    `CREATE TABLE ${SRC2}.etiquetas (id INT PRIMARY KEY, nombre VARCHAR(30) NOT NULL)`,
    `INSERT INTO ${SRC2}.etiquetas VALUES (1, 'roja'), (2, 'azul'), (3, 'ñ')`
  )
  return sql
}

interface Snapshot {
  tables: Record<string, { rows: number; checksum: string }>
  objects: string[]
}

/**
 * 5.7 split: CHECKSUM TABLE of a table with a JSON column changes every time the
 * table is reopened on 5.7 (same rows, different value), so there the table is
 * compared through an MD5 of every column instead (JSON as text, the rest as hex).
 */
async function contentDigest(
  session: MysqlSession,
  schema: string,
  table: string
): Promise<string> {
  const cols = await session.query<{ name: string; type: string; key: string }>(
    'SELECT COLUMN_NAME AS name, DATA_TYPE AS type, COLUMN_KEY AS `key` FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [schema, table]
  )
  const parts = cols.map((c) =>
    c.type.toLowerCase() === 'json'
      ? `IFNULL(CAST(${session.escapeId(c.name)} AS CHAR), 'N')`
      : `IFNULL(HEX(${session.escapeId(c.name)}), 'N')`
  )
  const order = cols.filter((c) => c.key === 'PRI').map((c) => session.escapeId(c.name))
  await session.execute('SET SESSION group_concat_max_len = 1073741824')
  const [row] = await session.query<{ d: unknown }>(
    `SELECT MD5(GROUP_CONCAT(CONCAT_WS('|', ${parts.join(', ')}) ORDER BY ${order.join(', ') || '1'} SEPARATOR '#')) AS d FROM ${session.escapeId(schema)}.${session.escapeId(table)}`
  )
  return `md5:${String(row.d)}`
}

async function snapshot(session: MysqlSession, schema: string): Promise<Snapshot> {
  const tables = await session.query<{ name: string }>(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
    [schema]
  )
  const is57 = session.serverVersion.startsWith('5.7')
  const out: Snapshot = { tables: {}, objects: [] }
  for (const { name } of tables) {
    const id = `${session.escapeId(schema)}.${session.escapeId(name)}`
    const [count] = await session.query<{ n: unknown }>(`SELECT COUNT(*) AS n FROM ${id}`)
    const [json] = await session.query<{ n: unknown }>(
      "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND DATA_TYPE = 'json'",
      [schema, name]
    )
    let checksum: string
    if (is57 && Number(json.n) > 0) checksum = await contentDigest(session, schema, name)
    else {
      const [sum] = await session.query<{ Checksum: unknown }>(`CHECKSUM TABLE ${id}`)
      checksum = String(sum.Checksum)
    }
    out.tables[name] = { rows: Number(count.n), checksum }
  }
  const objects = await session.query<{ o: string }>(
    `SELECT CONCAT('view:', TABLE_NAME) AS o FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?
     UNION ALL SELECT CONCAT(LOWER(ROUTINE_TYPE), ':', ROUTINE_NAME) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
     UNION ALL SELECT CONCAT('trigger:', TRIGGER_NAME) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
     UNION ALL SELECT CONCAT('event:', EVENT_NAME) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?`,
    [schema, schema, schema, schema]
  )
  out.objects = objects.map((r) => String(r.o)).sort()
  return out
}

describeMysql('SQL dump import (integration)', ({ url, is57 }) => {
  const container = is57
    ? (envVar('TEST_MYSQL57_CONTAINER') ?? 'electrondb-test-mysql57-1')
    : (envVar('TEST_MYSQL_CONTAINER') ?? 'navidog-test-mysql')
  let dir: string
  let ctx: AppContext
  let deps: SqlImportDeps
  let connectionId: string
  let session: MysqlSession
  let expected: Snapshot
  let expected2: Snapshot
  const dumps: Record<'plain' | 'databases' | 'second', string> = {
    plain: '',
    databases: '',
    second: ''
  }

  const mysqldump = (args: string[], file: string): string => {
    const out = execFileSync(
      'docker',
      [
        'exec',
        container,
        'mysqldump',
        '-uroot',
        `-p${decodeURIComponent(new URL(url).password)}`,
        '--default-character-set=utf8mb4',
        '--single-transaction',
        '--set-gtid-purged=OFF',
        '--routines',
        '--triggers',
        '--events',
        ...args
      ],
      { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const path = join(dir, file)
    writeFileSync(path, out)
    return path
  }

  const options = (overrides: Partial<SqlDumpImportOptions>): SqlDumpImportOptions => ({
    path: dumps.plain,
    connectionId,
    mode: 'intoSchema',
    targetSchema: DST,
    createSchema: true,
    replaceSchema: true,
    safetyBackup: false,
    continueOnError: false,
    ...overrides
  })

  beforeAll(async () => {
    const u = new URL(url)
    dir = mkdtempSync(join(tmpdir(), 'vortaq-sqlimp-it-'))
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
    const input: ConnectionInput = {
      name: 'Local',
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
    connectionId = ctx.connections.save(input).id
    ctx.credentials.set('mysql', connectionId, decodeURIComponent(u.password))
    const sessions = getSessionFactory(ctx)
    deps = { connections: ctx.connections, sessions, backups: createBackupService(ctx, sessions) }
    session = await sessions.acquire(connectionId)
    for (const db of ALL) await session.execute(`DROP DATABASE IF EXISTS ${db}`)
    for (const sql of seed()) await session.execute(sql)
    expected = await snapshot(session, SRC)
    expected2 = await snapshot(session, SRC2)
    dumps.plain = mysqldump([SRC], 'plain.sql')
    dumps.databases = mysqldump(['--databases', SRC], 'databases.sql')
    dumps.second = mysqldump([SRC2], 'second.sql')
  }, 180_000)

  afterAll(async () => {
    try {
      for (const db of ALL) await session?.execute(`DROP DATABASE IF EXISTS ${db}`)
    } catch {
      /* best effort */
    }
    await session?.release().catch(() => undefined)
    if (ctx) await getConnectionManager(ctx).closeAll()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('the seed is what the checks expect', () => {
    expect(Object.keys(expected.tables)).toEqual(['clientes', 'pedidos'])
    expect(expected.tables.clientes.rows).toBe(3003)
    expect(expected.objects).toEqual([
      'event:limpieza',
      'function:iva',
      'procedure:alta_cliente',
      'trigger:pedidos_bi',
      'view:v_resumen'
    ])
  })

  it('inspects the real dump', async () => {
    const plain = await inspectSqlDump(dumps.plain)
    expect(plain.tool).toBe('mysqldump')
    expect(plain.databases).toEqual([])
    expect(plain.counts).toMatchObject({ tables: 2, views: 1, routines: 2, triggers: 1, events: 1 })
    const withDb = await inspectSqlDump(dumps.databases)
    expect(withDb.databases).toEqual([SRC])
    expect(withDb.hasCreateDatabase).toBe(true)
  })

  it('imports a mysqldump file into another schema: same rows, checksums and objects', async () => {
    const events: Omit<ProgressEvent, 'operationId' | 'kind'>[] = []
    const result = await importSqlDump(deps, options({}), (e) => events.push(e))
    expect(result.errors).toEqual([])
    expect(result.created).toMatchObject({
      tables: 2,
      views: 1,
      routines: 2,
      triggers: 1,
      events: 1
    })
    expect(result.rowsAffected).toBe(expected.tables.clientes.rows + expected.tables.pedidos.rows)
    expect(result.bytesRead).toBe(result.bytesTotal)
    expect(await snapshot(session, DST)).toEqual(expected)
    expect(events[0].phase).toBe('start')
    expect(events.at(-1)!.phase).toBe('finish')
    // the dump's own session settings did not leak into the pooled connection
    const fresh = await deps.sessions.acquire(connectionId)
    try {
      const [row] = await fresh.query<{ fk: unknown }>('SELECT @@SESSION.foreign_key_checks AS fk')
      expect(Number(row.fk)).toBe(1)
    } finally {
      await fresh.release()
    }
  }, 180_000)

  it('imports the --databases dump into another schema (CREATE DATABASE skipped, USE redirected)', async () => {
    const result = await importSqlDump(deps, options({ path: dumps.databases }))
    expect(result.errors).toEqual([])
    expect(result.skipped).toBe(1)
    expect(result.databases).toEqual([DST])
    expect(await snapshot(session, DST)).toEqual(expected)
  }, 180_000)

  it('reads a .sql.gz dump as a stream', async () => {
    const gz = join(dir, 'plain.sql.gz')
    writeFileSync(gz, gzipSync(readFileSync(dumps.plain)))
    const result = await importSqlDump(deps, options({ path: gz, targetSchema: DST_GZ }))
    expect(result.errors).toEqual([])
    expect(result.bytesTotal).toBeLessThan(readFileSync(dumps.plain).length)
    expect(await snapshot(session, DST_GZ)).toEqual(expected)
  }, 180_000)

  it('replaces an existing database after a safety copy', async () => {
    await session.execute(`CREATE TABLE ${DST}.sobrante (id INT)`)
    const result = await importSqlDump(deps, options({ safetyBackup: true }))
    expect(result.errors).toEqual([])
    expect(result.safetyBackupPath).toMatch(/previo-importacion\.nb3$/)
    expect(await snapshot(session, DST)).toEqual(expected)
    // With .vqb chosen in Ajustes the safety copy is a .vqb.
    const again = await importSqlDump(
      { ...deps, safetyFormat: () => 'vqb' },
      options({ safetyBackup: true })
    )
    expect(again.errors).toEqual([])
    expect(again.safetyBackupPath).toMatch(/previo-importacion\.vqb$/)
    expect(await snapshot(session, DST)).toEqual(expected)
  }, 180_000)

  it('imports a folder of dumps as a package, one database per file', async () => {
    const pkg = join(dir, 'paquete')
    mkdirSync(pkg)
    writeFileSync(join(pkg, `${PKG_A}.sql`), readFileSync(dumps.plain))
    writeFileSync(join(pkg, `${PKG_B}.sql.gz`), gzipSync(readFileSync(dumps.second)))
    const preview = await previewSqlFolder(pkg)
    expect(preview.items.map((i) => i.schema)).toEqual([PKG_A, PKG_B])
    const result = await importSqlFolder(deps, {
      dir: pkg,
      connectionId,
      items: preview.items.map((i) => ({ path: i.path, schema: i.schema })),
      replaceSchema: true,
      safetyBackup: false,
      continueOnError: false
    })
    expect(result.items.map((i) => [i.schema, i.error, i.result?.errors])).toEqual([
      [PKG_A, null, []],
      [PKG_B, null, []]
    ])
    expect(await snapshot(session, PKG_A)).toEqual(expected)
    expect(await snapshot(session, PKG_B)).toEqual(expected2)
  }, 180_000)

  it('runs the --databases dump as written (asFile): the dropped database comes back', async () => {
    await session.execute(`DROP DATABASE ${SRC}`)
    const result = await importSqlDump(
      deps,
      options({
        path: dumps.databases,
        mode: 'asFile',
        targetSchema: null,
        createSchema: false,
        replaceSchema: false
      })
    )
    expect(result.errors).toEqual([])
    expect(result.databases).toEqual([SRC])
    expect(result.created.databases).toBe(1)
    expect(await snapshot(session, SRC)).toEqual(expected)
  }, 180_000)
})
