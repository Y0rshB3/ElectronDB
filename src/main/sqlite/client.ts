/**
 * Main-side RPC to one SQLite worker process. Requests are answered in order
 * (the worker is single-threaded), so the client only matches ids. kill()
 * ends the process at once, even in the middle of a statement: every pending
 * call rejects with `CancelledError` (section 5.5, cancel by kill).
 */
import type { WorkerOp, WorkerOps, WorkerResponse } from './protocol'
import type { ProcessSpawner, WorkerProcess } from './spawner'
import { CANCELLED_MESSAGE, SqliteUserError, WORKER_GONE, fromWorkerError } from './errors'

/** How long kill() waits for the exit event before giving up on it. */
const KILL_WAIT_MS = 1000

export class CancelledError extends SqliteUserError {
  constructor(message = CANCELLED_MESSAGE) {
    super(message, 'E_SQLITE_CANCELLED')
    this.name = 'CancelledError'
  }
}

interface Pending {
  resolve(value: unknown): void
  reject(err: Error): void
}

export class WorkerClient {
  private proc: WorkerProcess | null = null
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private killing = false
  private exited: Promise<void> | null = null

  constructor(
    private readonly spawner: ProcessSpawner,
    /** The process died without kill() (crash, OOM): the connection is gone. */
    private readonly onUnexpectedExit: (reason: string) => void
  ) {}

  get alive(): boolean {
    return this.proc !== null
  }

  /** Requests sent and not answered yet (a statement is running when > 0). */
  get busy(): boolean {
    return this.pending.size > 0
  }

  start(): void {
    if (this.proc) return
    const proc = this.spawner()
    this.proc = proc
    this.killing = false
    let markExited: () => void = () => undefined
    this.exited = new Promise((resolve) => (markExited = resolve))
    proc.onMessage((message: WorkerResponse) => {
      if (this.proc !== proc) return
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.ok) entry.resolve(message.result)
      else entry.reject(fromWorkerError(message.error))
    })
    proc.onExit(() => {
      markExited()
      if (this.proc !== proc) return
      this.proc = null
      const wasKilled = this.killing
      this.rejectAll(
        wasKilled ? new CancelledError() : new SqliteUserError(WORKER_GONE, 'E_SQLITE_GONE')
      )
      if (!wasKilled) this.onUnexpectedExit(WORKER_GONE)
    })
  }

  call<O extends WorkerOp>(op: O, ...args: WorkerOps[O]['args']): Promise<WorkerOps[O]['result']> {
    const proc = this.proc
    if (!proc)
      return Promise.reject(
        new SqliteUserError('La conexión SQLite está cerrada.', 'E_SQLITE_CLOSED')
      )
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      try {
        proc.postMessage({ id, op, args })
      } catch (err) {
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /**
   * Ends the process now. Pending calls reject with `CancelledError` (or the
   * given error). Resolves when the process is gone, or after 1 s at most.
   */
  async kill(reason?: Error): Promise<void> {
    const proc = this.proc
    if (!proc) return
    this.killing = true
    this.proc = null
    this.rejectAll(reason ?? new CancelledError())
    const exited = this.exited
    proc.kill()
    if (exited)
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, KILL_WAIT_MS))])
  }

  /** Closes the database and the process (no error when it is already gone). */
  async close(): Promise<void> {
    if (!this.proc) return
    try {
      await Promise.race([
        this.call('close'),
        new Promise((resolve) => setTimeout(resolve, KILL_WAIT_MS))
      ])
    } catch {
      /* closing a broken handle */
    }
    await this.kill(new SqliteUserError('La conexión SQLite se ha cerrado.', 'E_SQLITE_CLOSED'))
  }

  private rejectAll(err: Error): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const e of entries) e.reject(err)
  }
}
