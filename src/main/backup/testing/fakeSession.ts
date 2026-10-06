/**
 * In-memory MysqlSession / SessionFactory for backup unit tests. Not a test
 * file itself; never imports electron. Answers only the statements the
 * backup module issues and records everything it executes.
 */
import { Readable } from 'node:stream'
import type { CellValue, ConnectionConfig, ConnectionInput } from '@shared/types'
import type { MysqlSession, SessionFactory } from '../../mysql/types'

export interface FakeColumn {
  name: string
  columnType: string
  extra?: string
}

export interface FakeTable {
  name: string
  columns: FakeColumn[]
  rows: unknown[][]
  /** information_schema TABLE_ROWS answer (defaults to the real row count). */
  estimatedRows?: number | null
  ddl?: string
  triggers?: { name: string; ddl: string }[]
}

export interface FakeSchema {
  tables: FakeTable[]
  views?: { name: string; ddl: string }[]
  functions?: { name: string; ddl: string }[]
  procedures?: { name: string; ddl: string }[]
  events?: { name: string; ddl: string }[]
}

const unquote = (id: string): string => id.replace(/^`|`$/g, '').replace(/``/g, '`')

export class FakeSession implements MysqlSession {
  readonly connectionId: string
  readonly serverVersion = '8.4.7'
  readonly executed: string[] = []
  readonly queried: string[] = []
  schema: string | null = null
  released = false
  /** Return an error to make execute() fail for that statement. */
  failExecute: (sql: string) => Error | null = () => null

  constructor(
    connectionId: string,
    private readonly db: FakeSchema = { tables: [] }
  ) {
    this.connectionId = connectionId
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.queried.push(sql)
    const rows = this.answer(sql, params)
    return rows as T[]
  }

  private answer(sql: string, params: unknown[]): Record<string, unknown>[] {
    if (sql.includes('information_schema.TABLES')) {
      return [
        ...this.db.tables.map((t) => ({
          name: t.name,
          type: 'BASE TABLE',
          estRows: t.estimatedRows === undefined ? t.rows.length : t.estimatedRows
        })),
        ...(this.db.views ?? []).map((v) => ({ name: v.name, type: 'VIEW', estRows: null }))
      ].sort((a, b) => a.name.localeCompare(b.name))
    }
    if (sql.includes('information_schema.ROUTINES')) {
      return [
        ...(this.db.functions ?? []).map((f) => ({ name: f.name, type: 'FUNCTION' })),
        ...(this.db.procedures ?? []).map((p) => ({ name: p.name, type: 'PROCEDURE' }))
      ]
    }
    if (sql.includes('information_schema.EVENTS'))
      return (this.db.events ?? []).map((e) => ({ name: e.name }))
    if (sql.includes('information_schema.TRIGGERS')) {
      return this.db.tables.flatMap((t) =>
        (t.triggers ?? []).map((tr) => ({ name: tr.name, tableName: t.name }))
      )
    }
    if (sql.includes('information_schema.COLUMNS')) {
      const table = this.db.tables.find((t) => t.name === params[1])
      return (table?.columns ?? []).map((c) => ({
        name: c.name,
        columnType: c.columnType,
        extra: c.extra ?? ''
      }))
    }
    if (sql.startsWith('SELECT @@SESSION.sql_mode')) return [{ mode: 'STRICT_TRANS_TABLES' }]
    const show = /^SHOW CREATE (TABLE|VIEW|FUNCTION|PROCEDURE|EVENT|TRIGGER) (`.+`)$/.exec(sql)
    if (show) {
      const name = unquote(show[2])
      switch (show[1]) {
        case 'TABLE': {
          const t = this.db.tables.find((x) => x.name === name)
          return t
            ? [{ Table: name, 'Create Table': t.ddl ?? `CREATE TABLE \`${name}\` (\`id\` int)` }]
            : []
        }
        case 'TRIGGER': {
          const tr = this.db.tables.flatMap((t) => t.triggers ?? []).find((x) => x.name === name)
          return tr ? [{ Trigger: name, 'SQL Original Statement': tr.ddl }] : []
        }
        case 'VIEW':
          return this.pick(this.db.views, name, 'Create View')
        case 'FUNCTION':
          return this.pick(this.db.functions, name, 'Create Function')
        case 'PROCEDURE':
          return this.pick(this.db.procedures, name, 'Create Procedure')
        case 'EVENT':
          return this.pick(this.db.events, name, 'Create Event')
      }
    }
    return []
  }

  private pick(
    list: { name: string; ddl: string }[] | undefined,
    name: string,
    column: string
  ): Record<string, unknown>[] {
    const item = (list ?? []).find((x) => x.name === name)
    return item ? [{ [column]: item.ddl }] : []
  }

  async execute(
    sql: string,
    params?: unknown[]
  ): Promise<{ affectedRows: number; insertId: number | null }> {
    const err = this.failExecute(sql)
    if (err) throw err
    this.executed.push(params && params.length ? `${sql} -- ${JSON.stringify(params)}` : sql)
    return { affectedRows: 0, insertId: null }
  }

  async streamRows(sql: string): Promise<{ columns: string[]; rows: Readable }> {
    this.queried.push(sql)
    const m = /FROM (`(?:[^`]|``)+`)$/.exec(sql)
    const table = this.db.tables.find((t) => t.name === (m ? unquote(m[1]) : ''))
    return {
      columns: (table?.columns ?? []).map((c) => c.name),
      rows: Readable.from(table?.rows ?? [], { objectMode: true })
    }
  }

  async useSchema(schema: string | null): Promise<void> {
    this.schema = schema
    this.executed.push(`USE ${schema}`)
  }

  escape(value: CellValue | Date | Buffer): string {
    return typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : String(value)
  }

  escapeId(identifier: string): string {
    return `\`${identifier.replace(/`/g, '``')}\``
  }

  async release(): Promise<void> {
    this.released = true
  }
}

export class FakeSessionFactory implements SessionFactory {
  readonly sessions: FakeSession[] = []

  constructor(private readonly db: FakeSchema = { tables: [] }) {}

  async acquire(connectionId: string, schema?: string | null): Promise<FakeSession> {
    const s = new FakeSession(connectionId, this.db)
    s.schema = schema ?? null
    this.sessions.push(s)
    return s
  }
}

export function connectionFixture(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  const base: ConnectionInput = {
    name: 'Local',
    color: null,
    environment: 'local',
    host: '127.0.0.1',
    port: 3306,
    username: 'root',
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
    backupDir: '/tmp/electrondb-unused',
    extraBackupDirs: []
  }
  return { ...base, id: 'conn-1', createdAt: '', updatedAt: '', ...overrides }
}

/** Minimal connections lookup for create/restore deps. */
export const connectionsOf = (
  ...list: ConnectionConfig[]
): { get(id: string): ConnectionConfig | null; list(): ConnectionConfig[] } => ({
  get: (id) => list.find((c) => c.id === id) ?? null,
  list: () => list
})
