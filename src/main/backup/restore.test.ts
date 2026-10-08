import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RestoreOptions } from '@shared/types'
import { createBackup } from './create'
import { Nb3Writer } from './nb3/writer'
import {
  BATCH_MAX_ROWS,
  PRODUCTION_GUARD_MESSAGE,
  DefinerAccounts,
  RESTORE_CANCELLED,
  definerOf,
  executeDdl,
  restoreBackup,
  stripAutoIncrementOption,
  stripDefiner,
  describeRestoreError,
  restoreErrorHint
} from './restore'
import {
  FakeSessionFactory,
  connectionFixture,
  connectionsOf,
  type FakeSchema
} from './testing/fakeSession'

const FIXTURE = resolve('tests/fixtures/navicat/backups/demo/20260317144801-fixture.nb3')

let dir: string
let fullBackup: string

const sourceSchema: FakeSchema = {
  tables: [
    {
      name: 'items',
      ddl: 'CREATE TABLE `items` (`id` int) ENGINE=InnoDB AUTO_INCREMENT=5',
      columns: [{ name: 'id', columnType: 'int' }],
      rows: [[1], [2]],
      triggers: [
        {
          name: 'tr',
          ddl: 'CREATE DEFINER=`root`@`%` TRIGGER `tr` BEFORE INSERT ON `items` FOR EACH ROW SET @x = 1'
        }
      ]
    }
  ],
  views: [
    {
      name: 'v_items',
      ddl: 'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v_items` AS select 1'
    }
  ],
  functions: [
    { name: 'f_one', ddl: 'CREATE DEFINER=`root`@`%` FUNCTION `f_one`() RETURNS int RETURN 1' }
  ],
  procedures: [{ name: 'p_noop', ddl: 'CREATE DEFINER=`root`@`%` PROCEDURE `p_noop`() BEGIN END' }],
  events: [
    {
      name: 'e_tick',
      ddl: 'CREATE DEFINER=`root`@`%` EVENT `e_tick` ON SCHEDULE EVERY 1 DAY DO SELECT 1'
    }
  ]
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vortaq-restore-'))
  const result = await createBackup(
    {
      connections: connectionsOf(connectionFixture({ backupDir: dir })),
      sessions: new FakeSessionFactory(sourceSchema)
    },
    { connectionId: 'conn-1', schema: 'src', includeData: true }
  )
  fullBackup = result.path
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const baseOptions = (overrides: Partial<RestoreOptions> = {}): RestoreOptions => ({
  backupPath: fullBackup,
  connectionId: 'conn-1',
  targetSchema: 'dst',
  createSchema: true,
  dropObjectsFirst: true,
  includeStructure: true,
  includeData: true,
  continueOnError: false,
  ...overrides
})

const run = (
  options: RestoreOptions,
  factory = new FakeSessionFactory(),
  environment: 'local' | 'production' = 'local',
  signal?: AbortSignal
) =>
  restoreBackup(
    { connections: connectionsOf(connectionFixture({ environment })), sessions: factory },
    options,
    () => {},
    signal
  ).then((result) => ({ result, factory, session: factory.sessions[0] }))

describe('restoreBackup', () => {
  it('reports one objectDone event per restored object (type, rows) for automation logs', async () => {
    const events: { phase: string; type?: string; name?: string; rows?: number | null }[] = []
    await restoreBackup(
      {
        connections: connectionsOf(connectionFixture()),
        sessions: new FakeSessionFactory()
      },
      baseOptions(),
      (e) =>
        events.push({
          phase: e.phase,
          type: e.detail?.objectType,
          name: e.detail?.objectName,
          rows: e.detail?.rows
        })
    )
    expect(events.filter((e) => e.phase === 'objectDone')).toEqual([
      { phase: 'objectDone', type: 'Table', name: 'items', rows: 2 },
      { phase: 'objectDone', type: 'Function', name: 'f_one', rows: null },
      { phase: 'objectDone', type: 'Procedure', name: 'p_noop', rows: null },
      { phase: 'objectDone', type: 'View', name: 'v_items', rows: null },
      { phase: 'objectDone', type: 'Event', name: 'e_tick', rows: null }
    ])
  })

  it('refuses production targets without confirmation before opening the file or a session', async () => {
    const factory = new FakeSessionFactory()
    await expect(
      run(baseOptions({ backupPath: '/does/not/exist.nb3' }), factory, 'production')
    ).rejects.toThrow(PRODUCTION_GUARD_MESSAGE)
    expect(factory.sessions).toHaveLength(0)
    const { result } = await run(
      baseOptions({ confirmProduction: true }),
      new FakeSessionFactory(),
      'production'
    )
    expect(result.errors).toEqual([])
  })

  it('restores in order: tables (DDL, rows, triggers, AUTO_INCREMENT), routines, views, events', async () => {
    const { result, session } = await run(baseOptions())
    expect(result).toMatchObject({ objectsRestored: 5, rowsInserted: 2, errors: [] })
    expect(session.released).toBe(true)
    const statements = session.executed.map((s) => s.replace(/\s+/g, ' '))
    expect(statements).toEqual([
      'CREATE DATABASE IF NOT EXISTS `dst`',
      'USE dst',
      'SET NAMES utf8mb4',
      'SET FOREIGN_KEY_CHECKS = 0',
      'SET UNIQUE_CHECKS = 0',
      "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO'",
      'DROP TABLE IF EXISTS `items`',
      'CREATE TABLE `items` (`id` int) ENGINE=InnoDB AUTO_INCREMENT=5',
      'INSERT INTO `items` (`id`) VALUES (1),(2)',
      sourceSchema.tables[0].triggers![0].ddl,
      'ALTER TABLE `items` AUTO_INCREMENT = 5',
      'DROP FUNCTION IF EXISTS `f_one`',
      sourceSchema.functions![0].ddl,
      'DROP PROCEDURE IF EXISTS `p_noop`',
      sourceSchema.procedures![0].ddl,
      'DROP VIEW IF EXISTS `v_items`',
      sourceSchema.views![0].ddl,
      'DROP EVENT IF EXISTS `e_tick`',
      sourceSchema.events![0].ddl,
      'SET FOREIGN_KEY_CHECKS = 1',
      'SET UNIQUE_CHECKS = 1',
      'SET SQL_MODE = ? -- ["STRICT_TRANS_TABLES"]'
    ])
  })

  it('structure only with skipAutoIncrement (replace «Solo estructura»): no INSERT, no AUTO_INCREMENT, same FK checks', async () => {
    const { result, session } = await run(
      baseOptions({ includeData: false, skipAutoIncrement: true })
    )
    expect(result).toMatchObject({ objectsRestored: 5, rowsInserted: 0, errors: [] })
    const statements = session.executed.map((s) => s.replace(/\s+/g, ' '))
    expect(statements.some((s) => s.startsWith('INSERT'))).toBe(false)
    expect(statements.some((s) => /AUTO_INCREMENT\s*=/.test(s))).toBe(false)
    expect(statements).toContain('CREATE TABLE `items` (`id` int) ENGINE=InnoDB')
    expect(statements).toContain(sourceSchema.tables[0].triggers![0].ddl)
    expect(statements).toContain(sourceSchema.views![0].ddl)
    expect(statements).toContain('SET FOREIGN_KEY_CHECKS = 0')
    expect(statements).toContain('SET FOREIGN_KEY_CHECKS = 1')
  })

  it('structure only without skipAutoIncrement («Restaurar objetos» › Estructura) still applies AUTO_INCREMENT', async () => {
    const { session } = await run(baseOptions({ includeData: false }))
    const statements = session.executed.map((s) => s.replace(/\s+/g, ' '))
    expect(statements).toContain('CREATE TABLE `items` (`id` int) ENGINE=InnoDB AUTO_INCREMENT=5')
    expect(statements).toContain('ALTER TABLE `items` AUTO_INCREMENT = 5')
    expect(statements.some((s) => s.startsWith('INSERT'))).toBe(false)
  })

  it('stripAutoIncrementOption removes only the table option, never the column attribute', () => {
    const ddl =
      'CREATE TABLE `t` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4'
    expect(stripAutoIncrementOption(ddl)).toBe(
      'CREATE TABLE `t` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    )
    expect(
      stripAutoIncrementOption('CREATE TABLE `t` (`id` int) AUTO_INCREMENT=3 ENGINE=InnoDB')
    ).toBe('CREATE TABLE `t` (`id` int) ENGINE=InnoDB')
    expect(stripAutoIncrementOption('CREATE TABLE `t` (`id` int) ENGINE=InnoDB')).toBe(
      'CREATE TABLE `t` (`id` int) ENGINE=InnoDB'
    )
  })

  it('restores the Navicat fixture (3 rows with escapes, empty table, view)', async () => {
    const { result, session } = await run(baseOptions({ backupPath: FIXTURE, createSchema: false }))
    expect(result).toMatchObject({ objectsRestored: 3, rowsInserted: 3, errors: [] })
    const insert = session.executed.find((s) => s.startsWith('INSERT INTO `account`'))!
    expect(insert).toContain(
      '(`id`, `name`, `note`, `payload`, `score`, `created`, `active`) VALUES (1, '
    )
    expect(insert).toContain("'O\\'Reilly'")
    expect(session.executed.some((s) => s.startsWith('INSERT INTO `empty_table`'))).toBe(false)
    expect(session.executed.some((s) => s.startsWith('CREATE DATABASE'))).toBe(false)
  })

  it('batches inserts by row count and by size', async () => {
    const path = join(dir, 'batching.nb3')
    const w = await Nb3Writer.create(path, { schema: 'x' })
    const small = w.beginObject('Table', 'small')
    for (let i = 0; i < 1200; i++) await small.addRow(`(${i})`)
    await small.finish({ ddl: 'CREATE TABLE small (id int)', fields: ['id'] })
    const big = w.beginObject('Table', 'big')
    const payload = 'y'.repeat(400 * 1024)
    for (let i = 0; i < 5; i++) await big.addRow(`(${i}, '${payload}')`)
    await big.finish({ ddl: 'CREATE TABLE big (id int, v longtext)', fields: ['id', 'v'] })
    await w.finish()

    const { result, session } = await run(baseOptions({ backupPath: path }))
    expect(result.rowsInserted).toBe(1205)
    const smallInserts = session.executed.filter((s) => s.startsWith('INSERT INTO `small`'))
    expect(smallInserts.map((s) => s.split('),(').length)).toEqual([
      BATCH_MAX_ROWS,
      BATCH_MAX_ROWS,
      200
    ])
    const bigInserts = session.executed.filter((s) => s.startsWith('INSERT INTO `big`'))
    // 400 KB rows: at most two fit under 1 MB.
    expect(bigInserts.map((s) => s.split('),(').length)).toEqual([2, 2, 1])
    for (const s of bigInserts) expect(Buffer.byteLength(s)).toBeLessThan(1024 * 1024 + 200)
  })

  it('retries DDL without DEFINER when the definer is rejected', async () => {
    const factory = new FakeSessionFactory()
    const original = factory.acquire.bind(factory)
    factory.acquire = async (...args) => {
      const s = await original(...args)
      s.failExecute = (sql) =>
        /DEFINER\s*=/.test(sql)
          ? Object.assign(new Error('Access denied; you need SUPER'), { errno: 1227 })
          : null
      return s
    }
    const { result, session } = await run(baseOptions(), factory)
    expect(result.errors).toEqual([])
    expect(session.executed).toContain(
      'CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v_items` AS select 1'
    )
    expect(session.executed).toContain('CREATE FUNCTION `f_one`() RETURNS int RETURN 1')
    expect(session.executed).toContain(
      'CREATE TRIGGER `tr` BEFORE INSERT ON `items` FOR EACH ROW SET @x = 1'
    )
  })

  it('data-only restore counts only tables as restored', async () => {
    const { result, session } = await run(baseOptions({ includeStructure: false }))
    expect(result).toMatchObject({ objectsRestored: 1, rowsInserted: 2, errors: [] })
    expect(session.executed.some((s) => /FUNCTION|PROCEDURE|VIEW|EVENT/.test(s))).toBe(false)
  })

  it('stops at the first failing object unless continueOnError is set', async () => {
    const failing = (factory: FakeSessionFactory): FakeSessionFactory => {
      const original = factory.acquire.bind(factory)
      factory.acquire = async (...args) => {
        const s = await original(...args)
        s.failExecute = (sql) =>
          sql.startsWith('CREATE TABLE') ? new Error("Table 'items' already exists") : null
        return s
      }
      return factory
    }
    const stopped = await run(baseOptions(), failing(new FakeSessionFactory()))
    expect(stopped.result.errors).toEqual([
      { object: 'items', message: "Table 'items' already exists" }
    ])
    expect(stopped.result.objectsRestored).toBe(0)
    expect(stopped.session.executed.some((s) => s.includes('FUNCTION `f_one`'))).toBe(false)
    expect(stopped.session.executed).toContain('SET FOREIGN_KEY_CHECKS = 1')

    const continued = await run(
      baseOptions({ continueOnError: true }),
      failing(new FakeSessionFactory())
    )
    expect(continued.result.errors).toHaveLength(1)
    expect(continued.result.objectsRestored).toBe(4)
  })

  it('resolves views that depend on views created later', async () => {
    const path = join(dir, 'views.nb3')
    const w = await Nb3Writer.create(path, { schema: 'x' })
    await w.beginObject('View', 'v_b').finish({ ddl: 'CREATE VIEW `v_b` AS SELECT * FROM `v_a`' })
    await w.beginObject('View', 'v_a').finish({ ddl: 'CREATE VIEW `v_a` AS SELECT 1' })
    await w.finish()
    const factory = new FakeSessionFactory()
    const original = factory.acquire.bind(factory)
    factory.acquire = async (...args) => {
      const s = await original(...args)
      s.failExecute = (sql) =>
        sql.includes('FROM `v_a`') && !s.executed.includes('CREATE VIEW `v_a` AS SELECT 1')
          ? new Error("Table 'x.v_a' doesn't exist")
          : null
      return s
    }
    const { result } = await run(baseOptions({ backupPath: path }), factory)
    expect(result).toMatchObject({ objectsRestored: 2, errors: [] })
  })

  it('restores only the selected objects and respects includeStructure/includeData', async () => {
    const dataOnly = await run(
      baseOptions({ objects: ['items'], includeStructure: false, createSchema: false })
    )
    expect(
      dataOnly.session.executed.filter((s) => !s.startsWith('SET') && !s.startsWith('USE'))
    ).toEqual(['INSERT INTO `items` (`id`) VALUES (1),(2)'])
    const structureOnly = await run(baseOptions({ objects: ['items'], includeData: false }))
    expect(structureOnly.session.executed.some((s) => s.startsWith('INSERT'))).toBe(false)
    await expect(run(baseOptions({ objects: ['nope'] }))).rejects.toThrow(/objetos seleccionados/)
  })

  it('cancels with "Restauración cancelada" and still resets the session', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      run(baseOptions(), new FakeSessionFactory(), 'local', controller.signal)
    ).rejects.toThrow(RESTORE_CANCELLED)

    const late = new AbortController()
    const factory = new FakeSessionFactory()
    const original = factory.acquire.bind(factory)
    factory.acquire = async (...args) => {
      const s = await original(...args)
      s.failExecute = (sql) => {
        if (sql.startsWith('CREATE TABLE')) late.abort()
        return null
      }
      return s
    }
    await expect(run(baseOptions(), factory, 'local', late.signal)).rejects.toThrow(
      RESTORE_CANCELLED
    )
    expect(factory.sessions[0].executed).toContain('SET UNIQUE_CHECKS = 1')
    expect(factory.sessions[0].released).toBe(true)
  })

  it('drops the DEFINER of accounts missing on the target (cross-server restores) and keeps existing ones', async () => {
    expect(
      definerOf('CREATE ALGORITHM=UNDEFINED DEFINER=`app`@`%` SQL SECURITY DEFINER VIEW v')
    ).toEqual({
      user: 'app',
      host: '%'
    })
    expect(definerOf("CREATE DEFINER='o''k'@'localhost' FUNCTION f()")).toEqual({
      user: "o''k",
      host: 'localhost'
    })
    expect(definerOf('CREATE SQL SECURITY DEFINER VIEW v AS SELECT 1')).toBeNull()

    const session = await new FakeSessionFactory().acquire('conn-1')
    const accounts: Record<string, number> = { 'root@localhost': 1 }
    session.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      session.queried.push(sql)
      return [{ n: accounts[`${params[0]}@${params[1]}`] ?? 0 }] as T[]
    }
    const definers = new DefinerAccounts(session)
    await executeDdl(
      session,
      'CREATE DEFINER=`app`@`%` TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET @a = 1',
      definers
    )
    await executeDdl(session, 'CREATE DEFINER=`root`@`localhost` PROCEDURE p() BEGIN END', definers)
    await executeDdl(
      session,
      'CREATE DEFINER=`app`@`%` EVENT e ON SCHEDULE EVERY 1 DAY DO SELECT 1',
      definers
    )
    expect(session.executed).toEqual([
      'CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET @a = 1',
      'CREATE DEFINER=`root`@`localhost` PROCEDURE p() BEGIN END',
      'CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO SELECT 1'
    ])
    // One lookup per account.
    expect(session.queried.filter((q) => q.includes('mysql.user'))).toHaveLength(2)
  })

  it('stripDefiner removes quoted and unquoted definers but keeps SQL SECURITY DEFINER', () => {
    expect(stripDefiner('CREATE DEFINER=`a`@`%` PROCEDURE p() BEGIN END')).toBe(
      'CREATE PROCEDURE p() BEGIN END'
    )
    expect(stripDefiner("CREATE DEFINER='u'@'localhost' FUNCTION f()")).toBe('CREATE FUNCTION f()')
    expect(stripDefiner('CREATE DEFINER=root@localhost EVENT e')).toBe('CREATE EVENT e')
    expect(stripDefiner('CREATE SQL SECURITY DEFINER VIEW v AS SELECT 1')).toBe(
      'CREATE SQL SECURITY DEFINER VIEW v AS SELECT 1'
    )
  })
})

describe('restore error hints (5.7 staging -> 8.x local)', () => {
  it('explains ER_BINLOG_UNSAFE_ROUTINE in Spanish and keeps the server message', () => {
    const err = {
      message: 'x',
      sqlMessage:
        'This function has none of DETERMINISTIC, NO SQL, or READS SQL DATA in its declaration',
      code: 'ER_BINLOG_UNSAFE_ROUTINE',
      errno: 1418
    }
    const text = describeRestoreError(err)
    expect(text).toMatch(
      /^Mensaje del servidor: This function has none of DETERMINISTIC.*\(ER_BINLOG_UNSAFE_ROUTINE 1418\)\. Pista: /
    )
    expect(text).toContain('SET GLOBAL log_bin_trust_function_creators = 1')
    expect(restoreErrorHint({ message: 'x', errno: 1273 })).toMatch(/utf8mb4_0900_ai_ci/)
    expect(restoreErrorHint({ message: 'x', errno: 1062 })).toBeNull()
    expect(describeRestoreError(new Error('plain'))).toBe('plain')
  })
})
