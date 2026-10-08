import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CredentialStore, plainCodec } from '../credentials/store'
import { AiService } from './service'
import { MetadataOnlyError } from './metadata'
import {
  SqliteMetadataQueryable,
  explainSqliteSelect,
  isSingleSqliteSelect,
  isSqliteMetadataSql
} from './sqliteMetadata'

describe('SQLite AI metadata guard (structure only)', () => {
  it('allows schema and read-pragma reads', () => {
    for (const sql of [
      'SELECT sqlite_version() AS version',
      "SELECT name, type FROM sqlite_schema WHERE type = 'table'",
      'SELECT name FROM "main".sqlite_schema',
      'SELECT name FROM aux.sqlite_master m ORDER BY name',
      'SELECT name FROM "sqlite_schema"',
      'SELECT name FROM [sqlite_temp_schema]',
      'SELECT m.name, p.name FROM "main".sqlite_schema m JOIN pragma_table_xinfo(m.name, ?) p WHERE m.type = ?',
      'SELECT m.name, il.name, ii.name FROM sqlite_schema m JOIN pragma_index_list(m.name, ?) il JOIN pragma_index_info(il.name, ?) ii',
      'SELECT name FROM pragma_database_list ORDER BY seq',
      'SELECT * FROM pragma_foreign_key_list(?, ?)',
      "SELECT name FROM sqlite_schema WHERE type IN ('table', 'view') -- comment",
      'SELECT name FROM (SELECT name FROM sqlite_schema) s'
    ])
      expect(isSqliteMetadataSql(sql), sql).toBe(true)
  })

  it('refuses anything that could read rows or change state', () => {
    for (const sql of [
      'SELECT * FROM users',
      'SELECT * FROM main.users',
      'SELECT * FROM sqlite_schema_x',
      'SELECT * FROM "sqlite_schema_x"',
      'SELECT * FROM sqlite_schema, users',
      'SELECT * FROM sqlite_schema m JOIN users u ON 1',
      'SELECT name FROM sqlite_schema WHERE name IN (SELECT secret FROM users)',
      'SELECT name FROM sqlite_schema WHERE name IN users',
      'SELECT (SELECT secret FROM users LIMIT 1) FROM sqlite_schema',
      'SELECT name FROM (SELECT name FROM sqlite_schema) s, users',
      'SELECT * FROM pragma_table_xinfo((SELECT secret FROM users))',
      'WITH t AS (SELECT * FROM users) SELECT * FROM sqlite_schema',
      'WITH t AS (SELECT name FROM sqlite_schema) SELECT * FROM t',
      'SELECT * FROM json_each((SELECT 1))',
      'SELECT * FROM pragma_writable_schema',
      'SELECT * FROM sqlite_sequence',
      'SELECT name FROM sqlite_schema; DELETE FROM users',
      'SELECT name FROM sqlite_schema; SELECT * FROM users',
      'PRAGMA table_info(users)',
      "ATTACH 'x.db' AS x",
      'DELETE FROM sqlite_schema',
      "SELECT load_extension('x') FROM sqlite_schema",
      'SELECT 1'
    ])
      expect(isSqliteMetadataSql(sql), sql).toBe(false)
  })

  it('the wrapper never forwards a refused statement', async () => {
    const seen: string[] = []
    const q = new SqliteMetadataQueryable({
      query: async <T>(sql: string) => {
        seen.push(sql)
        return [] as T[]
      }
    })
    await expect(q.query('SELECT * FROM users')).rejects.toBeInstanceOf(MetadataOnlyError)
    await q.query('SELECT name FROM sqlite_schema')
    expect(seen).toEqual(['SELECT name FROM sqlite_schema'])
  })

  it('EXPLAIN QUERY PLAN only for one read-only SELECT', async () => {
    expect(isSingleSqliteSelect('SELECT * FROM orders WHERE id = 1')).toBe(true)
    expect(isSingleSqliteSelect('SELECT 1; SELECT 2')).toBe(false)
    expect(isSingleSqliteSelect('WITH d AS (SELECT 1) DELETE FROM t')).toBe(false)
    expect(isSingleSqliteSelect('UPDATE t SET a = 1')).toBe(false)
    const seen: string[] = []
    const plan = await explainSqliteSelect(
      {
        query: async <T>(sql: string) => {
          seen.push(sql)
          return [
            { id: 2, parent: 0, detail: 'SCAN orders' },
            { id: 5, parent: 2, detail: 'USE INDEX' }
          ] as T[]
        }
      },
      'SELECT * FROM orders;'
    )
    expect(seen).toEqual(['EXPLAIN QUERY PLAN SELECT * FROM orders'])
    expect(plan).toBe('SCAN orders\n  USE INDEX')
    expect(await explainSqliteSelect({ query: async () => [] }, 'DELETE FROM t')).toBeNull()
  })
})

describe('AiService on SQLite connections', () => {
  it('reads the context through the SQLite guard and never the MySQL session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vortaq-ai-lite-'))
    const seen: string[] = []
    const mysqlAcquire = vi.fn()
    const service = new AiService({
      userDataPath: dir,
      credentials: new CredentialStore(dir, plainCodec, 'plain'),
      settings: { get: () => ({}) as never },
      environmentOf: () => 'local',
      acquire: mysqlAcquire,
      isSqlite: () => true,
      acquireSqlite: async () => ({
        async query<T>(sql: string): Promise<T[]> {
          seen.push(sql)
          if (/pragma_database_list/.test(sql)) return [{ name: 'main' }, { name: 'aux' }] as T[]
          if (/sqlite_version/.test(sql)) return [{ version: '3.53.4' }] as T[]
          if (
            /m\.type IN \('table', 'view'\) AND m\.name NOT LIKE/.test(sql) &&
            !/pragma/.test(sql)
          )
            return [{ name: 'orders', type: 'table' }] as T[]
          return []
        },
        release: async () => undefined
      }),
      emit: () => undefined,
      log: { info: () => undefined, warn: () => undefined }
    })
    try {
      const none = await service.buildContext({ connectionId: 'c', schema: null })
      expect(none.context).toContain('Bases de datos adjuntas: main, aux')
      const ctx = await service.buildContext({ connectionId: 'c', schema: 'main' })
      expect(ctx.context).toContain('orders')
      expect(ctx.context).toContain('SQLite 3.53.4')
      expect(mysqlAcquire).not.toHaveBeenCalled()
      expect(seen.every((sql) => isSqliteMetadataSql(sql))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
