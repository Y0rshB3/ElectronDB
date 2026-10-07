import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TourState } from '@shared/tour'
import { JsonStore } from './jsonStore'

/**
 * Onboarding state of a profile: <userData>/tour.json.
 *
 * The welcome tour is for a fresh profile only. The first time this runs on a
 * profile, the decision is written down at once so it survives a crash or a
 * quit in the middle of the tour:
 * - fresh profile (none of PROFILE_FILES existed when the app started): the
 *   tour is due until it is finished or skipped;
 * - profile used by an older build (≤ 0.1.6, before the tour existed): the
 *   user already knows the app, the welcome tour counts as done (the
 *   «novedades» popup offers the «Mostrarme cómo» steps instead).
 */
export const TOUR_FILE = 'tour.json'

/** Files whose presence at start means the profile was used before. */
export const PROFILE_FILES = ['connections.json', 'settings.json', 'jobs.json', 'updates.json']

export interface StoredTourState {
  welcomeTourDone: boolean
  tourSeenVersion: string | null
  /** How the first decision was taken (diagnostics only). */
  origin?: 'fresh' | 'upgrade'
}

/** True when the profile already held data before this start (call it before any write). */
export function profileHadData(dir: string): boolean {
  return PROFILE_FILES.some((f) => existsSync(join(dir, f)))
}

function sanitize(raw: unknown): StoredTourState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    welcomeTourDone: r.welcomeTourDone === true,
    tourSeenVersion: typeof r.tourSeenVersion === 'string' ? r.tourSeenVersion : null,
    ...(r.origin === 'fresh' || r.origin === 'upgrade' ? { origin: r.origin } : {})
  }
}

export interface TourStateOptions {
  dir: string
  currentVersion: string
  /** Snapshot taken at start, before anything wrote to the profile. */
  profileHadData: boolean
  /** Smoke runs never show the tour (nothing is recorded either). */
  suppressWelcome?: boolean
}

export class TourStateService {
  private store: JsonStore<StoredTourState> | null = null

  constructor(private readonly options: TourStateOptions) {}

  private path(): string {
    return join(this.options.dir, TOUR_FILE)
  }

  /** Loads tour.json, creating it with the first-run decision when missing. */
  private ensure(): JsonStore<StoredTourState> {
    if (this.store) return this.store
    const existed = existsSync(this.path())
    const upgrade = this.options.profileHadData
    this.store = new JsonStore<StoredTourState>(
      this.path(),
      () => ({
        welcomeTourDone: upgrade,
        tourSeenVersion: upgrade ? null : this.options.currentVersion,
        origin: upgrade ? 'upgrade' : 'fresh'
      }),
      sanitize
    )
    if (!existed && !this.options.suppressWelcome) this.store.save()
    return this.store
  }

  state(): TourState {
    const s = this.ensure().get()
    return {
      showWelcome: !s.welcomeTourDone && !this.options.suppressWelcome,
      welcomeTourDone: s.welcomeTourDone,
      tourSeenVersion: s.tourSeenVersion
    }
  }

  markWelcomeDone(): TourState {
    this.ensure().update((s) => {
      s.welcomeTourDone = true
      s.tourSeenVersion = this.options.currentVersion
    })
    return this.state()
  }
}
