/**
 * The SQLite worker as a plain Node child process (`child_process.fork`),
 * for integration tests that need a real process to kill. The app uses
 * worker.ts (Electron utilityProcess); the handler is the same.
 */
import { createWorkerHandler } from './workerMain'
import type { WorkerRequest } from './protocol'

if (!process.send) throw new Error('nodeWorker must run with child_process.fork')

const handle = createWorkerHandler()
process.on('message', (message) => {
  process.send!(handle(message as WorkerRequest))
})
