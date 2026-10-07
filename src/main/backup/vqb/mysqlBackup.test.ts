import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBackup } from '../create'
import { readArchiveMeta, verifyArchive } from '../archive'
import { restoreBackup } from '../restore'
import {
  FakeSessionFactory,
  connectionFixture,
  connectionsOf,
  type FakeSchema
} from '../testing/fakeSession'
import { VqbReader } from './reader'

const NOW = new Date(2026, 9, 7, 10, 0, 0)
const CHEAP = { N: 1024, r: 8, p: 1 }

function schema(): FakeSchema {
  return {
    tables: [
      {
        name: 'items',
        ddl: 'CREATE TABLE `items` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4',
        columns: [
          { name: 'id', columnType: 'bigint unsigned' },
          { name: 'blob', columnType: 'varbinary(8)' },
          { name: 'note', columnType: 'text' },
          { name: 'doc', columnType: 'json' },
          { name: 'big', columnType: 'decimal(30,2)' },
          { name: 'n', columnType: 'int' },
          { name: 'f', columnType: 'double' },
          { name: 'total', columnType: 'int', extra: 'VIRTUAL GENERATED' },
          { name: 'created', columnType: 'timestamp', extra: 'DEFAULT_GENERATED' }
        ],
        rows: [
          [
            '1',
            Buffer.from([0xde, 0xad]),
            "it's\nmultiline\\",
            '{"a": 1}',
            '12345678901234567890.55',
            7,
            1.25,
            '2026-01-02 03:04:05'
          ],
          [9007199254740993n, Buffer.alloc(0), null, null, null, null, null, null]
        ],
        triggers: [
          {
            name: 'items_bi',
            ddl: 'CREATE DEFINER=`root`@`%` TRIGGER `items_bi` BEFORE INSERT ON `items` FOR EACH ROW SET NEW.note = NEW.note'
          }
        ]
      }
    ],
    views: [{ name: 'v_items', ddl: 'CREATE VIEW `v_items` AS select 1' }],
    functions: [{ name: 'f_one', ddl: 'CREATE FUNCTION `f_one`() RETURNS int RETURN 1' }],
    events: [{ name: 'e_tick', ddl: 'CREATE EVENT `e_tick` ON SCHEDULE EVERY 1 DAY DO SELECT 1' }]
  }
}

describe('MySQL .vqb backups', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vqb-mysql-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const deps = (sessions: FakeSessionFactory) => ({
    connections: connectionsOf(connectionFixture({ id: 'c1', name: 'Staging', backupDir: dir })),
    sessions,
    now: () => NOW,
    scrypt: CHEAP
  })

  it('writes a .vqb with typed rows, triggers, AUTO_INCREMENT and the session time zone', async () => {
    const sessions = new FakeSessionFactory(schema())
    const result = await createBackup(deps(sessions), {
      connectionId: 'c1',
      schema: 'shop',
      includeData: true,
      format: 'vqb',
      label: 'nightly'
    })
    expect(result.path).toBe(join(dir, 'shop', '20261007100000-nightly.vqb'))
    expect(result.rows).toBe(2)
    expect(sessions.sessions[0].executed).toContain("SET SESSION time_zone = '+00:00'")
    const reader = await VqbReader.open(result.path)
    try {
      const m = await reader.manifest()
      expect(m.engine).toMatchObject({ id: 'mysql', flavor: 'mysql', serverVersion: '8.4.7' })
      expect(m.source).toMatchObject({
        connectionName: 'Staging',
        database: 'shop',
        timeZone: '+00:00'
      })
      expect(m.objects.map((o) => `${o.type}:${o.name}`)).toEqual([
        'table:items',
        'view:v_items',
        'function:f_one',
        'event:e_tick'
      ])
      const meta = await reader.objectMeta('000001')
      expect(meta.autoIncrement).toBe('42')
      expect(meta.triggers).toHaveLength(1)
      // Generated columns are not stored (they cannot be inserted).
      expect(meta.columns!.map((c) => c.name)).not.toContain('total')
      const rows: unknown[] = []
      await reader.rows(meta, (r) => {
        rows.push(r)
      })
      expect(rows).toEqual([
        [
          1,
          { $bin: '3q0=' },
          "it's\nmultiline\\",
          { $json: '{"a": 1}' },
          { $dec: '12345678901234567890.55' },
          7,
          1.25,
          { $dt: '2026-01-02 03:04:05' }
        ],
        [{ $bigint: '9007199254740993' }, { $bin: '' }, null, null, null, null, null, null]
      ])
    } finally {
      await reader.close()
    }
  })

  it('omits the connection name when asked', async () => {
    const result = await createBackup(deps(new FakeSessionFactory(schema())), {
      connectionId: 'c1',
      schema: 'shop',
      includeData: true,
      format: 'vqb',
      omitConnectionName: true
    })
    const meta = await readArchiveMeta(result.path)
    expect(meta.connectionName).toBeNull()
    expect(readFileSync(result.path).includes(Buffer.from('Staging'))).toBe(false)
  })

  it('restores the same INSERTs from a .vqb as from a .nb3 of the same data', async () => {
    const make = async (format: 'nb3' | 'vqb'): Promise<string[]> => {
      const created = await createBackup(deps(new FakeSessionFactory(schema())), {
        connectionId: 'c1',
        schema: 'shop',
        includeData: true,
        format,
        targetDir: join(dir, format)
      })
      const target = new FakeSessionFactory()
      await restoreBackup(
        { connections: deps(target).connections, sessions: target },
        {
          backupPath: created.path,
          connectionId: 'c1',
          targetSchema: 'copy',
          createSchema: true,
          dropObjectsFirst: false,
          includeStructure: true,
          includeData: true,
          continueOnError: false
        }
      )
      return target.sessions[0].executed
    }
    const nb3 = await make('nb3')
    const vqb = await make('vqb')
    const inserts = (list: string[]): string[] => list.filter((s) => s.startsWith('INSERT'))
    expect(inserts(vqb)).toEqual(inserts(nb3))
    expect(inserts(vqb)[0]).toContain(
      "0xDEAD, 'it\\'s\\nmultiline\\\\', '{\\\"a\\\": 1}', 12345678901234567890.55, 7, 1.25, '2026-01-02 03:04:05'"
    )
    // The .vqb restore reads TIMESTAMP text in the time zone it was written in.
    expect(vqb).toContain('SET time_zone = ? -- ["+00:00"]')
    expect(nb3.some((s) => s.startsWith('SET time_zone'))).toBe(false)
    // Same DDL order: table, trigger, AUTO_INCREMENT, routine, view, event.
    const ddl = (list: string[]): string[] =>
      list.filter((s) => /^(CREATE|ALTER)/.test(s)).map((s) => s.slice(0, 40))
    expect(ddl(vqb)).toEqual(ddl(nb3))
  })

  it('encrypts with a password and needs it to restore', async () => {
    const created = await createBackup(deps(new FakeSessionFactory(schema())), {
      connectionId: 'c1',
      schema: 'shop',
      includeData: true,
      format: 'vqb',
      password: 'very secret'
    })
    expect(readFileSync(created.path).includes(Buffer.from('items'))).toBe(false)
    const locked = await readArchiveMeta(created.path)
    expect(locked).toMatchObject({ format: 'vqb', encrypted: true, locked: true, objects: [] })
    const open = await readArchiveMeta(created.path, 'very secret')
    expect(open.objects.map((o) => o.name)).toEqual(['items', 'v_items', 'f_one', 'e_tick'])
    await expect(readArchiveMeta(created.path, 'nope nope')).rejects.toThrow(
      'Contraseña incorrecta'
    )
    expect((await verifyArchive(created.path, undefined, 'very secret')).rows).toBe(2)

    const target = new FakeSessionFactory()
    const restore = (password?: string) =>
      restoreBackup(
        { connections: deps(target).connections, sessions: target },
        {
          backupPath: created.path,
          connectionId: 'c1',
          targetSchema: 'copy',
          createSchema: true,
          dropObjectsFirst: false,
          includeStructure: true,
          includeData: true,
          continueOnError: false,
          password
        }
      )
    await expect(restore()).rejects.toThrow('La copia está cifrada')
    await expect(restore('wrong password')).rejects.toThrow('Contraseña incorrecta')
    // Nothing reached the server before the password was right.
    expect(target.sessions).toHaveLength(0)
    const ok = await restore('very secret')
    expect(ok.rowsInserted).toBe(2)
  })

  it('refuses short passwords and encryption of .nb3', async () => {
    const run = (extra: object) =>
      createBackup(deps(new FakeSessionFactory(schema())), {
        connectionId: 'c1',
        schema: 'shop',
        includeData: true,
        ...extra
      })
    await expect(run({ format: 'vqb', password: 'short' })).rejects.toThrow('al menos 8')
    await expect(run({ format: 'nb3', password: 'long enough' })).rejects.toThrow(
      'Solo las copias .vqb'
    )
    expect(readdirSync(dir)).toEqual([])
  })
})
