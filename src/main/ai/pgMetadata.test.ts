import { describe, expect, it } from 'vitest'
import { MetadataOnlyError } from './metadata'
import { PgMetadataQueryable, isPgMetadataSql, isSinglePgSelect } from './pgMetadata'

describe('PostgreSQL AI metadata guard (structure only)', () => {
  it('allows catalog reads', () => {
    expect(isPgMetadataSql('SELECT version() AS version')).toBe(true)
    expect(
      isPgMetadataSql(
        `SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid = c.oid)`
      )
    ).toBe(true)
    expect(
      isPgMetadataSql(
        `SELECT (SELECT json_agg(x ORDER BY k.ord) FROM pg_catalog.generate_series(1, 3) AS k(ord)) FROM information_schema.tables t`
      )
    ).toBe(true)
  })

  it('refuses anything that could read rows or change state', () => {
    for (const sql of [
      'SELECT * FROM users',
      'SELECT * FROM public.users',
      'SELECT * FROM pg_catalog.pg_class, users',
      'SELECT * FROM pg_catalog.pg_class c JOIN app.secrets s ON true',
      'SELECT * FROM pg_catalog.pg_class WHERE oid IN (SELECT id FROM orders)',
      'SELECT relname INTO copy FROM pg_catalog.pg_class',
      'SELECT pg_terminate_backend(1) FROM pg_catalog.pg_stat_activity',
      "SELECT set_config('a', 'b', false) FROM pg_catalog.pg_class",
      'SELECT 1 FROM pg_catalog.pg_class; DELETE FROM users',
      'DELETE FROM pg_catalog.pg_class',
      'SELECT 1'
    ])
      expect(isPgMetadataSql(sql), sql).toBe(false)
  })

  it('the wrapper never forwards a refused statement', async () => {
    const seen: string[] = []
    const q = new PgMetadataQueryable({
      query: async <T>(sql: string) => {
        seen.push(sql)
        return [] as T[]
      }
    })
    await expect(q.query('SELECT * FROM users')).rejects.toBeInstanceOf(MetadataOnlyError)
    await q.query('SELECT relname FROM pg_catalog.pg_class')
    expect(seen).toEqual(['SELECT relname FROM pg_catalog.pg_class'])
  })

  it('EXPLAIN only for one read-only SELECT', () => {
    expect(isSinglePgSelect('SELECT * FROM orders WHERE id = 1')).toBe(true)
    expect(isSinglePgSelect("SELECT nextval('s')")).toBe(false)
    expect(isSinglePgSelect('SELECT 1; SELECT 2')).toBe(false)
    expect(isSinglePgSelect('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d')).toBe(false)
    expect(isSinglePgSelect('UPDATE t SET a = 1')).toBe(false)
  })
})
