/**
 * Shared fakes for automation unit tests. Not a test file itself; never
 * imports electron.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { SqlExportOptions } from '@shared/importers'
import { describeObjectCounts } from '@shared/jobLog'
import type {
  BackupCreateOptions,
  BackupFile,
  BackupMeta,
  ConnectionInput,
  JobInput,
  JobTask,
  RestoreOptions
} from '@shared/types'
import type { BackupService } from '../backup/index'
import { CredentialStore, plainCodec } from '../credentials/store'
import type { AppContext } from '../context'
import type { Logger } from '../log'
import type { MysqlSession, SessionFactory } from '../mysql/types'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '../storage/repos'

export interface EmittedEvent {
  channel: IpcEventChannel
  payload: IpcEventMap[IpcEventChannel]
}

export interface TestContext {
  ctx: AppContext
  dir: string
  events: EmittedEvent[]
  cleanup(): void
}

export function makeContext(options: { headless?: boolean } = {}): TestContext {
  const dir = mkdtempSync(join(tmpdir(), 'vortaq-automation-'))
  const events: EmittedEvent[] = []
  const ctx: AppContext = {
    userDataPath: dir,
    logDir: join(dir, 'logs'),
    connections: new ConnectionsRepo(dir),
    jobs: new JobsRepo(dir),
    runs: new RunsRepo(dir),
    settings: new SettingsRepo(dir, dir),
    // Only the jobs' backup passwords (encrypted .vqb steps) are read from it.
    credentials: new CredentialStore(dir, plainCodec, 'plain'),
    headless: options.headless ?? false,
    emit: (channel, payload) => {
      events.push({ channel, payload })
    }
  }
  return { ctx, dir, events, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

export function connectionInput(name: string): ConnectionInput {
  return {
    name,
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
    backupDir: '/tmp/vortaq-test-backups',
    extraBackupDirs: []
  }
}

export function jobInput(
  name: string,
  tasks: JobTask[],
  overrides: Partial<JobInput> = {}
): JobInput {
  return {
    name,
    continueOnError: false,
    tasks,
    schedule: { enabled: false, cron: '', launchAgent: false },
    ...overrides
  }
}

export function backupTask(id: string, connectionId: string, schema: string): JobTask {
  return { id, type: 'backupschema', connectionId, schema, referenceName: `Backup ${schema}` }
}

export function queryTask(id: string, connectionId: string, schema: string, sql: string): JobTask {
  return { id, type: 'runquery', connectionId, schema, referenceName: `Query ${id}`, sql }
}

/** Restore step reading the output of backup step `sourceTaskId` (target schema = same name). */
export function restoreTask(
  id: string,
  connectionId: string,
  sourceTaskId: string,
  overrides: Partial<JobTask> = {}
): JobTask {
  return {
    id,
    type: 'restoreschema',
    connectionId,
    schema: '',
    referenceName: `Restore ${id}`,
    restoreSource: { kind: 'task', taskId: sourceTaskId },
    safetyBackup: true,
    ...overrides
  }
}

export interface FakeObject {
  type: 'Table' | 'View' | 'Function' | 'Procedure' | 'Event'
  name: string
  rows?: number
  /** Fails this object with the given message. */
  error?: string
}

export interface FakeBackupService extends BackupService {
  calls: BackupCreateOptions[]
  /** Objects reported (list/object/objectDone/objectError events) per schema. */
  objects: Map<string, FakeObject[]>
  /** Schemas whose backup fails with the given message. */
  failures: Map<string, string>
  /** When set, create() for this schema waits until the signal aborts. */
  hangOn: string | null
  /** Schema stored in each backup file (create() registers its output). */
  files: Map<string, string>
  restores: RestoreOptions[]
  /** Objects whose restore fails (name -> message). */
  restoreFailures: Map<string, string>
  /** backups:list answer per `<connectionId>:<schema>`. */
  listed: Map<string, BackupFile[]>
  /** Shared ordered record of operations ("create:<schema>", "restore:<schema>"). */
  timeline: string[]
  /** Files whose full integrity check fails (path -> message). */
  corrupt: Map<string, string>
  /** Paths passed to verify(), in order. */
  verified: string[]
  /** exportSql() calls (backup steps with «Formato: .sql»). */
  exports: SqlExportOptions[]
}

export function fakeBackupService(dir: string, timeline: string[] = []): FakeBackupService {
  const service: FakeBackupService = {
    calls: [],
    objects: new Map(),
    failures: new Map(),
    hangOn: null,
    files: new Map(),
    restores: [],
    restoreFailures: new Map(),
    listed: new Map(),
    timeline,
    corrupt: new Map(),
    verified: [],
    exports: [],
    async replace() {
      throw new Error('not used')
    },
    async exportSql(options, progress) {
      service.exports.push(options)
      service.timeline.push(`export:${options.schema}`)
      const failure = service.failures.get(options.schema)
      if (failure) throw new Error(failure)
      const objects = service.objects.get(options.schema) ?? []
      progress?.({
        phase: 'list',
        current: 0,
        total: objects.length,
        message: describeObjectCounts(objects.map((o) => o.type)),
        done: false,
        detail: { objects: objects.length, objectsDone: 0 }
      })
      const rows = options.includeData ? objects.reduce((sum, o) => sum + (o.rows ?? 0), 0) : 0
      return {
        path: join(dir, `${options.schema}-${options.label ?? ''}.sql`),
        sizeBytes: 1024,
        objects: Math.max(1, objects.length),
        rows,
        durationMs: 1
      }
    },
    async verify(path) {
      service.verified.push(path)
      const schema = service.files.get(path)
      if (schema === undefined) throw new Error(`No se encontró el archivo de backup: ${path}`)
      const damage = service.corrupt.get(path)
      if (damage) throw new Error(damage)
      const objects = service.objects.get(schema) ?? []
      return {
        objects: objects.length,
        chunks: objects.length,
        rows: objects.reduce((sum, o) => sum + (o.rows ?? 0), 0)
      }
    },
    async list(connectionId, schema) {
      return service.listed.get(`${connectionId}:${schema ?? ''}`) ?? []
    },
    async readMeta(path): Promise<BackupMeta> {
      const schema = service.files.get(path)
      if (schema === undefined) throw new Error(`No se encontró el archivo de backup: ${path}`)
      return {
        metaVersion: '30101',
        databaseType: 'MYSQL',
        schema,
        startTime: null,
        endTime: null,
        encryption: 'None',
        comment: '',
        objects: (service.objects.get(schema) ?? []).map((o, i) => ({
          uuid: `u${i}`,
          type: o.type,
          name: o.name,
          rows: o.rows ?? null
        }))
      }
    },
    async restore(options, progress) {
      service.restores.push(options)
      service.timeline.push(`restore:${options.targetSchema}`)
      const schema = service.files.get(options.backupPath) ?? ''
      const objects = service.objects.get(schema) ?? []
      const result = {
        objectsRestored: 0,
        rowsInserted: 0,
        errors: [] as { object: string; message: string }[],
        durationMs: 1
      }
      for (const [i, o] of objects.entries()) {
        const detail = {
          objectType: o.type,
          objectName: o.name,
          objectIndex: i + 1,
          objects: objects.length
        }
        const failure = service.restoreFailures.get(o.name)
        if (failure) {
          result.errors.push({ object: o.name, message: failure })
          progress?.({
            phase: 'objectError',
            current: i,
            total: objects.length,
            message: o.name,
            done: false,
            detail: { ...detail, error: failure }
          })
          if (!options.continueOnError) break
          continue
        }
        // Like restore.ts: a structure-only restore inserts no rows.
        const rows = options.includeData ? (o.rows ?? 0) : 0
        result.objectsRestored++
        result.rowsInserted += rows
        progress?.({
          phase: 'objectDone',
          current: i + 1,
          total: objects.length,
          message: o.name,
          done: false,
          detail: { ...detail, rows: o.type === 'Table' && options.includeData ? rows : null }
        })
      }
      return result
    },
    async create(options, progress, signal) {
      service.calls.push(options)
      service.timeline.push(`create:${options.schema}`)
      const failure = service.failures.get(options.schema)
      if (failure) throw new Error(failure)
      if (service.hangOn === options.schema) {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      const objects = service.objects.get(options.schema) ?? []
      const total = objects.length
      progress?.({
        phase: 'list',
        current: 0,
        total,
        message: describeObjectCounts(objects.map((o) => o.type)),
        done: false,
        detail: { objects: total, objectsDone: 0 }
      })
      let rows = 0
      for (const [i, o] of objects.entries()) {
        const detail = {
          objectType: o.type,
          objectName: o.name,
          objectIndex: i + 1,
          objects: total
        }
        progress?.({
          phase: 'object',
          current: i,
          total,
          message: o.name,
          done: false,
          detail: { ...detail, objectsDone: i }
        })
        if (o.error) {
          progress?.({
            phase: 'objectError',
            current: i,
            total,
            message: o.name,
            done: false,
            detail: { ...detail, objectsDone: i, error: o.error }
          })
          throw new Error(`Error al respaldar ${o.name}: ${o.error}`)
        }
        rows += o.rows ?? 0
        progress?.({
          phase: 'objectDone',
          current: i + 1,
          total,
          message: o.name,
          done: false,
          detail: { ...detail, objectsDone: i + 1, rows: o.type === 'Table' ? (o.rows ?? 0) : null }
        })
      }
      progress?.({ phase: 'objects', current: 1, total: 1, message: options.schema, done: true })
      const path = join(dir, `${options.schema}-${options.label ?? ''}.nb3`)
      service.files.set(path, options.schema)
      return {
        path,
        sizeBytes: 2048,
        objects: Math.max(1, total),
        rows,
        durationMs: 1
      }
    }
  }
  return service
}

export interface FakeSessionFactory extends SessionFactory {
  executed: { connectionId: string; schema: string | null | undefined; sql: string }[]
  released: number
  /** Statements (exact text) that throw. */
  failing: Map<string, string>
  /** Affected rows reported per statement (exact text); 0 otherwise. */
  affected: Map<string, number>
  /** Databases that exist, per connection id (information_schema.SCHEMATA). */
  schemas: Map<string, Set<string>>
  /** Shared ordered record of executed statements. */
  timeline: string[]
}

export function fakeSessionFactory(timeline: string[] = []): FakeSessionFactory {
  const factory: FakeSessionFactory = {
    executed: [],
    released: 0,
    failing: new Map(),
    affected: new Map(),
    schemas: new Map(),
    timeline,
    async acquire(connectionId, schema) {
      const session: MysqlSession = {
        connectionId,
        serverVersion: '8.0.0-fake',
        async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
          if (sql.includes('information_schema.SCHEMATA')) {
            const names = [...(factory.schemas.get(connectionId) ?? [])]
            const wanted = params[0]
            return names
              .filter((n) => wanted === undefined || n === wanted)
              .map((name) => ({ name })) as T[]
          }
          // Every charset and collation exists on the fake server.
          if (sql.includes('information_schema.CHARACTER_SETS') || sql.includes('COLLATIONS'))
            return [{ name: params[0] }] as T[]
          return []
        },
        async execute(sql) {
          const failure = factory.failing.get(sql)
          if (failure) throw new Error(failure)
          factory.executed.push({ connectionId, schema, sql })
          factory.timeline.push(sql)
          return { affectedRows: factory.affected.get(sql) ?? 0, insertId: null }
        },
        async streamRows() {
          throw new Error('not used')
        },
        async useSchema() {},
        escape: (v) => String(v),
        escapeId: (v) => `\`${v}\``,
        async release() {
          factory.released++
        }
      }
      return session
    }
  }
  return factory
}
