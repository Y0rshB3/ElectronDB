import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '@shared/types'
import { defaultSqliteOptions } from '@shared/engines'
import { SqliteDriverConnection } from './connection'
import { createSqliteFile } from './driver'
import { alterSqliteTable, tableDependents } from './rebuild'
import { executeSqliteScript } from './query'
import { inProcessSpawner } from './spawner'

let dir: string
let conn: SqliteDriverConnection

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vortaq-sqlite-rebuild-'))
  const file = join(dir, 'r.db')
  await createSqliteFile(file, inProcessSpawner())
  conn = new SqliteDriverConnection({
    config: {
      id: 'r',
      name: 'R',
      environment: 'local',
      engine: 'sqlite',
      initialQueries: '',
      sqlite: { ...defaultSqliteOptions(false), filePath: file, foreignKeys: true }
    } as ConnectionConfig,
    spawner: inProcessSpawner(),
    isGuarded: () => false,
    onFatal: () => undefined
  })
  await conn.probe()
  await executeSqliteScript(
    conn,
    `CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v);
     CREATE TABLE log (m);
     CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO log VALUES ('t'); END;
     CREATE VIEW v1 AS SELECT * FROM t;
     CREATE VIEW v2 AS SELECT 't' AS label FROM log;
     INSERT INTO t (v) VALUES (1)`
  )
})

afterEach(async () => {
  await conn.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('SQLite designer executor', () => {
  it('reads dependents token-level, the sequence and foreign_keys', async () => {
    const deps = await conn.exclusive((s) => tableDependents(s, 'main', 't'))
    expect(deps.dependents.map((d) => `${d.type}:${d.name}`)).toEqual(['trigger:tr', 'view:v1'])
    expect(deps.sequence).toBe(1)
    expect(deps.foreignKeys).toBe(true)
  })

  it('refuses multi-statement input and non-index index statements', async () => {
    await expect(
      alterSqliteTable(conn, 'main', {
        table: 't',
        newName: 't',
        statements: ['DROP TABLE log; DROP TABLE t'],
        rebuild: null
      })
    ).rejects.toThrow('una sola sentencia')
    await expect(
      alterSqliteTable(conn, 'main', {
        table: 't',
        newName: 't',
        statements: [],
        rebuild: {
          createBody: '(id INTEGER PRIMARY KEY, v)',
          columnMap: [],
          keepRowid: false,
          indexes: ['DROP TABLE log'],
          autoincrement: false
        }
      })
    ).rejects.toThrow('no es CREATE INDEX')
  })

  it('rolls back an in-place plan as a whole', async () => {
    await expect(
      alterSqliteTable(conn, 'main', {
        table: 't',
        newName: 't',
        statements: ['ALTER TABLE t ADD COLUMN w', 'ALTER TABLE nope ADD COLUMN x'],
        rebuild: null
      })
    ).rejects.toThrow()
    const [r] = await executeSqliteScript(
      conn,
      "SELECT count(*) FROM pragma_table_info('t') WHERE name = 'w'"
    )
    expect(r.resultSet?.rows).toEqual([[0]])
  })
})
