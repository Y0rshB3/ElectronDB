/**
 * How main starts a SQLite worker. The app registers the Electron
 * `utilityProcess` spawner at startup (electronSpawner.ts); node-side tests
 * inject an in-process fake, so nothing here imports Electron (CLAUDE.md).
 */
import type { WorkerRequest, WorkerResponse } from './protocol'
import { createWorkerHandler, type WorkerHandler } from './workerMain'

export interface WorkerProcess {
  postMessage(message: WorkerRequest): void
  onMessage(listener: (message: WorkerResponse) => void): void
  /** Fires once when the process is gone (killed, crashed or exited). */
  onExit(listener: (code: number | null) => void): void
  /** Ends the process now, also while a statement is running. */
  kill(): void
}

export type ProcessSpawner = () => WorkerProcess

let configured: ProcessSpawner | null = null

/** Registers the spawner the SQLite driver uses (main/index.ts, tests). */
export function setSqliteSpawner(spawner: ProcessSpawner | null): void {
  configured = spawner
}

export function getSqliteSpawner(): ProcessSpawner {
  if (!configured)
    throw new Error('SQLite no está disponible en este proceso (no hay lanzador de procesos).')
  return configured
}

export interface InProcessOptions {
  /** Handler used by the fake process (default: a real SqliteCore). */
  handler?: () => WorkerHandler
  /**
   * Called before each request; return 'hang' to never answer it (a statement
   * that never ends), so tests can check cancel by kill.
   */
  intercept?: (request: WorkerRequest) => 'hang' | void
}

/**
 * Spawner whose "process" runs the worker handler in this process, answering
 * asynchronously like the real one. kill() drops every later answer and fires
 * the exit listeners, as a killed process would.
 */
export function inProcessSpawner(options: InProcessOptions = {}): ProcessSpawner & {
  spawned: number
} {
  const spawn = (() => {
    spawn.spawned++
    const handle = (options.handler ?? (() => createWorkerHandler()))()
    const messageListeners: ((m: WorkerResponse) => void)[] = []
    const exitListeners: ((code: number | null) => void)[] = []
    let alive = true
    const proc: WorkerProcess = {
      postMessage(message) {
        if (!alive) return
        if (options.intercept?.(message) === 'hang') return
        setImmediate(() => {
          if (!alive) return
          const response = handle(structuredClone(message))
          if (alive) for (const l of messageListeners) l(structuredClone(response))
        })
      },
      onMessage(listener) {
        messageListeners.push(listener)
      },
      onExit(listener) {
        exitListeners.push(listener)
      },
      kill() {
        if (!alive) return
        alive = false
        // A killed handle is closed by the OS; close it so the file is released.
        try {
          handle({ id: -1, op: 'close', args: [] })
        } catch {
          /* already closed */
        }
        setImmediate(() => {
          for (const l of exitListeners) l(null)
        })
      }
    }
    return proc
  }) as ProcessSpawner & { spawned: number }
  spawn.spawned = 0
  return spawn
}
