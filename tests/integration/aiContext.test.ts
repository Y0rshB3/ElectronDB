import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { envVar } from '@main/env'
import { buildSchemaContext } from '@main/ai/context'
import { explainSelect } from '@main/ai/explain'
import {
  MetadataOnlyError,
  MetadataQueryable,
  readSchemaSnapshot,
  type Queryable
} from '@main/ai/metadata'

/**
 * AI assistant context against real servers: the structure-only reader works
 * on MySQL 8.4 and 5.7, row values never appear in the context, the guard
 * refuses user tables and EXPLAIN only runs for one SELECT.
 *
 *   ELECTRONDB_TEST_MYSQL_URL=mysql://root:navidog@127.0.0.1:33306/navidog_test     (8.4)
 *   ELECTRONDB_TEST_MYSQL57_URL=mysql://root:navidog@127.0.0.1:33357/navidog_test   (5.7)
 */

const servers = [
  { label: 'MySQL 8.4', url: envVar('TEST_MYSQL_URL') },
  { label: 'MySQL 5.7', url: envVar('TEST_MYSQL57_URL') }
].filter((s): s is { label: string; url: string } => !!s.url)

const DB = 'ai_ctx_test'
const SECRET = 'SECRET-ROW-VALUE-7f3a'

// Vitest needs at least one case to report the suite as skipped.
const cases = servers.length ? servers : [{ label: 'MySQL', url: '' }]

describe.skipIf(servers.length === 0).each(cases)('AI schema context on $label', ({ url }) => {
  let conn: mysql.Connection
  let q: Queryable

  beforeAll(async () => {
    conn = await mysql.createConnection(url)
    q = {
      query: async <T>(sql: string, params?: unknown[]): Promise<T[]> =>
        (await conn.query(sql, params))[0] as T[]
    }
    for (const sql of [
      `DROP DATABASE IF EXISTS ${DB}`,
      `CREATE DATABASE ${DB} CHARACTER SET utf8mb4`,
      `CREATE TABLE ${DB}.person (
         id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
         name VARCHAR(100) NULL COMMENT 'Nombre completo'
       ) ENGINE=InnoDB COMMENT='Personas'`,
      `CREATE TABLE ${DB}.users (
         id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
         email VARCHAR(255) NOT NULL,
         status ENUM('active','blocked') NOT NULL DEFAULT 'active',
         person_id INT NULL,
         UNIQUE KEY uq_users_email (email),
         KEY idx_users_status_person (status, person_id),
         CONSTRAINT fk_users_person FOREIGN KEY (person_id) REFERENCES ${DB}.person (id)
       ) ENGINE=InnoDB`,
      `CREATE VIEW ${DB}.active_users AS SELECT id, email FROM ${DB}.users WHERE status = 'active'`,
      `CREATE FUNCTION ${DB}.user_count(p_status VARCHAR(10)) RETURNS INT DETERMINISTIC READS SQL DATA
         RETURN (SELECT COUNT(*) FROM ${DB}.users WHERE status = p_status)`,
      `INSERT INTO ${DB}.person (name) VALUES ('${SECRET}')`,
      `INSERT INTO ${DB}.users (email, person_id) VALUES ('${SECRET}@example.com', 1)`
    ])
      await conn.query(sql)
  })

  afterAll(async () => {
    await conn?.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => undefined)
    await conn?.end()
  })

  it('reads structure only and builds a compact context without row values', async () => {
    const snap = await readSchemaSnapshot(new MetadataQueryable(q), DB)
    expect(snap.tables.map((t) => t.name)).toEqual(['active_users', 'person', 'users'])
    const users = snap.tables.find((t) => t.name === 'users')!
    expect(users.columns.map((c) => c.name)).toEqual(['id', 'email', 'status', 'person_id'])
    expect(users.foreignKeys).toEqual([
      {
        name: 'fk_users_person',
        columns: ['person_id'],
        refSchema: DB,
        refTable: 'person',
        refColumns: ['id']
      }
    ])
    expect(snap.routines).toEqual([
      {
        name: 'user_count',
        type: 'FUNCTION',
        params: ['p_status varchar(10)'],
        returns: expect.stringMatching(/^int(\(11\))?$/)
      }
    ])
    const ctx = buildSchemaContext(snap)
    expect(ctx.text).toContain('users ')
    expect(ctx.text).toContain('email varchar(255) UQ')
    expect(ctx.text).toContain('FK person_id→person.id')
    expect(ctx.text).toContain('idx_users_status_person(status, person_id)')
    expect(ctx.text).toContain('active_users (vista)')
    expect(ctx.text).toContain('«Nombre completo»')
    expect(ctx.text).not.toContain(SECRET)
    // Deterministic between reads.
    expect(buildSchemaContext(await readSchemaSnapshot(new MetadataQueryable(q), DB)).text).toBe(
      ctx.text
    )
  })

  it('refuses to read a user table through the metadata reader', async () => {
    await expect(
      new MetadataQueryable(q).query(`SELECT * FROM ${DB}.person`)
    ).rejects.toBeInstanceOf(MetadataOnlyError)
  })

  it('runs EXPLAIN only for a single SELECT', async () => {
    const plan = await explainSelect(q, `SELECT * FROM ${DB}.users WHERE status = 'active'`)
    expect(plan).toMatch(/^id \| select_type \| table/)
    expect(plan).not.toContain(SECRET)
    expect(await explainSelect(q, `DELETE FROM ${DB}.users`)).toBeNull()
    const [[row]] = (await conn.query(`SELECT COUNT(*) AS n FROM ${DB}.users`)) as unknown as [
      { n: number }[]
    ]
    expect(Number(row.n)).toBe(1)
  })
})
