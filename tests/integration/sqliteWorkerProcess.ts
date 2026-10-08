/**
 * Real-process SQLite worker for integration tests: src/main/sqlite/nodeWorker.ts
 * bundled once with esbuild (node:sqlite stays a builtin) and forked as a
 * Node child process, so cancel-by-kill is measured on a real process.
 */
import { fork } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import type { ProcessSpawner, WorkerProcess } from '@main/sqlite/spawner'
import type { WorkerResponse } from '@main/sqlite/protocol'

let bundled: Promise<string> | null = null

async function bundle(): Promise<string> {
  const out = join(mkdtempSync(join(tmpdir(), 'vortaq-sqlite-worker-')), 'nodeWorker.cjs')
  await build({
    entryPoints: [resolve('src/main/sqlite/nodeWorker.ts')],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    alias: { '@shared': resolve('src/shared'), '@main': resolve('src/main') },
    logLevel: 'silent'
  })
  return out
}

/** A spawner whose workers are real Node processes (bundled on first use). */
export async function childProcessSpawner(): Promise<ProcessSpawner & { pids: number[] }> {
  bundled ??= bundle()
  const entry = await bundled
  const pids: number[] = []
  const spawner = (() => {
    const child = fork(entry, [], { stdio: 'ignore', serialization: 'advanced' })
    if (child.pid) pids.push(child.pid)
    const proc: WorkerProcess = {
      postMessage: (message) => {
        child.send(message)
      },
      onMessage: (listener) => {
        child.on('message', (m) => listener(m as WorkerResponse))
      },
      onExit: (listener) => {
        child.once('exit', (code) => listener(code))
      },
      kill: () => {
        child.kill('SIGKILL')
      }
    }
    return proc
  }) as ProcessSpawner & { pids: number[] }
  spawner.pids = pids
  return spawner
}
