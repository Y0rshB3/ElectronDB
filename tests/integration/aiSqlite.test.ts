/**
 * AI assistant context on a real SQLite file: the structure-only reader goes
 * through the open connection (shared handle, in-process worker), row values
 * and defaults never appear in the context, the guard refuses user tables, and
 * EXPLAIN QUERY PLAN only runs for one SELECT.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultSqliteOptions } from '@shared/engines'
import type { ConnectionConfig } from '@shared/types'
import { buildSchemaContext } from '@main/ai/context'
import { MetadataOnlyError } from '@main/ai/metadata'
import {
  SqliteMetadataQueryable,
  explainSqliteSelect,
  readSqliteDatabaseNames,
  readSqliteSchemaSnapshot
} from '@main/ai/sqliteMetadata'
import { SqliteDriverConnection } from '@main/sqlite/connection'
import { createSqliteFile } from '@main/sqlite/driver'
import { executeSqliteScript } from '@main/sqlite/query'
import { inProcessSpawner } from '@main/sqlite/spawner'

const SECRET = 'SECRET-ROW-VALUE-7f3a'
const DEFAULT_LITERAL = 'DEFAULT-LITERAL-91c2'

describe('AI schema context on SQLite (real file)', () => {
  let dir: string
  let connection: SqliteDriverConnection
  let q: SqliteMetadataQueryable

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-ai-sqlite-'))
    const filePath = join(dir, 'ai.db')
    const spawner = inProcessSpawner()
    await createSqliteFile(filePath, spawner)
    const config: ConnectionConfig = {
      id: 'ai',
      name: 'AI',
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
      createdAt: '',
      updatedAt: '',
      engine: 'sqlite',
      sqlite: { ...defaultSqliteOptions(false), filePath }
    }
    connection = new SqliteDriverConnection({
      config,
      spawner,
      isGuarded: () => false,
      onFatal: () => undefined
    })
    await connection.probe()
    const results = await executeSqliteScript(
      connection,
      `CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT DEFAULT '${DEFAULT_LITERAL}');
       CREATE TABLE users (
         id INTEGER PRIMARY KEY,
         email TEXT NOT NULL UNIQUE,
         person_id INTEGER REFERENCES person(id),
         total REAL GENERATED ALWAYS AS (id * 2) VIRTUAL
       );
       CREATE INDEX idx_users_person ON users (person_id, email);
       CREATE VIEW active_users AS SELECT id, email FROM users WHERE email <> '${SECRET}';
       INSERT INTO person (name) VALUES ('${SECRET}');
       INSERT INTO users (email, person_id) VALUES ('${SECRET}@x', 1);`
    )
    expect(results.find((r) => r.error)).toBeUndefined()
    q = new SqliteMetadataQueryable(await connection.acquire(null))
  })

  afterAll(async () => {
    await connection.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads structure only: tables, columns, keys, indexes, FKs, views', async () => {
    const snap = await readSqliteSchemaSnapshot(q, 'main')
    expect(snap.serverVersion).toMatch(/^SQLite 3\./)
    expect(snap.tables.map((t) => [t.name, t.kind])).toEqual([
      ['active_users', 'view'],
      ['person', 'table'],
      ['users', 'table']
    ])
    const users = snap.tables.find((t) => t.name === 'users')!
    expect(users.columns).toEqual([
      { name: 'id', type: 'INTEGER', nullable: true, key: 'PRI', extra: '', comment: '' },
      { name: 'email', type: 'TEXT', nullable: false, key: '', extra: '', comment: '' },
      { name: 'person_id', type: 'INTEGER', nullable: true, key: '', extra: '', comment: '' },
      {
        name: 'total',
        type: 'REAL',
        nullable: true,
        key: '',
        extra: 'generated virtual',
        comment: ''
      }
    ])
    expect(users.indexes).toEqual(
      expect.arrayContaining([
        { name: 'idx_users_person', unique: false, columns: ['person_id', 'email'] },
        expect.objectContaining({ unique: true, columns: ['email'] })
      ])
    )
    expect(users.foreignKeys).toEqual([
      expect.objectContaining({ columns: ['person_id'], refTable: 'person', refColumns: ['id'] })
    ])
    expect(await readSqliteDatabaseNames(q)).toEqual(['main'])
    const only = await readSqliteSchemaSnapshot(q, 'main', ['person'])
    expect(only.tables.map((t) => t.name)).toEqual(['person'])
  })

  it('never puts row values, defaults or view bodies in the context', async () => {
    const snap = await readSqliteSchemaSnapshot(q, 'main')
    const { text } = buildSchemaContext(snap, { hints: ['users'] })
    expect(text).toContain('users')
    expect(JSON.stringify(snap)).not.toContain(SECRET)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(DEFAULT_LITERAL)
  })

  it('refuses user tables through the guard', async () => {
    await expect(q.query('SELECT * FROM users')).rejects.toBeInstanceOf(MetadataOnlyError)
    await expect(
      q.query('SELECT name FROM sqlite_schema WHERE name IN (SELECT email FROM users)')
    ).rejects.toBeInstanceOf(MetadataOnlyError)
  })

  it('EXPLAIN QUERY PLAN only for one SELECT', async () => {
    const session = await connection.acquire(null)
    const plan = await explainSqliteSelect(session, 'SELECT * FROM users WHERE person_id = 1')
    expect(plan).toMatch(/idx_users_person/)
    expect(plan).not.toContain(SECRET)
    expect(await explainSqliteSelect(session, 'DELETE FROM users')).toBeNull()
    const [count] = await executeSqliteScript(connection, 'SELECT count(*) FROM users')
    expect(count.resultSet?.rows).toEqual([[1]])
  })
})
