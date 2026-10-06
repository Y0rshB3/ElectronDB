import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LogEvent } from '@shared/types'
import { envVar } from './env'

type Level = LogEvent['level']

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

let filePath: string | null = null
let minLevel: Level = 'info'
let sink: ((event: LogEvent) => void) | null = null

export function configureLog(options: {
  filePath?: string | null
  minLevel?: Level
  sink?: ((e: LogEvent) => void) | null
}): void {
  if (options.filePath !== undefined) {
    filePath = options.filePath
    if (filePath) mkdirSync(dirname(filePath), { recursive: true })
  }
  if (options.minLevel) minLevel = options.minLevel
  if (options.sink !== undefined) sink = options.sink
}

function write(level: Level, scope: string, message: string, extra?: unknown): void {
  if (LEVELS[level] < LEVELS[minLevel]) return
  const at = new Date().toISOString()
  const line = `${at} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${extra !== undefined ? ' ' + safeStringify(extra) : ''}`
  if (filePath) {
    try {
      appendFileSync(filePath, line + '\n')
    } catch {
      /* logging must never throw */
    }
  }
  if (level === 'error' || level === 'warn') console.error(line)
  else if (envVar('DEBUG')) console.log(line)
  sink?.({ level, scope, message, at })
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export interface Logger {
  debug(message: string, extra?: unknown): void
  info(message: string, extra?: unknown): void
  warn(message: string, extra?: unknown): void
  error(message: string, extra?: unknown): void
}

export function getLogger(scope: string): Logger {
  return {
    debug: (m, e) => write('debug', scope, m, e),
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e)
  }
}
