/**
 * In-memory session for the SQL import unit tests (no electron, no server).
 * Records every executed statement; INSERTs report one affected row per tuple.
 */
import { Readable } from 'node:stream'
import type { BackupCreateOptions, BackupCreateResult, ConnectionConfig } from '@shared/types'
import type { MysqlSession, SessionFactory } from '../../mysql/types'
import { connectionFixture } from '../../backup/testing/fakeSession'
import type { SqlImportDeps } from './execute'

export class DumpSession implements MysqlSession {
  readonly connectionId: string
  readonly serverVersion = '8.4.7'
  readonly executed: string[] = []
  released = false
  /** Existing databases (information_schema.SCHEMATA answers). */
  schemas = new Set<string>()
  /** Accounts that exist (mysql.user answers); null = no privilege to read mysql.user. */
  accounts: Set<string> | null = new Set(['root@localhost'])
  /** Return an error to make execute() fail for that statement. */
  fail: (sql: string) => Error | null = () => null
  /** Called before each execute (tests abort from here). */
  onExecute: (sql: string) => void = () => {}

  /** Raw statements as received (binary strings), for byte-exactness checks. */
  readonly raw: string[] = []
  /**
   * Byte-exact path like PooledSession: the statement arrives as a binary string
   * and is recorded decoded as UTF-8. Set to undefined to test the text fallback.
   */
  executeRaw?: (sql: string) => Promise<{ affectedRows: number; insertId: number | null }> = (
    sql
  ) => {
    this.raw.push(sql)
    return this.execute(Buffer.from(sql, 'latin1').toString('utf8'))
  }

  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (sql.startsWith('SELECT @@SESSION.sql_mode')) return [{ mode: 'STRICT_TRANS_TABLES' }] as T[]
    if (sql.includes('information_schema.SCHEMATA'))
      return (
        this.schemas.has(String(params[0])) ? [{ cs: 'utf8mb4', co: 'utf8mb4_0900_ai_ci' }] : []
      ) as T[]
    if (sql.includes('FROM mysql.user')) {
      if (!this.accounts) throw Object.assign(new Error('denied'), { errno: 1142 })
      return [{ n: this.accounts.has(`${params[0]}@${params[1]}`) ? 1 : 0 }] as T[]
    }
    return []
  }

  async execute(
    sql: string,
    params?: unknown[]
  ): Promise<{ affectedRows: number; insertId: number | null }> {
    this.onExecute(sql)
    const err = this.fail(sql)
    if (err) throw err
    this.executed.push(params?.length ? `${sql} -- ${JSON.stringify(params)}` : sql)
    const create = /^CREATE DATABASE (?:IF NOT EXISTS )?`([^`]+)`/.exec(sql)
    if (create) this.schemas.add(create[1])
    const drop = /^DROP DATABASE IF EXISTS `([^`]+)`/.exec(sql)
    if (drop) this.schemas.delete(drop[1])
    const tuples = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*INSERT\b[\s\S]*?\bVALUES\b([\s\S]*)$/i.exec(sql)
    if (tuples)
      return { affectedRows: (tuples[1].match(/\)\s*,\s*\(/g)?.length ?? 0) + 1, insertId: null }
    return { affectedRows: 0, insertId: null }
  }

  async streamRows(): Promise<{ columns: string[]; rows: Readable }> {
    return { columns: [], rows: Readable.from([]) }
  }

  async useSchema(schema: string | null): Promise<void> {
    this.executed.push(`USE ${schema}`)
  }

  escape(value: unknown): string {
    return `'${String(value)}'`
  }

  escapeId(identifier: string): string {
    return `\`${identifier.replace(/`/g, '``')}\``
  }

  async release(): Promise<void> {
    this.released = true
  }
}

export class DumpSessions implements SessionFactory {
  readonly sessions: DumpSession[] = []
  setup: (s: DumpSession) => void = () => {}

  async acquire(connectionId: string): Promise<DumpSession> {
    const s = new DumpSession(connectionId)
    this.setup(s)
    this.sessions.push(s)
    return s
  }
}

export interface TestDeps extends SqlImportDeps {
  sessions: DumpSessions
  backupCalls: BackupCreateOptions[]
  /** Shared timeline: "backup:<schema>" and executed DDL, in order. */
  timeline: string[]
}

export function testDeps(connection: Partial<ConnectionConfig> = {}): TestDeps {
  const conn = connectionFixture(connection)
  const sessions = new DumpSessions()
  const backupCalls: BackupCreateOptions[] = []
  const timeline: string[] = []
  sessions.setup = (s) => {
    const original = s.onExecute
    s.onExecute = (sql) => {
      timeline.push(sql)
      original(sql)
    }
  }
  return {
    connections: { get: (id) => (id === conn.id ? conn : null) },
    sessions,
    backupCalls,
    timeline,
    backups: {
      async create(options): Promise<BackupCreateResult> {
        backupCalls.push(options)
        timeline.push(`backup:${options.schema}`)
        return {
          path: `/tmp/${options.schema}-previo.nb3`,
          sizeBytes: 1,
          objects: 1,
          rows: 0,
          durationMs: 1
        }
      }
    }
  }
}
