/**
 * One open MongoDB connection (docs/multi-engine-design.md, 5.3.1 and 5.6):
 * the MongoClient, the query tabs' sessions (current database after `use`,
 * and on replica sets an explicit transaction), the open cursors behind
 * «Cargar más» (10 minutes idle, at most 5 per owner) and the running
 * executions that `db:cancel` can stop with killOp.
 */
import { randomUUID } from 'node:crypto'
import type { AbstractCursor, ClientSession, Collection, Db, Document, MongoClient } from 'mongodb'
import type {
  ConnectionConfig,
  MongoTopology,
  ServerInfo,
  TabSessionState,
  TransactionStatus
} from '@shared/types'
import type { DocumentDriverConnection } from '../db/driver'
import { RAW_BSON, mongoOf } from './client'
import { MongoUserError, isInterrupted, toServerError } from './errors'
import { readPreferenceLabel } from '@shared/mongo/readPreference'

/** Cursors idle longer than this are closed (the server's own default is also 10 minutes). */
export const CURSOR_IDLE_MS = 10 * 60_000
/** Open cursors kept per owner (a query tab or the collection browser). */
export const CURSORS_PER_OWNER = 5

export const CANCELLED = 'Consulta cancelada.'

export interface MongoTab {
  key: string
  /** Current database (`use <db>`); null = the connection's default. */
  database: string | null
  session: ClientSession | null
  status: TransactionStatus
  lastUsed: number
}

export interface OpenCursor {
  id: string
  owner: string
  cursor: AbstractCursor<Document>
  /** Documents come back whole (no projection, no inclusion $project). */
  whole: boolean
  lastUsed: number
  /** comment the cursor's operations carry (killOp target). */
  comment: string | null
}

interface Execution {
  comment: string
  cancelled: boolean
}

export interface HelloFacts {
  topology: MongoTopology
  memberRole: string
  setName: string | null
}

/** Topology and member role from a `hello` answer. */
export function helloFacts(hello: Document): HelloFacts {
  const setName = typeof hello.setName === 'string' ? hello.setName : null
  if (hello.msg === 'isdbgrid') return { topology: 'shardCluster', memberRole: 'mongos', setName }
  if (setName) {
    const role = hello.isWritablePrimary
      ? 'primary'
      : hello.secondary
        ? 'secondary'
        : hello.arbiterOnly
          ? 'arbiter'
          : 'otro miembro'
    return { topology: 'replicaSet', memberRole: role, setName }
  }
  return { topology: 'standalone', memberRole: 'independiente', setName: null }
}

const ROLE_LABELS: Record<string, string> = {
  primary: 'Primario',
  secondary: 'Secundario (solo lectura)',
  arbiter: 'Árbitro',
  mongos: 'mongos (clúster fragmentado)',
  independiente: 'Independiente'
}
const TOPOLOGY_LABELS: Record<MongoTopology, string> = {
  standalone: 'Independiente',
  replicaSet: 'Conjunto de réplicas',
  shardCluster: 'Clúster fragmentado'
}

export function topologyLabel(t: MongoTopology): string {
  return TOPOLOGY_LABELS[t]
}
export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role
}

export interface MongoConnectionInit {
  config: ConnectionConfig
  client: MongoClient
  version: string
  facts: HelloFacts
  tls: boolean
}

export class MongoDriverConnection implements DocumentDriverConnection {
  readonly family = 'document' as const
  readonly config: ConnectionConfig
  readonly client: MongoClient
  readonly serverVersion: string
  readonly topology: MongoTopology
  readonly memberRole: string
  private readonly tls: boolean
  private readonly tabs = new Map<string, MongoTab>()
  private readonly cursors = new Map<string, OpenCursor>()
  private readonly executions = new Map<string, Execution>()
  private readonly sweeper: ReturnType<typeof setInterval>
  private closed = false

  constructor(init: MongoConnectionInit) {
    this.config = init.config
    this.client = init.client
    this.serverVersion = init.version
    this.topology = init.facts.topology
    this.memberRole = init.facts.memberRole
    this.tls = init.tls
    this.sweeper = setInterval(() => void this.sweepCursors(), 60_000)
    this.sweeper.unref?.()
  }

  /** Transactions need a replica set or a sharded cluster (verified: standalone refuses them). */
  get transactions(): boolean {
    return this.topology !== 'standalone'
  }

  /** Default database of the tree and the query tabs. */
  get defaultDatabase(): string {
    return mongoOf(this.config).defaultDatabase || 'test'
  }

  db(name: string): Db {
    if (!name) throw new MongoUserError('Falta la base de datos.')
    return this.client.db(name)
  }

  /** A collection for writes and commands (results are plain numbers). */
  coll(database: string, name: string): Collection<Document> {
    if (!name) throw new MongoUserError('Falta el nombre de la colección.')
    return this.db(database).collection(name)
  }

  /** A database whose listings keep every BSON type (validators, index options). */
  rawDb(name: string): Db {
    if (!name) throw new MongoUserError('Falta la base de datos.')
    return this.client.db(name, RAW_BSON)
  }

  /** The same collection for reads that return documents: every BSON type kept. */
  rawColl(database: string, name: string): Collection<Document> {
    if (!name) throw new MongoUserError('Falta el nombre de la colección.')
    return this.db(database).collection(name, RAW_BSON)
  }

  async serverInfo(): Promise<ServerInfo> {
    let uptime = 0
    let connections = 0
    try {
      const status = await this.client
        .db('admin')
        .command({ serverStatus: 1, repl: 0, metrics: 0, locks: 0, wiredTiger: 0 })
      uptime = Number(status.uptime ?? 0) || 0
      connections = Number(status.connections?.current ?? 0) || 0
    } catch {
      // serverStatus needs the clusterMonitor role: the panel shows zeros without it.
    }
    const mongo = mongoOf(this.config)
    // Short labels and values: the info panel gives them a narrow column.
    const details = [
      { label: 'Topología', value: topologyLabel(this.topology) },
      ...(this.topology === 'standalone'
        ? []
        : [{ label: 'Miembro', value: roleLabel(this.memberRole) }]),
      { label: 'BD por defecto', value: this.defaultDatabase },
      { label: 'Lectura', value: readPreferenceLabel(mongo.readPreference) },
      { label: 'Cifrado', value: this.tls ? 'TLS' : 'sin cifrar' },
      ...(this.config.ssh.enabled ? [{ label: 'Túnel SSH', value: this.config.ssh.host }] : [])
    ]
    return {
      version: this.serverVersion,
      versionComment: '',
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      characterSet: 'UTF-8',
      uptimeSeconds: uptime,
      threadsConnected: connections,
      engine: 'mongodb',
      details,
      runtime: {
        flavor: 'mongodb',
        versionNumber: versionNumber(this.serverVersion),
        transactions: this.transactions,
        returning: 'none',
        topology: this.topology,
        memberRole: this.memberRole
      }
    }
  }

  /* ---------- query-tab sessions ---------- */

  tab(key: string): MongoTab {
    let tab = this.tabs.get(key)
    if (!tab) {
      tab = { key, database: null, session: null, status: 'idle', lastUsed: Date.now() }
      this.tabs.set(key, tab)
    }
    tab.lastUsed = Date.now()
    return tab
  }

  hasTab(key: string): boolean {
    return this.tabs.has(key)
  }

  sessionState(key: string): TabSessionState {
    const tab = this.tabs.get(key)
    return {
      open: !!tab,
      transactionStatus: tab?.status ?? 'idle',
      effectiveSchema: null,
      database: tab?.database ?? null
    }
  }

  async beginTransaction(key: string): Promise<TabSessionState> {
    if (!this.transactions)
      throw new MongoUserError(
        'Las transacciones necesitan un conjunto de réplicas o un clúster fragmentado; este servidor es independiente.'
      )
    const tab = this.tab(key)
    if (tab.status !== 'idle')
      throw new MongoUserError(
        'Ya hay una transacción abierta en esta pestaña: confírmala o deshazla.'
      )
    tab.session ??= this.client.startSession()
    tab.session.startTransaction()
    tab.status = 'in'
    return this.sessionState(key)
  }

  async endTransaction(key: string, action: 'commit' | 'abort'): Promise<TabSessionState> {
    const tab = this.tabs.get(key)
    if (!tab || tab.status === 'idle' || !tab.session) return this.sessionState(key)
    try {
      if (action === 'commit') await tab.session.commitTransaction()
      else if (tab.session.inTransaction()) await tab.session.abortTransaction()
    } catch (err) {
      if (action === 'commit') {
        // A failed commit leaves the transaction aborted on the server.
        await tab.session.abortTransaction().catch(() => undefined)
        tab.status = 'idle'
        throw toServerError(err)
      }
    }
    tab.status = 'idle'
    return this.sessionState(key)
  }

  /** The session a statement of this tab runs on: only inside an explicit transaction. */
  sessionFor(key: string | undefined): ClientSession | undefined {
    if (!key) return undefined
    const tab = this.tabs.get(key)
    return tab && tab.status !== 'idle' && tab.session ? tab.session : undefined
  }

  /** After an error inside a transaction: the server aborted it when the error says so. */
  noteTransactionError(key: string | undefined, err: unknown): void {
    const tab = key ? this.tabs.get(key) : undefined
    if (!tab || tab.status === 'idle') return
    const e = err as { hasErrorLabel?: (l: string) => boolean; code?: unknown }
    if (e?.hasErrorLabel?.('TransientTransactionError') || e?.code === 251) tab.status = 'failed'
  }

  async closeTab(key: string): Promise<void> {
    const tab = this.tabs.get(key)
    if (!tab) return
    this.tabs.delete(key)
    if (tab.session) {
      if (tab.session.inTransaction()) await tab.session.abortTransaction().catch(() => undefined)
      await tab.session.endSession().catch(() => undefined)
    }
    for (const c of [...this.cursors.values()])
      if (c.owner === key) await this.closeCursor(c.id).catch(() => undefined)
  }

  /* ---------- cursors («Cargar más») ---------- */

  registerCursor(
    owner: string,
    cursor: AbstractCursor<Document>,
    whole: boolean,
    comment: string | null
  ): string {
    const id = randomUUID()
    this.cursors.set(id, { id, owner, cursor, whole, lastUsed: Date.now(), comment })
    const mine = [...this.cursors.values()]
      .filter((c) => c.owner === owner)
      .sort((a, b) => a.lastUsed - b.lastUsed)
    for (const old of mine.slice(0, Math.max(0, mine.length - CURSORS_PER_OWNER)))
      void this.closeCursor(old.id)
    return id
  }

  cursor(id: string): OpenCursor {
    const c = this.cursors.get(id)
    if (!c)
      throw new MongoUserError(
        'El resultado ya no está abierto (pasaron más de 10 minutos o se cerró): vuelve a ejecutar la consulta.'
      )
    c.lastUsed = Date.now()
    return c
  }

  async closeCursor(id: string): Promise<void> {
    const c = this.cursors.get(id)
    if (!c) return
    this.cursors.delete(id)
    await c.cursor.close().catch(() => undefined)
  }

  private async sweepCursors(): Promise<void> {
    const now = Date.now()
    for (const c of [...this.cursors.values()])
      if (now - c.lastUsed > CURSOR_IDLE_MS) await this.closeCursor(c.id)
  }

  /* ---------- executions and cancel ---------- */

  /** Comment the operations of an execution carry, so killOp can find them. */
  startExecution(executionId: string | undefined): string | null {
    if (!executionId) return null
    const comment = `vortaq:${executionId}`
    this.executions.set(executionId, { comment, cancelled: false })
    return comment
  }

  endExecution(executionId: string | undefined): void {
    if (executionId) this.executions.delete(executionId)
  }

  wasCancelled(executionId: string | undefined): boolean {
    return !!executionId && this.executions.get(executionId)?.cancelled === true
  }

  /**
   * Stops a running execution: finds its operations by comment in $currentOp
   * and kills them. Only an execution that is still registered as running is
   * touched, so a late cancel never hits the next statement.
   */
  async cancel(executionId: string): Promise<boolean> {
    const execution = this.executions.get(executionId)
    if (!execution) return false
    execution.cancelled = true
    return this.killByComment(execution.comment)
  }

  /** Kills every operation tagged with `comment`; true when one was found. */
  async killByComment(comment: string): Promise<boolean> {
    const admin = this.client.db('admin')
    const find = async (allUsers: boolean): Promise<Document[]> =>
      admin
        .aggregate([
          { $currentOp: { allUsers, idleConnections: false, idleSessions: false } },
          {
            $match: {
              $or: [
                { 'command.comment': comment },
                { comment },
                { 'originatingCommand.comment': comment }
              ]
            }
          },
          { $project: { opid: 1 } }
        ])
        .toArray()
    let ops: Document[]
    try {
      ops = await find(true)
    } catch {
      try {
        ops = await find(false)
      } catch {
        return false // $currentOp not allowed: nothing could be stopped on the server
      }
    }
    let killed = false
    for (const op of ops) {
      try {
        await admin.command({ killOp: 1, op: op.opid })
        killed = true
      } catch {
        // The operation may have finished meanwhile.
      }
    }
    return killed || ops.length === 0
  }

  /** Error of a statement: cancelled executions read «Consulta cancelada». */
  errorOf(err: unknown, executionId?: string): Error {
    if (this.wasCancelled(executionId) || (executionId && isInterrupted(err)))
      return new MongoUserError(CANCELLED, 'E_MONGO_CANCELLED')
    return toServerError(err)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    clearInterval(this.sweeper)
    for (const key of [...this.tabs.keys()]) await this.closeTab(key).catch(() => undefined)
    for (const id of [...this.cursors.keys()]) await this.closeCursor(id).catch(() => undefined)
    await this.client.close().catch(() => undefined)
  }
}

/** 8.2.1 → 80201. */
export function versionNumber(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((p) => parseInt(p, 10) || 0)
  return major * 10000 + minor * 100 + patch
}

export function isMongoConnection(c: { family?: string }): c is MongoDriverConnection {
  return c instanceof MongoDriverConnection
}
