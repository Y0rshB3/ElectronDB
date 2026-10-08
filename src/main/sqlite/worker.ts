/**
 * Entry of the SQLite utility process (electron-vite input `sqliteWorker`,
 * built to out/main/sqliteWorker.js). One process per open SQLite connection:
 * node:sqlite is synchronous, so a long query only blocks this process, and
 * cancel kills it (docs/multi-engine-design.md, section 5.6).
 */
import { createWorkerHandler } from './workerMain'
import type { WorkerRequest } from './protocol'

const port = (process as unknown as { parentPort?: Electron.ParentPort }).parentPort
if (!port) throw new Error('El proceso de SQLite debe arrancar con utilityProcess.fork')

const handle = createWorkerHandler()
port.on('message', (event) => {
  port.postMessage(handle(event.data as WorkerRequest))
})
