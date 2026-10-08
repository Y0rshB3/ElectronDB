import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BACKUP_CANCELLED, createBackup, parseAutoIncrement } from './create'
import type { ProgressReporter } from './index'
import { readManifest, Nb3Reader } from './nb3/reader'
import {
  FakeSessionFactory,
  connectionFixture,
  connectionsOf,
  type FakeSchema
} from './testing/fakeSession'

const NOW = new Date(2026, 9, 5, 10, 11, 12)

type ProgressPayload = Parameters<ProgressReporter>[0]

function schemaFixture(): FakeSchema {
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
          { name: 'total', columnType: 'int', extra: 'VIRTUAL GENERATED' },
          { name: 'created', columnType: 'timestamp', extra: 'DEFAULT_GENERATED' }
        ],
        rows: [
          [
            '1',
            Buffer.from([0xde, 0xad]),
            "it's\nmultiline\\",
            { a: 1 },
            '12345678901234567890.55',
            '2026-01-02 03:04:05'
          ],
          [9007199254740993n, null, null, null, null, null]
        ],
        triggers: [
          {
            name: 'items_bi',
            ddl: 'CREATE DEFINER=`root`@`%` TRIGGER `items_bi` BEFORE INSERT ON `items` FOR EACH ROW SET NEW.note = NEW.note'
          }
        ]
      },
      { name: 'empty', columns: [{ name: 'id', columnType: 'int' }], rows: [] }
    ],
    views: [
      {
        name: 'v_items',
        ddl: 'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v_items` AS select 1'
      }
    ],
    functions: [
      {
        name: 'f_one',
        ddl: 'CREATE DEFINER=`root`@`%` FUNCTION `f_one`() RETURNS int DETERMINISTIC RETURN 1'
      }
    ],
    procedures: [
      { name: 'p_noop', ddl: 'CREATE DEFINER=`root`@`%` PROCEDURE `p_noop`() BEGIN END' }
    ],
    events: [
      {
        name: 'e_tick',
        ddl: 'CREATE DEFINER=`root`@`%` EVENT `e_tick` ON SCHEDULE EVERY 1 DAY DO SELECT 1'
      }
    ]
  }
}

describe('createBackup', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-create-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const deps = (factory: FakeSessionFactory, backupDir = dir) => ({
    connections: connectionsOf(connectionFixture({ backupDir })),
    sessions: factory,
    now: () => NOW
  })

  it('writes every object type into <backupDir>/<schema>/<stamp>-<label>.nb3 and round-trips rows', async () => {
    const factory = new FakeSessionFactory(schemaFixture())
    const events: string[] = []
    const result = await createBackup(
      deps(factory),
      {
        connectionId: 'conn-1',
        schema: 'shop',
        includeData: true,
        label: 'nightly',
        comment: 'hola'
      },
      (e) => events.push(e.message)
    )
    expect(result.path).toBe(join(dir, 'shop', '20261005101112-nightly.nb3'))
    expect(result).toMatchObject({ objects: 6, rows: 2 })
    expect(events.some((m) => m.includes('tabla items'))).toBe(true)
    expect(factory.sessions[0].released).toBe(true)
    expect(factory.sessions[0].schema).toBe('shop')
    expect(factory.sessions[0].executed).toEqual([
      'START TRANSACTION WITH CONSISTENT SNAPSHOT',
      // Fresh row estimates for the progress bar, restored right after listing.
      'SET SESSION information_schema_stats_expiry = 0',
      'SET SESSION information_schema_stats_expiry = DEFAULT',
      'COMMIT'
    ])

    const meta = await readManifest(result.path)
    expect(meta.comment).toBe('hola')
    expect(meta.objects.map((o) => `${o.type}:${o.name}:${o.rows}`)).toEqual([
      'Table:empty:0',
      'Table:items:2',
      'View:v_items:null',
      'Function:f_one:null',
      'Procedure:p_noop:null',
      'Event:e_tick:null'
    ])

    const reader = await Nb3Reader.open(result.path)
    const items = await reader.objectMeta(meta.objects[1].uuid)
    expect(items.Fields).toEqual(['id', 'blob', 'note', 'doc', 'big', 'created'])
    expect(items.AutoIncrement).toBe('42')
    expect(items.TriggerDDL).toEqual([expect.stringContaining('TRIGGER `items_bi`')])
    expect(items.IndexDDL).toEqual([])
    const rows: string[] = []
    await reader.rows(items, (r) => {
      rows.push(r)
    })
    expect(rows).toEqual([
      "(1, 0xDEAD, 'it\\'s\\nmultiline\\\\', '{\\\"a\\\":1}', 12345678901234567890.55, '2026-01-02 03:04:05')",
      '(9007199254740993, NULL, NULL, NULL, NULL, NULL)'
    ])
    // The generated column is neither selected nor stored.
    expect(factory.sessions[0].queried.find((q) => q.endsWith('FROM `items`'))).toBe(
      'SELECT `id`, `blob`, `note`, `doc`, `big`, `created` FROM `items`'
    )
    const empty = await reader.objectMeta(meta.objects[0].uuid)
    expect(empty.Data).toEqual([])
    const view = await reader.objectMeta(meta.objects[2].uuid)
    expect(view.DDL).toContain('VIEW `v_items`')
  })

  it('reports structured per-object events: list, start, done with rows, error', async () => {
    const events: ProgressPayload[] = []
    await createBackup(
      deps(new FakeSessionFactory(schemaFixture())),
      { connectionId: 'conn-1', schema: 'shop', includeData: true },
      (e) => events.push(e)
    )
    expect(events[0]).toMatchObject({
      phase: 'list',
      total: 6,
      message: '6 objetos (2 tablas, 1 vista, 1 función, 1 procedimiento, 1 evento)',
      detail: { objects: 6, objectsDone: 0 }
    })
    const done = events.filter((e) => e.phase === 'objectDone')
    expect(done.map((e) => [e.detail?.objectType, e.detail?.objectName, e.detail?.rows])).toEqual([
      ['Table', 'empty', 0],
      ['Table', 'items', 2],
      ['View', 'v_items', null],
      ['Function', 'f_one', null],
      ['Procedure', 'p_noop', null],
      ['Event', 'e_tick', null]
    ])
    expect(done.map((e) => e.detail?.objectsDone)).toEqual([1, 2, 3, 4, 5, 6])
    expect(done[1]).toMatchObject({ current: 2, total: 6, detail: { objectIndex: 2, objects: 6 } })
    const started = events.find((e) => e.phase === 'object' && e.detail?.objectName === 'items')
    expect(started?.detail).toMatchObject({ objectIndex: 2, objectsDone: 1, rows: 0 })

    // Structure-only tables report null rows; a failing object reports its error.
    const db = schemaFixture()
    db.views![0].ddl = ''
    const failing: ProgressPayload[] = []
    await expect(
      createBackup(
        deps(new FakeSessionFactory(db)),
        { connectionId: 'conn-1', schema: 'shop', includeData: false },
        (e) => failing.push(e)
      )
    ).rejects.toThrow(/vista v_items/)
    expect(failing.find((e) => e.phase === 'objectDone')?.detail?.rows).toBeNull()
    const error = failing.find((e) => e.phase === 'objectError')
    expect(error?.detail).toMatchObject({ objectType: 'View', objectName: 'v_items' })
    expect(error?.detail?.error).toMatch(/permisos/)
    // Never row data in any event.
    expect(JSON.stringify(events)).not.toContain('multiline')
  })

  it('weights progress by estimated rows so it advances inside a large table', async () => {
    const big: FakeSchema = {
      tables: [
        { name: 'a_small', columns: [{ name: 'id', columnType: 'int' }], rows: [[1]] },
        {
          name: 'b_big',
          columns: [{ name: 'id', columnType: 'int' }],
          rows: Array.from({ length: 12_000 }, (_, i) => [i]),
          // InnoDB estimates are approximate: fewer than the real rows here.
          estimatedRows: 10_000
        }
      ]
    }
    const events: ProgressPayload[] = []
    await createBackup(
      deps(new FakeSessionFactory(big)),
      { connectionId: 'conn-1', schema: 'shop', includeData: true },
      (e) => events.push(e)
    )
    const workTotal = events[0].detail?.workTotal ?? 0
    // 1 + 1/1000 for a_small, 1 + 10000/1000 for b_big.
    expect(workTotal).toBeCloseTo(12.001, 5)
    const rowEvents = events.filter((e) => e.phase === 'rows')
    expect(rowEvents.map((e) => e.detail?.rows)).toEqual([5000, 10000])
    expect(rowEvents.every((e) => e.detail?.rowsEstimate === 10_000)).toBe(true)
    const work = events
      .map((e) => e.detail?.workDone)
      .filter((w): w is number => typeof w === 'number')
    // Monotonic, never past the total, and moving while b_big is still being written.
    for (let i = 1; i < work.length; i++) expect(work[i]).toBeGreaterThanOrEqual(work[i - 1])
    expect(rowEvents[0].detail!.workDone!).toBeGreaterThan(1.001)
    expect(rowEvents[1].detail!.workDone!).toBeLessThan(workTotal)
    const last = events.filter((e) => e.phase === 'objectDone').at(-1)
    expect(last?.detail?.workDone).toBeCloseTo(workTotal, 5)

    // Structure only: one unit per object, no row estimate.
    const structure: ProgressPayload[] = []
    await createBackup(
      deps(new FakeSessionFactory(big)),
      { connectionId: 'conn-1', schema: 'shop', includeData: false },
      (e) => structure.push(e)
    )
    expect(structure[0].detail?.workTotal).toBe(2)
    expect(structure.find((e) => e.phase === 'object')?.detail?.rowsEstimate).toBeNull()
  })

  it('filters objects, honours targetDir and skips rows without includeData', async () => {
    const factory = new FakeSessionFactory(schemaFixture())
    const target = join(dir, 'custom')
    const result = await createBackup(deps(factory), {
      connectionId: 'conn-1',
      schema: 'shop',
      includeData: false,
      objects: ['items', 'f_one'],
      targetDir: target
    })
    expect(result.path).toBe(join(target, '20261005101112.nb3'))
    const meta = await readManifest(result.path)
    expect(meta.objects.map((o) => o.name)).toEqual(['items', 'f_one'])
    expect(meta.objects[0].rows).toBe(0)
    expect(factory.sessions[0].queried.some((q) => q.startsWith('SELECT `id`'))).toBe(false)
  })

  it('never overwrites an existing backup with the same timestamp', async () => {
    const factory = new FakeSessionFactory(schemaFixture())
    const a = await createBackup(deps(factory), {
      connectionId: 'conn-1',
      schema: 'shop',
      includeData: false
    })
    const b = await createBackup(deps(factory), {
      connectionId: 'conn-1',
      schema: 'shop',
      includeData: false
    })
    expect(a.path).not.toBe(b.path)
    expect(b.path.endsWith('20261005101112-2.nb3')).toBe(true)
  })

  it('cancels: removes the partial file and throws "Backup cancelado"', async () => {
    const factory = new FakeSessionFactory(schemaFixture())
    const controller = new AbortController()
    await expect(
      createBackup(
        deps(factory),
        { connectionId: 'conn-1', schema: 'shop', includeData: true },
        (e) => {
          if (e.message.includes('items')) controller.abort()
        },
        controller.signal
      )
    ).rejects.toThrow(BACKUP_CANCELLED)
    expect(readdirSync(join(dir, 'shop'))).toEqual([])
    expect(factory.sessions[0].released).toBe(true)
  })

  it('removes the partial file when an object fails and reports which one', async () => {
    const db = schemaFixture()
    db.views![0].ddl = ''
    const factory = new FakeSessionFactory(db)
    await expect(
      createBackup(deps(factory), { connectionId: 'conn-1', schema: 'shop', includeData: true })
    ).rejects.toThrow(/vista v_items/)
    expect(readdirSync(join(dir, 'shop'))).toEqual([])
  })

  it('validates inputs with actionable messages', async () => {
    const factory = new FakeSessionFactory()
    await expect(
      createBackup(deps(factory), { connectionId: 'conn-1', schema: ' ', includeData: true })
    ).rejects.toThrow(/base de datos/)
    await expect(
      createBackup(deps(factory), { connectionId: 'nope', schema: 's', includeData: true })
    ).rejects.toThrow(/conexión/)
    await expect(
      createBackup(deps(factory, ''), { connectionId: 'conn-1', schema: 's', includeData: true })
    ).rejects.toThrow(/carpeta de copias/)
    expect(existsSync(join(dir, 's'))).toBe(false)
  })

  it('parses AUTO_INCREMENT from MySQL and spaced (.nb3) DDL only from table options', () => {
    expect(parseAutoIncrement(') ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=x')).toBe('7')
    expect(
      parseAutoIncrement(') ENGINE = InnoDB AUTO_INCREMENT = 12 CHARACTER SET = utf8mb4')
    ).toBe('12')
    expect(parseAutoIncrement('`id` int NOT NULL AUTO_INCREMENT,\n) ENGINE=InnoDB')).toBe('')
  })
})
