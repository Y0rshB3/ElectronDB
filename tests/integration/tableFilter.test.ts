import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  ConnectionInput,
  TableFilter,
  TableFilterCondition,
  TableFilterNode,
  TableFilterOperator
} from '@shared/types'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { envVar } from '@main/env'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { ConnectionManager } from '@main/mysql/manager'
import { fetchTableData } from '@main/mysql/tableData'

/**
 * Filter builder against real servers: every operator returns the expected rows
 * of a seeded table with NULL, empty, wildcard, quote, backslash and unicode values.
 *
 *   VORTAQ_TEST_MYSQL_URL=mysql://root:navidog@127.0.0.1:33306/navidog_test     (8.4)
 *   VORTAQ_TEST_MYSQL57_URL=mysql://root:navidog@127.0.0.1:33357/navidog_test   (5.7)
 */
const SERVERS = [
  { label: 'MySQL 8.4', url: envVar('TEST_MYSQL_URL') },
  { label: 'MySQL 5.7', url: envVar('TEST_MYSQL57_URL') }
]
const SCHEMA = `vortaq_filter_${process.pid}`

// utf8mb4_bin: comparisons are exact on both versions (no accent/case folding differences).
const SEED = [
  `CREATE TABLE ${SCHEMA}.f (
     id INT NOT NULL PRIMARY KEY,
     name VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
     qty INT NULL,
     born DATE NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `INSERT INTO ${SCHEMA}.f VALUES
     (1, 'alpha', 10, '2020-01-01'),
     (2, '', 20, '2021-06-15'),
     (3, NULL, NULL, NULL),
     (4, '50% off', 5, '2022-12-31'),
     (5, 'a_b', 15, '2019-03-03'),
     (6, 'back\\\\slash', 0, '2023-07-07'),
     (7, 'ñandú 🐦', 30, '2024-02-29'),
     (8, 'o''k', 25, '2018-08-08'),
     (9, 'aXb', 12, '2020-05-05')`
]

function input(u: URL): ConnectionInput {
  return {
    name: 'Filtro',
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
    backupDir: '/tmp/vortaq-it',
    extraBackupDirs: []
  }
}

function c(
  column: string,
  operator: TableFilterOperator,
  extra: Partial<TableFilterCondition> = {}
): TableFilterCondition {
  return {
    kind: 'condition',
    enabled: true,
    column,
    operator,
    values: [],
    connector: 'AND',
    ...extra
  }
}

function root(children: TableFilterNode[]): TableFilter {
  return { kind: 'group', enabled: true, connector: 'AND', children }
}

const CASES: [string, TableFilterNode[], number[]][] = [
  ['= text', [c('name', 'eq', { values: ['alpha'] })], [1]],
  ['= quote', [c('name', 'eq', { values: ["o'k"] })], [8]],
  ['= backslash', [c('name', 'eq', { values: ['back\\slash'] })], [6]],
  ['= unicode', [c('name', 'eq', { values: ['ñandú 🐦'] })], [7]],
  ['!= (NULL never matches)', [c('name', 'ne', { values: ['alpha'] })], [2, 4, 5, 6, 7, 8, 9]],
  ['<', [c('qty', 'lt', { values: ['10'] })], [4, 6]],
  ['<=', [c('qty', 'le', { values: ['10'] })], [1, 4, 6]],
  ['>', [c('qty', 'gt', { values: ['20'] })], [7, 8]],
  ['>=', [c('qty', 'ge', { values: ['20'] })], [2, 7, 8]],
  ['contiene', [c('name', 'contains', { values: ['a'] })], [1, 5, 6, 7, 9]],
  ['contiene % literal', [c('name', 'contains', { values: ['%'] })], [4]],
  ['contiene _ literal', [c('name', 'contains', { values: ['_'] })], [5]],
  ['contiene \\ literal', [c('name', 'contains', { values: ['\\'] })], [6]],
  ["contiene ' literal", [c('name', 'contains', { values: ["'"] })], [8]],
  ['contiene unicode', [c('name', 'contains', { values: ['🐦'] })], [7]],
  ['no contiene', [c('name', 'notContains', { values: ['a'] })], [2, 4, 8]],
  ['empieza por', [c('name', 'beginsWith', { values: ['a'] })], [1, 5, 9]],
  ['empieza por a_ (no comodín)', [c('name', 'beginsWith', { values: ['a_'] })], [5]],
  ['no empieza por', [c('name', 'notBeginsWith', { values: ['a'] })], [2, 4, 6, 7, 8]],
  ['termina en', [c('name', 'endsWith', { values: ['b'] })], [5, 9]],
  ['no termina en', [c('name', 'notEndsWith', { values: ['b'] })], [1, 2, 4, 6, 7, 8]],
  ['es nulo', [c('name', 'isNull')], [3]],
  ['no es nulo', [c('qty', 'isNotNull')], [1, 2, 4, 5, 6, 7, 8, 9]],
  ["está vacío ('' o NULL)", [c('name', 'isEmpty')], [2, 3]],
  ['no está vacío', [c('name', 'isNotEmpty')], [1, 4, 5, 6, 7, 8, 9]],
  ['está en la lista', [c('name', 'in', { values: ['alpha', "o'k", 'ñandú 🐦'] })], [1, 7, 8]],
  ['no está en la lista', [c('qty', 'notIn', { values: ['10', '20'] })], [4, 5, 6, 7, 8, 9]],
  ['entre (fechas)', [c('born', 'between', { values: ['2020-01-01', '2021-12-31'] })], [1, 2, 9]],
  ['no entre', [c('qty', 'notBetween', { values: ['5', '25'] })], [6, 7]],
  ['[Personalizado]', [c('', 'custom', { sql: 'qty * 2 = 20' })], [1]]
]

for (const server of SERVERS) {
  describe.skipIf(!server.url)(`table filter builder on ${server.label} (integration)`, () => {
    let dir: string
    let manager: ConnectionManager
    let connectionId: string

    beforeAll(async () => {
      const u = new URL(server.url!)
      dir = mkdtempSync(join(tmpdir(), 'vortaq-filter-'))
      const ctx: AppContext = {
        userDataPath: dir,
        logDir: join(dir, 'logs'),
        connections: new ConnectionsRepo(dir),
        jobs: new JobsRepo(dir),
        runs: new RunsRepo(dir),
        settings: new SettingsRepo(dir, dir),
        credentials: new CredentialStore(dir, plainCodec, 'plain'),
        emit: () => undefined,
        headless: true
      }
      connectionId = ctx.connections.save(input(u)).id
      ctx.credentials.set('mysql', connectionId, decodeURIComponent(u.password))
      manager = new ConnectionManager(ctx)
      const s = await manager.acquire(connectionId)
      try {
        await s.execute(`DROP DATABASE IF EXISTS ${SCHEMA}`)
        await s.execute(`CREATE DATABASE ${SCHEMA} CHARACTER SET utf8mb4`)
        for (const sql of SEED) await s.execute(sql)
      } finally {
        await s.release()
      }
    })

    afterAll(async () => {
      try {
        const s = await manager.acquire(connectionId)
        try {
          await s.execute(`DROP DATABASE IF EXISTS ${SCHEMA}`)
        } finally {
          await s.release()
        }
      } finally {
        await manager.closeAll()
        rmSync(dir, { recursive: true, force: true })
      }
    })

    async function ids(filter: TableFilter | null, where?: string): Promise<number[]> {
      const s = await manager.acquire(connectionId)
      try {
        const page = await fetchTableData(s, {
          schema: SCHEMA,
          table: 'f',
          limit: 100,
          offset: 0,
          orderBy: { column: 'id', direction: 'ASC' },
          where: where ?? null,
          filter
        })
        const got = page.rows.map((r) => Number(r[0]))
        // COUNT(*) uses the same WHERE as the page.
        expect(page.total).toBe(got.length)
        return got
      } finally {
        await s.release()
      }
    }

    it.each(CASES)('%s', async (_label, conditions, expected) => {
      expect(await ids(root(conditions))).toEqual(expected)
    })

    it('combines with OR, a group, disabled rows and the raw WHERE', async () => {
      // name es nulo o ( qty >= 10 y name empieza por a ) [o id = 8, desactivada]
      const filter = root([
        c('name', 'isNull', { connector: 'OR' }),
        {
          kind: 'group',
          enabled: true,
          connector: 'OR',
          children: [c('qty', 'ge', { values: ['10'] }), c('name', 'beginsWith', { values: ['a'] })]
        },
        c('id', 'eq', { values: ['8'], enabled: false })
      ])
      expect(await ids(filter)).toEqual([1, 3, 5, 9])
      expect(await ids(filter, 'id > 3')).toEqual([5, 9])
      expect(await ids(root([]))).toHaveLength(9)
    })

    it('respects mixed connectors (AND first) and nested brackets', async () => {
      // qty < 10 o qty > 20 y name contiene k  ==  qty < 10 OR (qty > 20 AND name LIKE %k%)
      expect(
        await ids(
          root([
            c('qty', 'lt', { values: ['10'], connector: 'OR' }),
            c('qty', 'gt', { values: ['20'] }),
            c('name', 'contains', { values: ['k'] })
          ])
        )
      ).toEqual([4, 6, 8])
      // ( qty < 10 o qty > 20 ) y name contiene k
      expect(
        await ids(
          root([
            {
              kind: 'group',
              enabled: true,
              connector: 'AND',
              children: [
                c('qty', 'lt', { values: ['10'], connector: 'OR' }),
                c('qty', 'gt', { values: ['20'] })
              ]
            },
            c('name', 'contains', { values: ['k'] })
          ])
        )
      ).toEqual([6, 8])
      // An empty bracket and a disabled one are skipped.
      expect(
        await ids(
          root([
            { kind: 'group', enabled: true, connector: 'OR', children: [] },
            { kind: 'group', enabled: false, connector: 'OR', children: [c('id', 'isNull')] },
            c('id', 'eq', { values: ['1'] })
          ])
        )
      ).toEqual([1])
    })

    it('rejects a column the table does not have before running anything', async () => {
      await expect(ids(root([c('name` OR 1=1 -- ', 'eq', { values: ['x'] })]))).rejects.toThrow(
        'no existe en la tabla'
      )
    })

    it('pages a filtered table with the total of the filter', async () => {
      const s = await manager.acquire(connectionId)
      try {
        const page = await fetchTableData(s, {
          schema: SCHEMA,
          table: 'f',
          limit: 2,
          offset: 2,
          orderBy: { column: 'id', direction: 'ASC' },
          filter: root([c('qty', 'isNotNull')])
        })
        expect(page.rows.map((r) => Number(r[0]))).toEqual([4, 5])
        expect(page.total).toBe(8)
      } finally {
        await s.release()
      }
    })
  })
}
