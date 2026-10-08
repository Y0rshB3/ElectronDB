/**
 * The real SQLite worker: an Electron utility process running
 * out/main/sqliteWorker.js (electron-vite input `sqliteWorker`). Kept apart from
 * spawner.ts so node-side code and tests never import Electron.
 */
import { join } from 'node:path'
import { utilityProcess } from 'electron'
import type { ProcessSpawner, WorkerProcess } from './spawner'
import type { WorkerResponse } from './protocol'

export const electronSqliteSpawner: ProcessSpawner = () => {
  const child = utilityProcess.fork(join(__dirname, 'sqliteWorker.js'), [], {
    serviceName: 'Vortaq SQLite',
    stdio: 'ignore'
  })
  const proc: WorkerProcess = {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => {
      child.on('message', (message: WorkerResponse) => listener(message))
    },
    onExit: (listener) => {
      child.once('exit', (code: number) => listener(code))
    },
    kill: () => {
      child.kill()
    }
  }
  return proc
}
