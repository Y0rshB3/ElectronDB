/**
 * Shared fakes for automation unit tests. Not a test file itself; never
 * imports electron.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import { describeObjectCounts } from '@shared/jobLog'
import type { BackupCreateOptions, ConnectionInput, JobInput, JobTask } from '@shared/types'
import type { BackupService } from '../backup/index'
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
  const dir = mkdtempSync(join(tmpdir(), 'electrondb-automation-'))
  const events: EmittedEvent[] = []
  const ctx: AppContext = {
    userDataPath: dir,
    logDir: join(dir, 'logs'),
    connections: new ConnectionsRepo(dir),
    jobs: new JobsRepo(dir),
    runs: new RunsRepo(dir),
    settings: new SettingsRepo(dir, dir),
    // The automation module never touches secrets; a placeholder is enough.
    credentials: {} as AppContext['credentials'],
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
    backupDir: '/tmp/electrondb-test-backups',
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
}

export function fakeBackupService(dir: string): FakeBackupService {
  const service: FakeBackupService = {
    calls: [],
    objects: new Map(),
    failures: new Map(),
    hangOn: null,
    async list() {
      return []
    },
    async readMeta() {
      throw new Error('not used')
    },
    async restore() {
      throw new Error('not used')
    },
    async create(options, progress, signal) {
      service.calls.push(options)
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
      return {
        path: join(dir, `${options.schema}-${options.label ?? ''}.nb3`),
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
}

export function fakeSessionFactory(): FakeSessionFactory {
  const factory: FakeSessionFactory = {
    executed: [],
    released: 0,
    failing: new Map(),
    affected: new Map(),
    async acquire(connectionId, schema) {
      const session: MysqlSession = {
        connectionId,
        serverVersion: '8.0.0-fake',
        async query() {
          return []
        },
        async execute(sql) {
          const failure = factory.failing.get(sql)
          if (failure) throw new Error(failure)
          factory.executed.push({ connectionId, schema, sql })
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
