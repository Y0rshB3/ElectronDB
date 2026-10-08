/**
 * P5: MariaDB as its own engine, against MariaDB 11 (VORTAQ_TEST_MARIADB_URL,
 * compose service `mariadb11` on 127.0.0.1:33311).
 *
 * - ed25519 and parsec accounts sign in (throwaway users created and dropped here;
 *   the plugins are installed in the test server with INSTALL SONAME when missing);
 * - a `mysql` connection whose server is MariaDB becomes `mariadb` when it opens in an
 *   interactive context (never in a headless one);
 * - sequences: listing, SHOW CREATE SEQUENCE, DROP SEQUENCE, and the tree gate;
 * - the MariaDB splitter runs `/*M!` statements and the production guard catches
 *   sequence functions and hidden writes;
 * - JSON is reported as json and the MariaDB designer round-trips a system-versioned
 *   table with json/uuid/inet6 columns (alter with history kept, versioning dropped).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import { mariadbDialect } from '@shared/dialects/mariadb'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { ConnectionManager } from '@main/db/manager'
import { executeScript } from '@main/mysql/query'
import * as introspect from '@main/mysql/introspect'
import { replaceSafetyPlan } from '@main/mysql/mariadb'
import { assertScriptAllowed } from '@main/ipc/productionGuard'
import {
  mariadbBuildAlter,
  mariadbDraftFromStructure
} from '../../src/renderer/src/components/designer/mariadb/planner'
import { emptyColumn } from '../../src/renderer/src/utils/tableDesigner'
import { MARIADB_TARGET, describeServer } from './targets'

const SCHEMA = `vortaq_maria_engine_${process.pid}`
const ED_USER = `vq_ed_${process.pid}`
const PARSEC_USER = `vq_parsec_${process.pid}`

function connectionInput(u: URL, dir: string, extra: Partial<ConnectionInput>): ConnectionInput {
  return {
    name: 'MariaDB engine IT',
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
    extraBackupDirs: [],
    ...extra
  }
}

function context(dir: string, headless: boolean): AppContext {
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

describeServer(MARIADB_TARGET, 'MariaDB engine (integration)', (url) => {
  let dir: string
  let ctx: AppContext
  let manager: ConnectionManager
  let rootId: string
  let password: string
  let u: URL

  const withRoot = async <T>(
    fn: (s: Awaited<ReturnType<ConnectionManager['acquire']>>) => Promise<T>
  ): Promise<T> => {
    const s = await manager.acquire(rootId)
    try {
      return await fn(s)
    } finally {
      await s.release()
    }
  }

  beforeAll(async () => {
    u = new URL(url)
    password = decodeURIComponent(u.password)
    dir = mkdtempSync(join(tmpdir(), 'vortaq-maria-engine-'))
    ctx = context(dir, false)
    manager = new ConnectionManager(ctx)
    rootId = ctx.connections.save(connectionInput(u, dir, { name: 'root' })).id
    ctx.credentials.set('mysql', rootId, password)
    await withRoot(async (s) => {
      for (const soname of ['auth_ed25519', 'auth_parsec']) {
        // Already installed (or built in) is fine; the users below say whether it works.
        await s.execute(`INSTALL SONAME '${soname}'`).catch(() => undefined)
      }
      await s.execute(`DROP USER IF EXISTS '${ED_USER}'@'%', '${PARSEC_USER}'@'%'`)
      await s.execute(
        `CREATE USER '${ED_USER}'@'%' IDENTIFIED VIA ed25519 USING PASSWORD('ed clave ñ')`
      )
      await s.execute(
        `CREATE USER '${PARSEC_USER}'@'%' IDENTIFIED VIA parsec USING PASSWORD('parsec clave ñ')`
      )
      await s.execute(`DROP DATABASE IF EXISTS \`${SCHEMA}\``)
      await s.execute(`CREATE DATABASE \`${SCHEMA}\``)
      await s.useSchema(SCHEMA)
      await s.execute('CREATE SEQUENCE seq_facturas START WITH 500 INCREMENT BY 5')
      await s.execute(
        `CREATE TABLE precios (
           id INT PRIMARY KEY,
           doc JSON NULL,
           u UUID NULL,
           ip INET6 NULL
         ) WITH SYSTEM VERSIONING`
      )
    })
  }, 60_000)

  afterAll(async () => {
    try {
      await withRoot(async (s) => {
        await s.execute(`DROP USER IF EXISTS '${ED_USER}'@'%', '${PARSEC_USER}'@'%'`)
        await s.execute(`DROP DATABASE IF EXISTS \`${SCHEMA}\``)
      })
    } catch {
      /* best effort */
    }
    await manager.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('opens as MariaDB with the MariaDB dialect', async () => {
    const info = await manager.open(rootId)
    expect(info.engine).toBe('mariadb')
    expect(info.runtime).toMatchObject({ flavor: 'mariadb', returning: 'insert-delete' })
    const connection = await manager.connection(rootId)
    expect(connection.family === 'sql' && connection.dialect).toBe(mariadbDialect)
  })

  it.each([
    [ED_USER, 'ed clave ñ'],
    [PARSEC_USER, 'parsec clave ñ']
  ])('signs in %s and refuses a wrong password', async (user, secret) => {
    const id = ctx.connections.save(connectionInput(u, dir, { name: user, username: user })).id
    ctx.credentials.set('mysql', id, secret)
    try {
      const s = await manager.acquire(id)
      try {
        const [row] = await s.query<{ u: string }>('SELECT CURRENT_USER() AS u')
        expect(row.u).toBe(`${user}@%`)
      } finally {
        await s.release()
      }
      const test = await manager.test(
        connectionInput(u, dir, { name: user, username: user }),
        'mal',
        null
      )
      expect(test.ok).toBe(false)
      expect(test.error).toMatch(/Access denied|acceso|denegado/i)
    } finally {
      await manager.close(id)
      ctx.connections.delete(id)
    }
  })

  it('stores a mysql connection to MariaDB as mariadb when it opens, never headless', async () => {
    const id = ctx.connections.save(
      connectionInput(u, dir, { name: 'era mysql', engine: 'mysql' })
    ).id
    ctx.credentials.set('mysql', id, password)
    const info = await manager.open(id)
    expect(info.engine).toBe('mariadb')
    expect(ctx.connections.get(id)?.engine).toBe('mariadb')
    const connection = await manager.connection(id)
    expect(connection.family === 'sql' && connection.dialect.id).toBe('mariadb')
    await manager.close(id)

    const headlessCtx = context(mkdtempSync(join(dir, 'headless-')), true)
    const headlessId = headlessCtx.connections.save(
      connectionInput(u, dir, { name: 'job', engine: 'mysql' })
    ).id
    headlessCtx.credentials.set('mysql', headlessId, password)
    const headless = new ConnectionManager(headlessCtx)
    try {
      expect((await headless.open(headlessId)).engine).toBe('mysql')
      expect(headlessCtx.connections.get(headlessId)?.engine).toBe('mysql')
    } finally {
      await headless.closeAll()
    }
  })

  it('lists the full UCA 14.0 collation names under their charset (designer pickers)', async () => {
    await withRoot(async (s) => {
      const utf8mb4 = (await introspect.listCharsets(s)).find((c) => c.charset === 'utf8mb4')
      expect(utf8mb4?.collations).toContain(utf8mb4?.defaultCollation)
      expect(utf8mb4?.collations).toContain('utf8mb4_uca1400_ai_ci')
    })
  })

  it('takes the safety copy of a database with sequences as a .vqb (never refused)', async () => {
    await withRoot(async (s) => {
      expect(await replaceSafetyPlan(s, SCHEMA)).toEqual({ vqb: true, refusal: null })
    })
  })

  it('lists, shows and drops sequences', async () => {
    await withRoot(async (s) => {
      const sequences = await introspect.listSequences(s, SCHEMA)
      expect(sequences).toEqual([
        expect.objectContaining({
          name: 'seq_facturas',
          type: 'sequence',
          kind: 'bigint',
          detail: expect.stringContaining('inicio 500 · incremento 5')
        })
      ])
      expect(await introspect.showCreateSequence(s, SCHEMA, 'seq_facturas')).toMatch(
        /^CREATE SEQUENCE `seq_facturas` start with 500 .*increment by 5/
      )
      // Sequences stay out of the table list.
      expect((await introspect.listTables(s, SCHEMA)).map((t) => t.name)).toEqual(['precios'])
      await s.execute(`CREATE SEQUENCE \`${SCHEMA}\`.tmp_seq`)
      await introspect.dropSequence(s, SCHEMA, 'tmp_seq')
      expect((await introspect.listSequences(s, SCHEMA)).map((q) => q.name)).toEqual([
        'seq_facturas'
      ])
    })
  })

  it('runs /*M! statements and guards sequence functions on production', async () => {
    await withRoot(async (s) => {
      const results = await executeScript(
        s,
        `/*M!100100 SELECT 1 AS solo_maria */;\nSELECT NEXTVAL(${SCHEMA}.seq_facturas) AS n`,
        {},
        100,
        mariadbDialect
      )
      expect(results.map((r) => r.error)).toEqual([null, null])
      expect(results[0].resultSet?.rows).toEqual([[1]])
      expect(Number(results[1].resultSet?.rows[0][0])).toBe(500)
    })
    const prodId = ctx.connections.save(
      connectionInput(u, dir, { name: 'prod', environment: 'production' })
    ).id
    try {
      for (const sql of [
        'SELECT NEXTVAL(seq_facturas)',
        'SELECT SETVAL(seq_facturas, 10)',
        '/*M!100100 DROP TABLE precios */',
        'SET STATEMENT max_statement_time=1 FOR DELETE FROM precios'
      ])
        expect(() => assertScriptAllowed(ctx, prodId, sql, undefined), sql).toThrow(
          /confirmación explícita/
        )
      for (const sql of [
        'SELECT LASTVAL(seq_facturas)',
        'SELECT * FROM precios FOR SYSTEM_TIME ALL'
      ])
        expect(() => assertScriptAllowed(ctx, prodId, sql, undefined), sql).not.toThrow()
    } finally {
      ctx.connections.delete(prodId)
    }
  })

  it('reports JSON as json and designs a system-versioned table', async () => {
    await withRoot(async (s) => {
      await s.useSchema(SCHEMA)
      const structure = await introspect.tableStructure(s, SCHEMA, 'precios')
      expect(structure.kind).toBe('system-versioned')
      expect(structure.columns.map((c) => `${c.name}:${c.columnType}`)).toEqual([
        'id:int(11)',
        'doc:json',
        'u:uuid',
        'ip:inet6'
      ])
      const draft = mariadbDraftFromStructure(structure)
      expect(mariadbBuildAlter(structure, draft).statements).toEqual([])

      // Alter the versioned table: a new column and a comment on the JSON one.
      draft.columns.push({ ...emptyColumn(), name: 'nota', columnType: 'varchar(30)' })
      draft.columns[1] = { ...draft.columns[1], comment: 'documento' }
      const plan = mariadbBuildAlter(structure, draft)
      expect(plan.problems).toEqual([])
      const results = await executeScript(s, plan.statements.join('\n'), {}, 10, mariadbDialect)
      expect(results.map((r) => r.error)).toEqual(plan.statements.map(() => null))
      const after = await introspect.tableStructure(s, SCHEMA, 'precios')
      expect(after.columns.find((c) => c.name === 'doc')).toMatchObject({
        columnType: 'json',
        comment: 'documento'
      })
      expect(after.kind).toBe('system-versioned')
      expect(mariadbBuildAlter(after, mariadbDraftFromStructure(after)).statements).toEqual([])

      // Drop versioning (history goes with it).
      const drop = mariadbBuildAlter(after, {
        ...mariadbDraftFromStructure(after),
        options: { systemVersioning: false }
      })
      expect(drop.risks.length).toBeGreaterThan(0)
      const dropped = await executeScript(s, drop.statements.join('\n'), {}, 10, mariadbDialect)
      expect(dropped.map((r) => r.error)).toEqual(drop.statements.map(() => null))
      expect((await introspect.tableStructure(s, SCHEMA, 'precios')).kind).toBe('table')
    })
  })
})
