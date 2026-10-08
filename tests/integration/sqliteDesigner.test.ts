/**
 * SQLite table designer (P3) end to end on real files: db:tableStructure →
 * the renderer planner → sqlite:alterTable (in place or the extended rebuild).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectionInput, QueryStatementResult } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import { defaultSqliteOptions } from '@shared/engines'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { ConnectionManager } from '@main/db/manager'
import { createSqliteDbHandlers, type SqliteDbHandlers } from '@main/ipc/dbSqlite'
import { createSqliteDriver, createSqliteFile } from '@main/sqlite/driver'
import { inProcessSpawner } from '@main/sqlite/spawner'
import {
  sqliteBuildAlter,
  sqliteDraftFromStructure,
  sqliteEmptyColumn
} from '../../src/renderer/src/components/designer/sqlite/planner'
import type { TableDraft } from '../../src/renderer/src/utils/tableDesigner'

function input(filePath: string, overrides: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    name: 'Designer IT',
    color: null,
    environment: 'local',
    host: '',
    port: 0,
    username: '',
    authMode: 'none',
    savePassword: false,
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
    backupDir: '',
    extraBackupDirs: [],
    engine: 'sqlite',
    sqlite: { ...defaultSqliteOptions(false), filePath, foreignKeys: true },
    ...overrides
  }
}

const ok = (results: QueryStatementResult[]): QueryStatementResult[] => {
  const failed = results.find((r) => r.error)
  if (failed) throw new Error(`${failed.sql}: ${failed.error}`)
  return results
}

describe('SQLite table designer (integration, real files)', () => {
  let dir: string
  let ctx: AppContext
  let manager: ConnectionManager
  let lite: SqliteDbHandlers
  let id: string
  let n = 0

  const exec = (sql: string) => lite.execute(id, sql, { sessionKey: 'designer' })
  const rows = async (sql: string) => ok(await exec(sql))[0].resultSet!.rows

  /** Loads the structure, lets `edit` change the draft, plans and applies it. */
  async function design(table: string, edit: (d: TableDraft) => void, options = {}) {
    const structure = await lite.tableStructure(id, 'main', table)
    const draft = sqliteDraftFromStructure(structure)
    edit(draft)
    const plan = sqliteBuildAlter(structure, draft)
    expect(plan.problems).toEqual([])
    const result = await lite.alterTable(id, 'main', plan.request!, options)
    return { plan, result }
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-sqlite-designer-'))
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
    const spawner = inProcessSpawner()
    manager = new ConnectionManager(ctx, { drivers: async () => createSqliteDriver(() => spawner) })
    lite = createSqliteDbHandlers(ctx, manager)
    mkdirSync(join(dir, 'files'))
  })

  beforeEach(async () => {
    await manager.closeAll()
    const file = join(dir, 'files', `db${++n}.db`)
    await createSqliteFile(file, inProcessSpawner())
    id = ctx.connections.save(input(file, { name: `Designer ${n}` })).id
    ok(
      await exec(`
        CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE item (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL COLLATE NOCASE,
          price TEXT,
          parent_id INTEGER REFERENCES parent(id),
          CHECK (length(name) > 0)
        );
        CREATE INDEX ix_item_name ON item(name);
        CREATE TABLE audit (msg TEXT);
        CREATE TRIGGER trg_item AFTER INSERT ON item BEGIN
          INSERT INTO audit VALUES ('nuevo ' || NEW.name);
        END;
        CREATE VIEW v_item AS SELECT i.name, p.name AS parent FROM item i LEFT JOIN parent p ON p.id = i.parent_id;
        INSERT INTO parent VALUES (1, 'uno');
        INSERT INTO item (name, price, parent_id) VALUES ('a', '1.5', 1), ('b', 'x', 1), ('c', '3', NULL);
        DELETE FROM item WHERE name = 'c';
      `)
    )
  })

  afterAll(async () => {
    await manager.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rebuilds a type change keeping rows, storage classes, the counter, indexes, triggers and views', async () => {
    const { plan, result } = await design('item', (d) => {
      d.columns.find((c) => c.name === 'price')!.columnType = 'REAL'
    })
    expect(plan.rebuild?.reason).toContain('«price»')
    expect(result.warnings).toEqual([])
    expect(result.applied).toContain('COMMIT')
    // REAL affinity converts '1.5', keeps 'x' as text (dynamic typing).
    expect(await rows('SELECT id, name, price, typeof(price) FROM item ORDER BY id')).toEqual([
      [1, 'a', 1.5, 'real'],
      [2, 'b', 'x', 'text']
    ])
    // AUTOINCREMENT high-water mark: id 3 was used and deleted, the next id is 4.
    ok(await exec("INSERT INTO item (name) VALUES ('d')"))
    expect(await rows("SELECT id FROM item WHERE name = 'd'")).toEqual([[4]])
    // The trigger was recreated (it fired for 'd'); the view and the index are back.
    expect(await rows('SELECT msg FROM audit ORDER BY rowid DESC LIMIT 1')).toEqual([['nuevo d']])
    expect(await rows('SELECT name FROM v_item ORDER BY name')).toEqual([['a'], ['b'], ['d']])
    const structure = await lite.tableStructure(id, 'main', 'item')
    expect(structure.indexes.map((i) => i.name)).toContain('ix_item_name')
    expect(structure.createSql).toContain('COLLATE NOCASE')
    expect(structure.createSql).toContain('CHECK (length(name) > 0)')
    expect(await rows('PRAGMA foreign_keys')).toEqual([[1]])
    expect(
      await rows("SELECT count(*) FROM sqlite_schema WHERE name LIKE '__vortaq_new_%'")
    ).toEqual([[0]])
  })

  it('reports pre-existing FK violations as warnings and does not block', async () => {
    ok(
      await exec(
        "PRAGMA foreign_keys = OFF; INSERT INTO item (name, parent_id) VALUES ('huérfano', 99); PRAGMA foreign_keys = ON"
      )
    )
    const { result } = await design('item', (d) => {
      d.columns.find((c) => c.name === 'price')!.nullable = true
      d.columns.find((c) => c.name === 'price')!.defaultValue = "'0'"
    })
    expect(result.warnings).toEqual([
      'item: 1 fila(s) sin su fila en parent (ya existían antes del cambio)'
    ])
    expect(await rows("SELECT price FROM item WHERE name = 'huérfano'")).toEqual([[null]])
  })

  it('rolls everything back when the new structure creates FK violations', async () => {
    ok(await exec('CREATE TABLE other (id INTEGER PRIMARY KEY)'))
    const structure = await lite.tableStructure(id, 'main', 'item')
    const draft = sqliteDraftFromStructure(structure)
    draft.foreignKeys[0].referencedTable = 'other'
    const plan = sqliteBuildAlter(structure, draft)
    await expect(lite.alterTable(id, 'main', plan.request!)).rejects.toThrow(
      'La nueva estructura deja filas sin su fila referenciada'
    )
    const after = await lite.tableStructure(id, 'main', 'item')
    expect(after.foreignKeys[0].referencedTable).toBe('parent')
    expect(await rows('SELECT count(*) FROM item')).toEqual([[2]])
    expect(await rows('PRAGMA foreign_keys')).toEqual([[1]])
  })

  it('renames the table and a column, adds a column in place', async () => {
    const { plan } = await design('item', (d) => {
      d.name = 'article'
      d.columns.find((c) => c.name === 'price')!.name = 'cost'
      d.columns.push({ ...sqliteEmptyColumn(), name: 'note', defaultValue: "'-'" })
    })
    expect(plan.rebuild).toBeUndefined()
    expect(await rows('SELECT name, cost, note FROM article ORDER BY id')).toEqual([
      ['a', '1.5', '-'],
      ['b', 'x', '-']
    ])
    // SQLite rewrote the view and the trigger.
    expect(await rows('SELECT count(*) FROM v_item')).toEqual([[2]])
  })

  it('renames and rebuilds in one transaction', async () => {
    await design('item', (d) => {
      d.name = 'thing'
      d.columns.find((c) => c.name === 'name')!.columnType = 'VARCHAR(20)'
    })
    expect(await rows('SELECT count(*) FROM thing')).toEqual([[2]])
    expect(await rows('SELECT count(*) FROM v_item')).toEqual([[2]])
    ok(await exec("INSERT INTO thing (name) VALUES ('e')"))
    expect(await rows("SELECT id FROM thing WHERE name = 'e'")).toEqual([[4]])
  })

  it('keeps rowids of a table without INTEGER PRIMARY KEY', async () => {
    ok(
      await exec(
        "CREATE TABLE plain (k TEXT PRIMARY KEY, v); INSERT INTO plain VALUES ('x', 1), ('y', 2); DELETE FROM plain WHERE k = 'x'"
      )
    )
    const before = await rows('SELECT rowid, k FROM plain')
    await design('plain', (d) => {
      d.columns.find((c) => c.name === 'v')!.columnType = 'INTEGER'
    })
    expect(await rows('SELECT rowid, k FROM plain')).toEqual(before)
  })

  it('rebuilds a table of an attached database, recreating its index, trigger and view there', async () => {
    const auxFile = join(dir, 'files', `aux${n}.db`)
    await createSqliteFile(auxFile, inProcessSpawner())
    const auxId = ctx.connections.save(
      input(join(dir, 'files', `db${n}.db`), {
        name: `Designer aux ${n}`,
        sqlite: {
          ...defaultSqliteOptions(false),
          filePath: join(dir, 'files', `db${n}.db`),
          foreignKeys: true,
          attached: [{ alias: 'arch', filePath: auxFile }]
        }
      })
    ).id
    const run = (sql: string) => lite.execute(auxId, sql, { sessionKey: 'aux' })
    ok(
      await run(`
        CREATE TABLE arch.notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT, n TEXT);
        CREATE INDEX arch.ix_notes_body ON notes (body);
        CREATE TABLE arch.log (m TEXT);
        CREATE TRIGGER arch.trg_notes AFTER INSERT ON notes BEGIN INSERT INTO log VALUES (NEW.body); END;
        CREATE VIEW arch.v_notes AS SELECT body FROM notes;
        INSERT INTO arch.notes (body, n) VALUES ('x', '7'), ('y', '8');
      `)
    )
    const structure = await lite.tableStructure(auxId, 'arch', 'notes')
    const draft = sqliteDraftFromStructure(structure)
    draft.columns.find((c) => c.name === 'n')!.columnType = 'INTEGER'
    const plan = sqliteBuildAlter(structure, draft)
    expect(plan.problems).toEqual([])
    expect(plan.rebuild).toBeTruthy()
    await lite.alterTable(auxId, 'arch', plan.request!)
    const [check] = ok(
      await run(
        "SELECT (SELECT group_concat(typeof(n)) FROM arch.notes), (SELECT count(*) FROM arch.sqlite_schema WHERE name IN ('ix_notes_body', 'trg_notes', 'v_notes')), (SELECT count(*) FROM main.sqlite_schema WHERE name IN ('ix_notes_body', 'trg_notes', 'v_notes'))"
      )
    )
    expect(check.resultSet?.rows).toEqual([['integer,integer', 3, 0]])
    ok(await run("INSERT INTO arch.notes (body) VALUES ('z')"))
    // x and y logged when inserted, z by the recreated trigger (the copy fires nothing).
    const [log] = ok(await run('SELECT group_concat(m) FROM arch.log'))
    expect(log.resultSet?.rows).toEqual([['x,y,z']])
    await manager.close(auxId)
  })

  it('needs the typed confirmation on a production connection', async () => {
    const prod = ctx.connections.save(
      input(ctx.connections.get(id)!.sqlite!.filePath, {
        name: 'Prod designer',
        environment: 'production'
      })
    ).id
    const structure = await lite.tableStructure(prod, 'main', 'item')
    const draft = sqliteDraftFromStructure(structure)
    draft.columns.push({ ...sqliteEmptyColumn(), name: 'extra' })
    const plan = sqliteBuildAlter(structure, draft)
    await expect(lite.alterTable(prod, 'main', plan.request!)).rejects.toThrow(
      'necesita confirmación explícita'
    )
    await manager.close(prod)
  })
})
