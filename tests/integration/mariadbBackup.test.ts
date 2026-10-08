/**
 * MariaDB sequences and system-versioned tables in backups, against MariaDB 11
 * (VORTAQ_TEST_MARIADB_URL, compose service `mariadb11` on 127.0.0.1:33311).
 *
 * - .vqb: sequences (with their value) and versioned tables with their history
 *   round-trip through a REPLACE into another database; transaction-precise
 *   versioning keeps its current rows with a warning;
 * - .nb3: versioned tables with their current rows, no sequences (warning);
 * - the safety copy of a REPLACE from an .nb3 is taken as a .vqb when the target
 *   has sequences or versioned tables, and a REPLACE is refused only when
 *   transaction-precise history would be lost;
 * - .sql: the dump recreates sequences (SETVAL) and versioned history through
 *   Vortaq's own .sql import.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { ConnectionManager, getConnectionManager, getSessionFactory } from '@main/db/manager'
import { createBackupService, type BackupService } from '@main/backup/index'
import { importSqlDump } from '@main/importers/sql/execute'
import { readArchiveMeta } from '@main/backup/archive'
import { MARIADB_TARGET, describeServer } from './targets'

const SCHEMA = `vq_mbk_${process.pid}`
const COPY = `${SCHEMA}_copia`
const FROM_SQL = `${SCHEMA}_sql`

function connectionInput(u: URL, dir: string): ConnectionInput {
  return {
    name: 'MariaDB backups IT',
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
  }
}

describeServer(MARIADB_TARGET, 'MariaDB sequences and versioned tables in backups', (url) => {
  let dir: string
  let ctx: AppContext
  let manager: ConnectionManager
  let id: string
  let service: BackupService

  const q = async <T = Record<string, unknown>>(sql: string): Promise<T[]> => {
    const s = await manager.acquire(id)
    try {
      return await s.query<T>(sql)
    } finally {
      await s.release()
    }
  }
  const run = async (sql: string): Promise<void> => {
    const s = await manager.acquire(id)
    try {
      await s.execute(sql)
    } finally {
      await s.release()
    }
  }
  const count = async (sql: string): Promise<number> => Number((await q<{ n: unknown }>(sql))[0].n)
  const nextVal = async (db: string): Promise<string> =>
    String((await q<{ v: unknown }>(`SELECT NEXTVAL(\`${db}\`.seq_pedidos) AS v`))[0].v)

  beforeAll(async () => {
    const u = new URL(url)
    dir = mkdtempSync(join(tmpdir(), 'vortaq-maria-backup-'))
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
    id = ctx.connections.save(connectionInput(u, dir)).id
    ctx.credentials.set('mysql', id, decodeURIComponent(u.password))
    manager = getConnectionManager(ctx)
    service = createBackupService(ctx, getSessionFactory(ctx))
    for (const db of [SCHEMA, COPY, FROM_SQL]) await run(`DROP DATABASE IF EXISTS \`${db}\``)
    await run(`CREATE DATABASE \`${SCHEMA}\``)
    const s = await manager.acquire(id, SCHEMA)
    try {
      await s.execute('CREATE SEQUENCE seq_pedidos START WITH 10 INCREMENT BY 5 CACHE 20')
      await s.execute('SELECT NEXTVAL(seq_pedidos)')
      await s.execute('SELECT NEXTVAL(seq_pedidos)')
      // A default that calls the sequence: the sequence must exist before the table.
      await s.execute(
        'CREATE TABLE pedidos (id BIGINT PRIMARY KEY DEFAULT NEXTVAL(seq_pedidos), nota VARCHAR(20))'
      )
      await s.execute("INSERT INTO pedidos (nota) VALUES ('uno'), ('dos')")
      await s.execute(
        'CREATE TABLE precios (id INT PRIMARY KEY, importe DECIMAL(8,2)) WITH SYSTEM VERSIONING'
      )
      await s.execute('INSERT INTO precios VALUES (1, 10.00), (2, 20.00)')
      await s.execute('UPDATE precios SET importe = 11.00 WHERE id = 1')
      await s.execute('DELETE FROM precios WHERE id = 2')
      await s.execute(
        `CREATE TABLE tarifas (
           id INT PRIMARY KEY,
           v INT,
           desde TIMESTAMP(6) GENERATED ALWAYS AS ROW START,
           hasta TIMESTAMP(6) GENERATED ALWAYS AS ROW END,
           PERIOD FOR SYSTEM_TIME (desde, hasta)
         ) WITH SYSTEM VERSIONING`
      )
      await s.execute('INSERT INTO tarifas (id, v) VALUES (1, 1)')
      await s.execute('UPDATE tarifas SET v = 2 WHERE id = 1')
      await s.execute('CREATE VIEW v_precios AS SELECT id, importe FROM precios')
    } finally {
      await s.release()
    }
  }, 60_000)

  afterAll(async () => {
    for (const db of [SCHEMA, COPY, FROM_SQL])
      await run(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => undefined)
    await manager.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips sequences and versioned history through a .vqb', async () => {
    const backup = await service.create({
      connectionId: id,
      schema: SCHEMA,
      includeData: true,
      format: 'vqb'
    })
    const meta = await readArchiveMeta(backup.path)
    expect(meta.objects.map((o) => `${String(o.type).toLowerCase()}:${o.name}`)).toEqual([
      'sequence:seq_pedidos',
      'table:pedidos',
      'table:precios',
      'table:tarifas',
      'view:v_precios'
    ])
    const restored = await service.replace({
      backupPath: backup.path,
      expectedSchema: SCHEMA,
      connectionId: id,
      targetSchema: COPY,
      safetyBackup: true,
      continueOnError: false
    })
    expect(restored.restore.errors).toEqual([])
    // History rows and current rows, with their original periods.
    const history = (db: string, table: string, start: string, end: string): Promise<unknown[]> =>
      q(
        `SELECT id, ${start} AS s, ${end} AS e FROM \`${db}\`.${table} FOR SYSTEM_TIME ALL ORDER BY id, ${start}`
      )
    expect(await history(COPY, 'precios', 'ROW_START', 'ROW_END')).toEqual(
      await history(SCHEMA, 'precios', 'ROW_START', 'ROW_END')
    )
    expect(await count(`SELECT COUNT(*) AS n FROM \`${COPY}\`.precios FOR SYSTEM_TIME ALL`)).toBe(3)
    expect(await count(`SELECT COUNT(*) AS n FROM \`${COPY}\`.precios`)).toBe(1)
    expect(await history(COPY, 'tarifas', 'desde', 'hasta')).toEqual(
      await history(SCHEMA, 'tarifas', 'desde', 'hasta')
    )
    // The sequence continues where the original's next uncached value is.
    const original = await q<{ v: unknown }>(
      `SELECT next_not_cached_value AS v FROM \`${SCHEMA}\`.seq_pedidos`
    )
    expect(await nextVal(COPY)).toBe(String(original[0].v))
    expect(await count(`SELECT COUNT(*) AS n FROM \`${COPY}\`.pedidos`)).toBe(2)
  }, 60_000)

  it('keeps an .nb3 to current rows and tells what it leaves out', async () => {
    const backup = await service.create({ connectionId: id, schema: SCHEMA, includeData: true })
    const meta = await readArchiveMeta(backup.path)
    expect(meta.objects.map((o) => String(o.type).toLowerCase())).not.toContain('sequence')
    expect(meta.objects.map((o) => o.name)).toContain('precios')
  }, 60_000)

  it('takes the safety copy of an .nb3 replace as a .vqb, refusing only lost history', async () => {
    const nb3 = await service.create({ connectionId: id, schema: SCHEMA, includeData: true })
    const lines: string[] = []
    // COPY exists (with a sequence and versioned tables): its safety copy must hold them.
    const result = await service.replace(
      {
        backupPath: nb3.path,
        expectedSchema: SCHEMA,
        connectionId: id,
        targetSchema: COPY,
        safetyBackup: true,
        continueOnError: true
      },
      { line: (l) => lines.push(l) }
    )
    expect(result.safetyBackup?.path).toMatch(/\.vqb$/)
    expect(lines.join('\n')).toContain('La copia previa se guarda en .vqb')
    const safety = await readArchiveMeta(result.safetyBackup!.path)
    expect(safety.objects.map((o) => `${String(o.type).toLowerCase()}:${o.name}`)).toContain(
      'sequence:seq_pedidos'
    )

    // Transaction-precise history cannot be copied: the replace is refused, nothing touched.
    await run(
      `CREATE TABLE \`${COPY}\`.htrx (
         id INT PRIMARY KEY,
         s BIGINT UNSIGNED GENERATED ALWAYS AS ROW START,
         e BIGINT UNSIGNED GENERATED ALWAYS AS ROW END,
         PERIOD FOR SYSTEM_TIME (s, e)
       ) ENGINE=InnoDB WITH SYSTEM VERSIONING`
    )
    await expect(
      service.replace({
        backupPath: nb3.path,
        expectedSchema: SCHEMA,
        connectionId: id,
        targetSchema: COPY,
        safetyBackup: true,
        continueOnError: true
      })
    ).rejects.toThrow(/versionada por transacción htrx/)
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${COPY}' AND TABLE_NAME = 'htrx'`
      )
    ).toBe(1)
    // A .vqb of it keeps the current rows and says the history stayed behind.
    await run(`INSERT INTO \`${COPY}\`.htrx (id) VALUES (1)`)
    const vqb = await service.create({
      connectionId: id,
      schema: COPY,
      includeData: true,
      format: 'vqb',
      objects: ['htrx']
    })
    const vqbMeta = await readArchiveMeta(vqb.path)
    expect(vqbMeta.warnings?.join(' ')).toMatch(/solo las filas actuales de htrx/)
  }, 90_000)

  it('recreates sequences and history from a .sql dump', async () => {
    const dump = await service.exportSql({
      connectionId: id,
      schema: SCHEMA,
      includeStructure: true,
      includeData: true,
      includeCreateDatabase: false
    })
    const text = await readFile(dump.path, 'utf8')
    expect(text).toMatch(/CREATE SEQUENCE `seq_pedidos`/)
    expect(text).toMatch(/SELECT SETVAL\(`seq_pedidos`, \d+, 0, 0\);/)
    expect(text).toContain('system_versioning_insert_history=1')
    // The sequence comes before the table whose default calls it.
    expect(text.indexOf('CREATE SEQUENCE')).toBeLessThan(text.indexOf('CREATE TABLE `pedidos`'))
    const result = await importSqlDump(
      { connections: ctx.connections, sessions: getSessionFactory(ctx), backups: service },
      {
        path: dump.path,
        connectionId: id,
        mode: 'intoSchema',
        targetSchema: FROM_SQL,
        createSchema: true,
        replaceSchema: false,
        safetyBackup: false,
        continueOnError: false
      }
    )
    expect(result.errors).toEqual([])
    expect(
      await count(`SELECT COUNT(*) AS n FROM \`${FROM_SQL}\`.precios FOR SYSTEM_TIME ALL`)
    ).toBe(await count(`SELECT COUNT(*) AS n FROM \`${SCHEMA}\`.precios FOR SYSTEM_TIME ALL`))
    const original = await q<{ v: unknown }>(
      `SELECT next_not_cached_value AS v FROM \`${SCHEMA}\`.seq_pedidos`
    )
    expect(await nextVal(FROM_SQL)).toBe(String(original[0].v))
  }, 60_000)
})
