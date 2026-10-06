import type { Readable } from 'node:stream'
import type { CellValue } from '@shared/types'

/**
 * Minimal database session used by backup, restore, introspection and
 * automation code. Implemented over mysql2 by src/main/mysql/manager.ts
 * and by in-memory fakes in tests.
 */
export interface MysqlSession {
  readonly connectionId: string
  readonly serverVersion: string
  /** Run one statement; returns rows for SELECT-like statements. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  /** Run one statement and return the affected row count. */
  execute(
    sql: string,
    params?: unknown[]
  ): Promise<{ affectedRows: number; insertId: number | null }>
  /** Stream rows of a SELECT as plain arrays (column order as returned). */
  streamRows(sql: string, params?: unknown[]): Promise<{ columns: string[]; rows: Readable }>
  /** Switch default schema for subsequent statements. */
  useSchema(schema: string | null): Promise<void>
  escape(value: CellValue | Date | Buffer): string
  escapeId(identifier: string): string
  release(): Promise<void>
}

export interface SessionFactory {
  /** Acquire a dedicated session (own connection) for long operations. */
  acquire(connectionId: string, schema?: string | null): Promise<MysqlSession>
}
