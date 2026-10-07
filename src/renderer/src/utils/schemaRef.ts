import type { SchemaRef } from '@shared/types'

/**
 * Namespace argument of the db:* channels: MySQL keeps the database name as a
 * plain string (unchanged); PostgreSQL passes `{ database, schema }`, and the
 * renderer only knows a database for PostgreSQL tabs and tree nodes.
 */
export function schemaRef(schema: string, database?: string | null): SchemaRef {
  return database !== undefined && database !== null ? { database, schema } : schema
}

/** Same, for a tab or tree node (`database` present only on PostgreSQL). */
export function refOf(holder: { schema?: string | null; database?: string | null }): SchemaRef {
  return schemaRef(holder.schema ?? '', holder.database)
}

/** Text for messages: `db.schema` on PostgreSQL, the database name on MySQL. */
export function refLabel(ref: SchemaRef): string {
  return typeof ref === 'string' ? ref : `${ref.database}.${ref.schema}`
}
