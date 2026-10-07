import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { splitStatements } from '@shared/dialects/mysql'
import type { ProgressReporter } from './index'
import {
  EXPORT_CANCELLED,
  exportSchemaToSql,
  INSERT_MAX_ROWS,
  orderViews,
  unqualifyTriggerDdl
} from './sqlExport'
import { formatSqlDumpFileName, isSqlDumpFileName } from './naming'
import {
  FakeSessionFactory,
  connectionFixture,
  connectionsOf,
  type FakeSchema
} from './testing/fakeSession'

const NOW = new Date(2026, 9, 5, 10, 11, 12)

function schemaFixture(): FakeSchema {
  return {
    tables: [
      {
        name: 'items',
        ddl: 'CREATE TABLE `items` (\n  `id` bigint NOT NULL,\n  `total` int GENERATED ALWAYS AS (1) VIRTUAL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
        columns: [
          { name: 'id', columnType: 'bigint unsigned' },
          { name: 'blob', columnType: 'varbinary(8)' },
          { name: 'note', columnType: 'text' },
          { name: 'big', columnType: 'decimal(30,2)' },
          { name: 'total', columnType: 'int', extra: 'VIRTUAL GENERATED' }
        ],
        rows: [
          ['1', Buffer.from([0x00, 0xad]), "it's\nmulti;line\\", '12345678901234567890.55'],
          ['18446744073709551615', null, null, null]
        ],
        triggers: [
          {
            name: 'items_bi',
            ddl: "CREATE DEFINER=`root`@`%` TRIGGER `items_bi` BEFORE INSERT ON `items` FOR EACH ROW BEGIN SET NEW.note = CONCAT(NEW.note, ';'); END"
          }
        ]
      },
      { name: 'empty', columns: [{ name: 'id', columnType: 'int' }], rows: [] }
    ],
    views: [
      {
        name: 'a_top',
        ddl: 'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `a_top` AS select `b_base`.`id` AS `id` from `b_base`'
      },
      {
        name: 'b_base',
        ddl: 'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `b_base` AS select `items`.`id` AS `id` from `items`'
      }
    ],
    functions: [
      {
        name: 'f_one',
        ddl: 'CREATE DEFINER=`root`@`%` FUNCTION `f_one`() RETURNS int DETERMINISTIC BEGIN RETURN 1; END'
      }
    ],
    procedures: [
      {
        name: 'p_two',
        ddl: 'CREATE DEFINER=`root`@`%` PROCEDURE `p_two`() BEGIN SELECT 1; SELECT 2; END'
      }
    ],
    events: [
      {
        name: 'e_daily',
        ddl: 'CREATE DEFINER=`root`@`%` EVENT `e_daily` ON SCHEDULE EVERY 1 DAY DO DELETE FROM `items` WHERE id = 0'
      }
    ]
  }
}

describe('exportSchemaToSql', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-sqlexport-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const deps = (db: FakeSchema = schemaFixture()) => ({
    connections: connectionsOf(connectionFixture({ backupDir: dir })),
    sessions: new FakeSessionFactory(db),
    now: () => NOW
  })

  const base = {
    connectionId: 'conn-1',
    schema: 'shop',
    includeStructure: true,
    includeData: true,
    includeCreateDatabase: false
  }

  it('writes a dump the mysql client can split, in dependency order', async () => {
    const d = deps()
    const events: Parameters<ProgressReporter>[0][] = []
    const result = await exportSchemaToSql(d, base, (e) => events.push(e))
    expect(result.path).toBe(join(dir, 'shop', '20261005101112.sql'))
    expect(result.objects).toBe(7)
    expect(result.rows).toBe(2)
    const sql = readFileSync(result.path, 'utf8')
    expect(sql.startsWith('-- Vortaq SQL dump')).toBe(true)
    expect(sql).toContain("/*!40103 SET TIME_ZONE='+00:00' */;")
    expect(sql).not.toContain('CREATE DATABASE')
    // Generated column left out of the INSERT; binary as hex; text escaped.
    expect(sql).toContain(
      "INSERT INTO `items` (`id`, `blob`, `note`, `big`) VALUES\n(1, 0x00AD, 'it\\'s\\nmulti;line\\\\', 12345678901234567890.55),\n(18446744073709551615, NULL, NULL, NULL);"
    )
    const statements = splitStatements(sql).map((s) => s.sql)
    const idx = (needle: string): number => statements.findIndex((s) => s.includes(needle))
    // Table, data, trigger after data; routines; views ordered by dependency; events last.
    expect(idx('CREATE TABLE `items`')).toBeLessThan(idx('INSERT INTO `items`'))
    expect(idx('INSERT INTO `items`')).toBeLessThan(idx('TRIGGER `items_bi`'))
    expect(idx('FUNCTION `f_one`')).toBeLessThan(idx('VIEW `b_base`'))
    expect(idx('VIEW `b_base`')).toBeLessThan(idx('VIEW `a_top`'))
    expect(idx('VIEW `a_top`')).toBeLessThan(idx('EVENT `e_daily`'))
    // Bodies with semicolons stay whole thanks to DELIMITER ;;
    expect(statements).toContain(
      'CREATE DEFINER=`root`@`%` PROCEDURE `p_two`() BEGIN SELECT 1; SELECT 2; END'
    )
    expect(statements.some((s) => s.startsWith('CREATE DEFINER=`root`@`%` TRIGGER'))).toBe(true)
    expect(sql.trimEnd().endsWith('-- Fin de la exportación')).toBe(true)
    expect(events.map((e) => e.phase)).toContain('finish')
    expect(events.find((e) => e.phase === 'object')?.message).toMatch(/^Exportando tabla /)
    expect(existsSync(`${result.path}.partial`)).toBe(false)
    // Session: UTC for TIMESTAMP text, consistent snapshot, released.
    const session = d.sessions.sessions[0]
    expect(session.executed[0]).toBe("SET SESSION time_zone = '+00:00'")
    expect(session.executed).toContain('START TRANSACTION WITH CONSISTENT SNAPSHOT')
    expect(session.released).toBe(true)
  })

  it('adds CREATE DATABASE and USE on request, gzip and a label', async () => {
    const result = await exportSchemaToSql(deps(), {
      ...base,
      includeCreateDatabase: true,
      gzip: true,
      label: 'para otro'
    })
    expect(result.path).toBe(join(dir, 'shop', '20261005101112-para otro.sql.gz'))
    const sql = gunzipSync(readFileSync(result.path)).toString('utf8')
    expect(sql).toContain('CREATE DATABASE /*!32312 IF NOT EXISTS*/ `shop`;\n\nUSE `shop`;')
  })

  it('structure only has no INSERT; data only has no DDL', async () => {
    const structure = await exportSchemaToSql(deps(), { ...base, includeData: false })
    const s = readFileSync(structure.path, 'utf8')
    expect(s).not.toContain('INSERT INTO')
    expect(s).toContain('CREATE TABLE `items`')
    expect(structure.rows).toBe(0)

    const data = await exportSchemaToSql(deps(), { ...base, includeStructure: false })
    const t = readFileSync(data.path, 'utf8')
    expect(t).toContain('INSERT INTO `items`')
    expect(t).not.toMatch(/CREATE (TABLE|DEFINER|ALGORITHM)|DROP /)
    expect(data.objects).toBe(2)
  })

  it('splits large tables into extended INSERT batches', async () => {
    const db: FakeSchema = {
      tables: [
        {
          name: 'n',
          columns: [{ name: 'id', columnType: 'int' }],
          rows: Array.from({ length: INSERT_MAX_ROWS * 2 + 3 }, (_, i) => [i])
        }
      ]
    }
    const result = await exportSchemaToSql(deps(db), base)
    const sql = readFileSync(result.path, 'utf8')
    expect(sql.match(/INSERT INTO `n`/g)).toHaveLength(3)
    expect(result.rows).toBe(INSERT_MAX_ROWS * 2 + 3)
  })

  it('removes the partial file when an object fails, and unique names never clash', async () => {
    const db = schemaFixture()
    db.procedures = [{ name: 'p_two', ddl: '' }]
    await expect(exportSchemaToSql(deps(db), base)).rejects.toThrow(
      /Error al exportar procedimiento p_two/
    )
    expect(readdirSync(join(dir, 'shop'))).toEqual([])
    const a = await exportSchemaToSql(deps(), base)
    const b = await exportSchemaToSql(deps(), base)
    expect(a.path).not.toBe(b.path)
    expect(b.path.endsWith('20261005101112-2.sql')).toBe(true)
  })

  it('throws «Exportación cancelada» and leaves no file', async () => {
    const controller = new AbortController()
    const promise = exportSchemaToSql(
      deps(),
      base,
      (e) => {
        if (e.phase === 'object') controller.abort()
      },
      controller.signal
    )
    await expect(promise).rejects.toThrow(EXPORT_CANCELLED)
    expect(readdirSync(join(dir, 'shop'))).toEqual([])
  })

  it('validates options and honours targetPath and the objects filter', async () => {
    await expect(
      exportSchemaToSql(deps(), { ...base, includeData: false, includeStructure: false })
    ).rejects.toThrow(/estructura, los datos o ambos/)
    const target = join(dir, 'elegido.sql')
    const result = await exportSchemaToSql(deps(), {
      ...base,
      targetPath: target,
      objects: ['empty']
    })
    expect(result.path).toBe(target)
    expect(result.objects).toBe(1)
    expect(readFileSync(target, 'utf8')).not.toContain('`items`')
  })
})

describe('orderViews', () => {
  it('puts a view after the views it mentions and survives cycles', () => {
    const order = orderViews([
      { name: 'c', ddl: 'CREATE VIEW `c` AS select * from `b`' },
      { name: 'b', ddl: 'CREATE VIEW `b` AS select * from `a`' },
      { name: 'a', ddl: 'CREATE VIEW `a` AS select 1' }
    ]).map((v) => v.name)
    expect(order).toEqual(['a', 'b', 'c'])
    const cycle = orderViews([
      { name: 'x', ddl: 'CREATE VIEW `x` AS select * from `y`' },
      { name: 'y', ddl: 'CREATE VIEW `y` AS select * from `x`' }
    ]).map((v) => v.name)
    expect(cycle.sort()).toEqual(['x', 'y'])
  })
})

describe('sql dump names', () => {
  it('uses the backup stamp with .sql / .sql.gz', () => {
    expect(formatSqlDumpFileName(NOW, 'a/b')).toBe('20261005101112-a-b.sql')
    expect(formatSqlDumpFileName(NOW, null, true)).toBe('20261005101112.sql.gz')
    expect(isSqlDumpFileName('x.SQL')).toBe(true)
    expect(isSqlDumpFileName('x.sql.gz')).toBe(true)
    expect(isSqlDumpFileName('x.nb3')).toBe(false)
  })
})

describe('unqualifyTriggerDdl', () => {
  it('drops the source schema from the trigger name and table, never from the body', () => {
    expect(
      unqualifyTriggerDdl(
        'CREATE DEFINER=`root`@`%` TRIGGER shop.t_bi BEFORE INSERT ON `shop` . `items` FOR EACH ROW SET NEW.x = (SELECT 1 FROM shop.other)',
        'shop'
      )
    ).toBe(
      'CREATE DEFINER=`root`@`%` TRIGGER t_bi BEFORE INSERT ON `items` FOR EACH ROW SET NEW.x = (SELECT 1 FROM shop.other)'
    )
    const plain = 'CREATE TRIGGER `t` AFTER UPDATE ON `items` FOR EACH ROW BEGIN END'
    expect(unqualifyTriggerDdl(plain, 'shop')).toBe(plain)
    expect(
      unqualifyTriggerDdl('CREATE TRIGGER `a.b` BEFORE INSERT ON x FOR EACH ROW SET @a=1', 'a')
    ).toBe('CREATE TRIGGER `a.b` BEFORE INSERT ON x FOR EACH ROW SET @a=1')
  })
})
