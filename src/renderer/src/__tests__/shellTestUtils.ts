import { vi } from 'vitest'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { vuetifyOptions } from '@renderer/plugins/vuetify'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { ConnectionConfig, ServerInfo, TableInfo } from '@shared/types'

type Handler = (...args: unknown[]) => unknown

export interface MockBridge {
  invoke: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  emit<E extends IpcEventChannel>(channel: E, payload: IpcEventMap[E]): void
  listenerCount(channel: IpcEventChannel): number
}

/** Installs a fake window.electronDB that answers from `handlers` (undefined otherwise). */
export function installBridge(handlers: Record<string, Handler | unknown> = {}): MockBridge {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    const h = handlers[channel]
    if (typeof h === 'function') return (h as Handler)(...args)
    return h
  })
  const on = vi.fn((channel: string, listener: (payload: unknown) => void) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel)!.add(listener)
    return () => listeners.get(channel)?.delete(listener)
  })
  window.electronDB = { invoke, on } as never
  return {
    invoke,
    on,
    emit: (channel, payload) => listeners.get(channel)?.forEach((l) => l(payload)),
    listenerCount: (channel) => listeners.get(channel)?.size ?? 0
  }
}

/** jsdom lacks a few browser APIs that Vuetify overlays use. */
export function installDomPolyfills(): void {
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as Record<string, unknown>).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
  if (!('visualViewport' in globalThis)) {
    const viewport = Object.assign(new EventTarget(), {
      width: 1280,
      height: 800,
      offsetLeft: 0,
      offsetTop: 0,
      pageLeft: 0,
      pageTop: 0,
      scale: 1
    })
    ;(globalThis as Record<string, unknown>).visualViewport = viewport
  }
}

/**
 * Vuetify instance with every component registered. The app relies on
 * vite-plugin-vuetify auto-import, which the Vitest config does not run.
 */
export function createTestVuetify() {
  return createVuetify({ ...vuetifyOptions, components, directives })
}

export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

export function makeConnection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: 'c1',
    name: 'Local dev',
    engine: 'mysql',
    color: '#69f0ae',
    environment: 'local',
    host: '127.0.0.1',
    port: 33306,
    username: 'tester',
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
    backupDir: '/tmp/backups',
    extraBackupDirs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

export function makeServerInfo(overrides: Partial<ServerInfo> = {}): ServerInfo {
  return {
    version: '8.4.7',
    versionComment: 'MySQL Community Server',
    host: '127.0.0.1',
    port: 33306,
    username: 'tester',
    characterSet: 'utf8mb4',
    uptimeSeconds: 3600,
    threadsConnected: 1,
    ...overrides
  }
}

export function makeTable(name: string, overrides: Partial<TableInfo> = {}): TableInfo {
  return {
    name,
    engine: 'InnoDB',
    rows: 10,
    dataLength: 16384,
    indexLength: 0,
    autoIncrement: null,
    createTime: '2026-01-02T10:00:00.000Z',
    updateTime: null,
    collation: 'utf8mb4_0900_ai_ci',
    comment: '',
    ...overrides
  }
}
