/**
 * P1b: a `mysql` connection pointed at a MariaDB 11 server
 * (VORTAQ_TEST_MARIADB_URL, docker compose service `mariadb11` on 127.0.0.1:33311).
 * Covers the MariaDB-only fixes: flavour detection, system-versioned tables listed and
 * editable, COLUMN_DEFAULT unquoting, INVISIBLE columns, users from mysql.global_priv,
 * the count timeout, extended type labels, a designer round trip and the backup warning.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ConnectionInput, ProgressEvent } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { ConnectionManager, getConnectionManager, getSessionFactory } from '@main/db/manager'
import { executeScript } from '@main/mysql/query'
import { fetchTableData, buildCountSql } from '@main/mysql/tableData'
import { applyRowChanges } from '@main/mysql/rowChanges'
import * as introspect from '@main/mysql/introspect'
import { listUsers } from '@main/mysql/users'
import { createBackupService } from '@main/backup/index'
import { skippedObjectsWarning } from '@main/backup/create'
import { buildDesignerAlter } from '../../src/renderer/src/components/designer/alterTable'
import { draftFromStructure } from '../../src/renderer/src/utils/tableDesigner'
import {
  decideEditability,
  resultSource
} from '../../src/renderer/src/components/query/resultEditability'
import { MARIADB_TARGET, describeServer } from './targets'

const SCHEMA = `vortaq_maria_${process.pid}`

function connectionInput(u: URL, dir: string): ConnectionInput {
  return {
    name: 'MariaDB IT',
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

describeServer(MARIADB_TARGET, 'MariaDB fixes on a mysql connection (integration)', (url) => {
  let dir: string
  let ctx: AppContext
  let manager: ConnectionManager
  let id: string

  beforeAll(async () => {
    const u = new URL(url)
    dir = mkdtempSync(join(tmpdir(), 'vortaq-maria-it-'))
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
    const s = await manager.acquire(id)
    try {
      await s.execute(`DROP DATABASE IF EXISTS \`${SCHEMA}\``)
      await s.execute(`CREATE DATABASE \`${SCHEMA}\``)
      await s.useSchema(SCHEMA)
      await s.execute(
        `CREATE TABLE sv (
           id INT PRIMARY KEY,
           name VARCHAR(20) DEFAULT 'x''y',
           path VARCHAR(20) DEFAULT 'a\\\\b',
           n INT DEFAULT NULL,
           d DATETIME DEFAULT current_timestamp(),
           secret INT INVISIBLE DEFAULT 7,
           doc JSON NULL,
           u UUID NULL
         ) WITH SYSTEM VERSIONING`
      )
      await s.execute(
        "INSERT INTO sv (id, name, secret, doc, u) VALUES (1, 'one', 11, '{\"k\": 1}', '123e4567-e89b-12d3-a456-426614174000'), (2, 'two', 22, NULL, NULL)"
      )
      await s.execute('CREATE TABLE plain (id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(10))')
      await s.execute('CREATE SEQUENCE seq_orders')
      await s.execute('CREATE VIEW v_sv AS SELECT id, name FROM sv')
    } finally {
      await s.release()
    }
  }, 60_000)

  afterAll(async () => {
    try {
      const s = await manager.acquire(id)
      try {
        await s.execute(`DROP DATABASE IF EXISTS \`${SCHEMA}\``)
      } finally {
        await s.release()
      }
    } catch {
      /* best effort */
    }
    await manager.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('detects the MariaDB flavour at connect time', async () => {
    const info = await manager.open(id)
    expect(info.version).toMatch(/MariaDB/)
    expect(info.engine).toBe('mysql')
    expect(info.runtime).toMatchObject({ flavor: 'mariadb', returning: 'insert-delete' })
    expect(info.runtime!.versionNumber).toBeGreaterThanOrEqual(110000)
  })

  it('lists system-versioned tables with the base tables (sequences stay out)', async () => {
    const s = await manager.acquire(id)
    try {
      const names = (await introspect.listTables(s, SCHEMA)).map((t) => t.name)
      expect(names).toEqual(['plain', 'sv'])
      const structure = await introspect.tableStructure(s, SCHEMA, 'sv')
      expect(structure.tableType).toBe('SYSTEM VERSIONED')
      expect(structure.kind).toBe('system-versioned')
      expect((await introspect.tableStructure(s, SCHEMA, 'plain')).kind).toBe('table')
    } finally {
      await s.release()
    }
  })

  it('unquotes COLUMN_DEFAULT and marks INVISIBLE columns', async () => {
    const s = await manager.acquire(id)
    try {
      const cols = await introspect.listColumns(s, SCHEMA, 'sv')
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]))
      expect(byName.id.defaultValue).toBeNull()
      expect(byName.name.defaultValue).toBe("x'y")
      expect(byName.path.defaultValue).toBe('a\\b')
      expect(byName.n.defaultValue).toBeNull()
      expect(byName.d.defaultValue).toBe('current_timestamp()')
      expect(byName.secret).toMatchObject({ defaultValue: '7', hidden: true })
      expect(byName.name.hidden).toBe(false)
    } finally {
      await s.release()
    }
  })

  it('selects INVISIBLE columns explicitly and counts with max_statement_time', async () => {
    const s = await manager.acquire(id)
    try {
      const page = await fetchTableData(s, {
        schema: SCHEMA,
        table: 'sv',
        limit: 10,
        offset: 0,
        orderBy: { column: 'id', direction: 'ASC' }
      })
      expect(page.columns.map((c) => c.name)).toEqual([
        'id',
        'name',
        'path',
        'n',
        'd',
        'secret',
        'doc',
        'u'
      ])
      expect(page.rows.map((r) => r[5])).toEqual([11, 22])
      expect(page.total).toBe(2)
      expect(page.primaryKey).toEqual(['id'])
      // Extended metadata labels: JSON is LONGTEXT on the wire, UUID is CHAR.
      expect(page.columns.find((c) => c.name === 'doc')?.type).toBe('JSON')
      expect(page.columns.find((c) => c.name === 'u')?.type).toBe('UUID')
      expect(page.rows[0][6]).toBe('{"k": 1}')
      const [row] = await s.query<{ total: number }>(
        buildCountSql({ schema: SCHEMA, table: 'sv', limit: 1, offset: 0 }, [], 'mariadb')
      )
      expect(Number(row.total)).toBe(2)
    } finally {
      await s.release()
    }
  })

  it('edits a system-versioned table from the grid and from an editable result', async () => {
    const s = await manager.acquire(id, SCHEMA)
    try {
      await applyRowChanges(s, SCHEMA, 'sv', [
        { kind: 'update', key: { id: 2 }, values: { name: 'dos', secret: 23 } },
        { kind: 'insert', values: { id: 3, name: 'tres' } },
        { kind: 'delete', key: { id: 1 } }
      ])
      const rows = await s.query<{ id: number; name: string; secret: number }>(
        'SELECT id, name, secret FROM sv ORDER BY id'
      )
      expect(rows).toEqual([
        { id: 2, name: 'dos', secret: 23 },
        { id: 3, name: 'tres', secret: 7 }
      ])
      // History is kept by the server: the deleted row is still there FOR SYSTEM_TIME ALL.
      const [history] = await s.query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM sv FOR SYSTEM_TIME ALL WHERE id = 1'
      )
      expect(Number(history.n)).toBe(1)

      const [r] = await executeScript(s, 'SELECT id, name FROM sv')
      const source = resultSource(r.resultSet!.columns, r.sql)
      expect(source.ok).toBe(true)
      if (!source.ok) return
      const structure = await introspect.tableStructure(
        s,
        source.source.schema,
        source.source.table
      )
      const decision = decideEditability(
        r.resultSet!.columns,
        source.source,
        structure,
        r.resultSet!.rows
      )
      expect(decision).toMatchObject({ editable: true, table: 'sv', primaryKey: ['id'] })
    } finally {
      await s.release()
    }
  })

  it('lists users from mysql.global_priv', async () => {
    const s = await manager.acquire(id)
    try {
      const users = await listUsers(s)
      const root = users.find((u) => u.user === 'root' && u.host === '%')
      expect(root).toMatchObject({
        plugin: expect.any(String),
        accountLocked: false,
        passwordExpired: false
      })
      expect(users.find((u) => u.user === 'mariadb.sys')?.accountLocked).toBe(true)
    } finally {
      await s.release()
    }
  })

  it('round-trips the table designer (alter keeps quoted defaults)', async () => {
    const s = await manager.acquire(id, SCHEMA)
    try {
      const original = await introspect.tableStructure(s, SCHEMA, 'plain')
      const draft = draftFromStructure(original)
      draft.columns.push({
        ...draft.columns[1],
        id: 'new',
        originalName: null,
        name: 'note',
        columnType: 'varchar(30)',
        defaultValue: "it's"
      })
      draft.columns[1] = { ...draft.columns[1], columnType: 'varchar(40)' }
      const plan = buildDesignerAlter(original, draft)
      expect(plan.problems).toEqual([])
      for (const sql of plan.statements) await s.execute(sql)
      const after = await introspect.tableStructure(s, SCHEMA, 'plain')
      const note = after.columns.find((c) => c.name === 'note')
      expect(note?.defaultValue).toBe("it's")
      expect(after.columns.find((c) => c.name === 'label')?.columnType).toBe('varchar(40)')
      // A second pass over the altered table has nothing left to change.
      expect(buildDesignerAlter(after, draftFromStructure(after)).statements).toEqual([])
    } finally {
      await s.release()
    }
  })

  it('warns before an .nb3 that would skip sequences and the history of versioned tables', async () => {
    const sessions = getSessionFactory(ctx)
    const warning = await skippedObjectsWarning(sessions, id, SCHEMA)
    expect(warning).toBe(
      'La copia .nb3 no incluye la secuencia seq_orders y de la tabla versionada sv guarda solo las filas actuales, sin historial (MariaDB). Elige el formato .vqb para copiarlo todo.'
    )
    // A .vqb (and a .sql) holds both: no warning.
    expect(await skippedObjectsWarning(sessions, id, SCHEMA, 'vqb')).toBeNull()
    const events: Omit<ProgressEvent, 'operationId' | 'kind'>[] = []
    const service = createBackupService(ctx, sessions)
    const result = await service.create(
      { connectionId: id, schema: SCHEMA, includeData: true },
      (e) => events.push(e)
    )
    expect(events.find((e) => e.phase === 'warning')?.message).toBe(warning)
    // plain, sv (current rows) and v_sv: the .nb3 format has no slot for the sequence.
    expect(result.objects).toBe(3)
  }, 60_000)
})
