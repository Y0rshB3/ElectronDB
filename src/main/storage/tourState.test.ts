import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { profileHadData, TOUR_FILE, TourStateService } from './tourState'

describe('TourStateService (first-run logic)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'electrondb-tour-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const service = (opts: { suppressWelcome?: boolean } = {}) =>
    new TourStateService({
      dir,
      currentVersion: '0.1.7',
      profileHadData: profileHadData(dir),
      ...opts
    })
  const stored = () => JSON.parse(readFileSync(join(dir, TOUR_FILE), 'utf8'))

  it('fresh profile: the welcome tour is due, and the decision is written at once', () => {
    expect(service().state()).toEqual({
      showWelcome: true,
      welcomeTourDone: false,
      tourSeenVersion: '0.1.7'
    })
    expect(stored()).toMatchObject({ welcomeTourDone: false, origin: 'fresh' })
  })

  it('fresh profile quit mid-tour: still due on the next start (settings.json written meanwhile)', () => {
    service().state()
    writeFileSync(join(dir, 'settings.json'), '{}')
    expect(service().state().showWelcome).toBe(true)
  })

  for (const file of ['connections.json', 'settings.json', 'jobs.json', 'updates.json']) {
    it(`profile upgraded from ≤ 0.1.6 (${file} present): no welcome tour`, () => {
      writeFileSync(join(dir, file), '{}')
      expect(service().state()).toEqual({
        showWelcome: false,
        welcomeTourDone: true,
        tourSeenVersion: null
      })
      expect(stored()).toMatchObject({ welcomeTourDone: true, origin: 'upgrade' })
    })
  }

  it('finished or skipped: recorded with the version, not shown again; a replay keeps it done', () => {
    const s = service()
    expect(s.markWelcomeDone()).toEqual({
      showWelcome: false,
      welcomeTourDone: true,
      tourSeenVersion: '0.1.7'
    })
    expect(service().state().showWelcome).toBe(false)
    // «Ver tour de bienvenida» marks it done again: harmless.
    expect(service().markWelcomeDone().welcomeTourDone).toBe(true)
  })

  it('smoke runs never show it and write nothing', () => {
    expect(service({ suppressWelcome: true }).state().showWelcome).toBe(false)
    expect(existsSync(join(dir, TOUR_FILE))).toBe(false)
  })

  it('a hand-edited file with junk falls back to safe values', () => {
    writeFileSync(
      join(dir, TOUR_FILE),
      JSON.stringify({ welcomeTourDone: 'yes', tourSeenVersion: 7 })
    )
    expect(service().state()).toEqual({
      showWelcome: true,
      welcomeTourDone: false,
      tourSeenVersion: null
    })
  })
})
