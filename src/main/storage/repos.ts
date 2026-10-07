import { join } from 'node:path'
import type { AiEffort } from '@shared/ai'
import type {
  AppSettings,
  ConnectionConfig,
  ConnectionInput,
  Job,
  JobInput,
  JobRun
} from '@shared/types'
import {
  DEFAULT_TYPED_CONFIRM_ENVIRONMENTS,
  normalizeTypedConfirmEnvironments
} from '@shared/typedConfirm'
import { JsonStore } from './jsonStore'
import { newId, nowIso } from './ids'

interface ListDoc<T> {
  version: number
  items: T[]
}

const listDefaults = <T>(): ListDoc<T> => ({ version: 1, items: [] })

export class ConnectionsRepo {
  private store: JsonStore<ListDoc<ConnectionConfig>>
  constructor(dir: string) {
    this.store = new JsonStore<ListDoc<ConnectionConfig>>(
      join(dir, 'connections.json'),
      listDefaults
    )
  }
  list(): ConnectionConfig[] {
    return [...this.store.get().items].sort((a, b) => a.name.localeCompare(b.name))
  }
  get(id: string): ConnectionConfig | null {
    return this.store.get().items.find((c) => c.id === id) ?? null
  }
  findByName(name: string): ConnectionConfig | null {
    return this.store.get().items.find((c) => c.name === name) ?? null
  }
  save(input: ConnectionInput): ConnectionConfig {
    const existing = input.id ? this.get(input.id) : null
    const now = nowIso()
    const record: ConnectionConfig = {
      ...input,
      id: existing?.id ?? input.id ?? newId(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    this.store.update((d) => {
      const idx = d.items.findIndex((c) => c.id === record.id)
      if (idx >= 0) d.items[idx] = record
      else d.items.push(record)
    })
    return record
  }
  delete(id: string): void {
    this.store.update((d) => {
      d.items = d.items.filter((c) => c.id !== id)
    })
  }
}

export class JobsRepo {
  private store: JsonStore<ListDoc<Job>>
  constructor(dir: string) {
    this.store = new JsonStore<ListDoc<Job>>(join(dir, 'jobs.json'), listDefaults)
  }
  list(): Job[] {
    return [...this.store.get().items].sort((a, b) => a.name.localeCompare(b.name))
  }
  get(id: string): Job | null {
    return this.store.get().items.find((j) => j.id === id) ?? null
  }
  findByName(name: string): Job | null {
    return this.store.get().items.find((j) => j.name === name) ?? null
  }
  save(input: JobInput): Job {
    const existing = input.id ? this.get(input.id) : null
    const now = nowIso()
    const record: Job = {
      ...input,
      id: existing?.id ?? input.id ?? newId(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastRunAt: existing?.lastRunAt ?? null
    }
    this.store.update((d) => {
      const idx = d.items.findIndex((j) => j.id === record.id)
      if (idx >= 0) d.items[idx] = record
      else d.items.push(record)
    })
    return record
  }
  touchLastRun(id: string, at: string): void {
    this.store.update((d) => {
      const j = d.items.find((x) => x.id === id)
      if (j) j.lastRunAt = at
    })
  }
  delete(id: string): void {
    this.store.update((d) => {
      d.items = d.items.filter((j) => j.id !== id)
    })
  }
}

const MAX_RUNS = 500

export class RunsRepo {
  private store: JsonStore<ListDoc<JobRun>>
  constructor(dir: string) {
    this.store = new JsonStore<ListDoc<JobRun>>(join(dir, 'job-runs.json'), listDefaults)
  }
  list(jobId: string | null, limit = 50): JobRun[] {
    const items = this.store.get().items.filter((r) => !jobId || r.jobId === jobId)
    return items.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit)
  }
  get(id: string): JobRun | null {
    return this.store.get().items.find((r) => r.id === id) ?? null
  }
  upsert(run: JobRun): JobRun {
    this.store.update((d) => {
      const idx = d.items.findIndex((r) => r.id === run.id)
      if (idx >= 0) d.items[idx] = run
      else d.items.push(run)
      if (d.items.length > MAX_RUNS) {
        d.items.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        d.items.length = MAX_RUNS
      }
    })
    return run
  }
}

/**
 * Where Navicat for MySQL keeps its data on macOS. Other OS have no default:
 * Navicat for Windows uses the Registry (not supported yet), so the user points
 * the import at a `Navicat CC` folder copied from a Mac.
 */
export function defaultNavicatRootPath(
  home: string,
  platform: NodeJS.Platform = process.platform
): string {
  return platform === 'darwin' ? macNavicatRootPath(home) : ''
}

const macNavicatRootPath = (home: string): string =>
  join(home, 'Library', 'Application Support', 'PremiumSoft CyberTech', 'Navicat CC')

export const DEFAULT_AI_MAX_TOKENS = 16000
const AI_EFFORTS: readonly AiEffort[] = ['low', 'medium', 'high']

/** Max output tokens accepted in Ajustes (the providers cap it further per model). */
export function normalizeAiMaxTokens(value: unknown): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n < 256) return DEFAULT_AI_MAX_TOKENS
  return Math.min(n, 128000)
}

export const DEFAULT_SETTINGS = (
  userData: string,
  home: string,
  platform: NodeJS.Platform = process.platform
): AppSettings => ({
  navicatRootPath: defaultNavicatRootPath(home, platform),
  backupsRootDir: join(userData, 'backups'),
  defaultRowLimit: 1000,
  theme: 'dark',
  typedConfirmEnvironments: [...DEFAULT_TYPED_CONFIRM_ENVIRONMENTS],
  confirmDestructiveEverywhere: true,
  checkUpdatesOnStartup: true,
  autoDownloadUpdates: false,
  aiEnabled: false,
  aiDefaultProviderId: null,
  aiEffort: 'low',
  aiMaxTokens: DEFAULT_AI_MAX_TOKENS
})

/**
 * settings.json as stored. `confirmProductionWrites` is the pre-0.1.5 boolean:
 * it is read only to be dropped (production can no longer be turned off) and
 * never written again.
 */
type StoredSettings = AppSettings & { confirmProductionWrites?: unknown }

export class SettingsRepo {
  private store: JsonStore<StoredSettings>
  /** The macOS default that older builds also saved on Windows/Linux (never valid there). */
  private readonly staleMacDefault: string | null
  constructor(dir: string, home: string, platform: NodeJS.Platform = process.platform) {
    this.store = new JsonStore<StoredSettings>(join(dir, 'settings.json'), () =>
      DEFAULT_SETTINGS(dir, home, platform)
    )
    this.staleMacDefault = platform === 'darwin' ? null : macNavicatRootPath(home)
  }
  get(): AppSettings {
    const { confirmProductionWrites: _legacy, ...stored } = this.store.get()
    const settings: AppSettings = {
      ...stored,
      // Only an explicit false turns the destructive confirmation off (missing or invalid: on).
      confirmDestructiveEverywhere: stored.confirmDestructiveEverywhere !== false,
      // Old profiles (only confirmProductionWrites, true or false), missing or invalid values:
      // ['production'] at least. Production is always added back.
      typedConfirmEnvironments: normalizeTypedConfirmEnvironments(stored.typedConfirmEnvironments),
      // Only an explicit true downloads updates without a click (profiles before 0.1.9: off).
      autoDownloadUpdates: stored.autoDownloadUpdates === true,
      // Profiles saved before 0.1.6 have no AI fields: assistant off.
      aiEnabled: stored.aiEnabled === true,
      aiDefaultProviderId:
        typeof stored.aiDefaultProviderId === 'string' ? stored.aiDefaultProviderId : null,
      aiEffort: AI_EFFORTS.includes(stored.aiEffort) ? stored.aiEffort : 'low',
      aiMaxTokens: normalizeAiMaxTokens(stored.aiMaxTokens)
    }
    return settings.navicatRootPath === this.staleMacDefault
      ? { ...settings, navicatRootPath: '' }
      : settings
  }
  update(patch: Partial<AppSettings>): AppSettings {
    this.store.update((s) => {
      const { confirmProductionWrites: _ignored, ...rest } = (patch ??
        {}) as Partial<StoredSettings>
      Object.assign(s, rest)
      s.typedConfirmEnvironments = normalizeTypedConfirmEnvironments(s.typedConfirmEnvironments)
      delete s.confirmProductionWrites
    })
    return this.get()
  }
}
