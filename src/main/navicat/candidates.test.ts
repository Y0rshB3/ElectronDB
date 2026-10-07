import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { candidateRoots, findNavicatCandidates, rankCandidates } from './candidates'
import { FIXTURE_ROOT } from './testing'

const SUPPORT = ['Library', 'Application Support', 'PremiumSoft CyberTech']

/** Copy of the anonymised fixture (4 connections, 3 jobs) at `root`. */
function plant(root: string): void {
  mkdirSync(root, { recursive: true })
  cpSync(FIXTURE_ROOT, root, { recursive: true })
}

/** A Navicat folder whose conn.plist holds a single MySQL connection. */
function plantSmall(root: string): void {
  mkdirSync(join(root, 'Common'), { recursive: true })
  writeFileSync(
    join(root, 'Common', 'conn.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>0</key><dict><key>0</key><dict><key>MySQL</key><dict>
<key>Solo</key><dict><key>Host</key><string>127.0.0.1</string><key>Port</key><integer>3306</integer><key>UserName</key><string>u</string></dict>
</dict></dict></dict></dict></plist>`
  )
}

function snapshot(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      out.push(`${p}:${e.isDirectory() ? 'd' : statSync(p).mtimeMs}`)
      if (e.isDirectory()) walk(p)
    }
  }
  walk(dir)
  return out.sort()
}

describe('findNavicatCandidates', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'electrondb-candidates-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('finds nothing in an empty home', async () => {
    expect(await findNavicatCandidates({ home, platform: 'darwin' })).toEqual({
      supportedPlatform: true,
      candidates: []
    })
  })

  it('finds the usual macOS folder with its counts', async () => {
    const root = join(home, ...SUPPORT, 'Navicat CC')
    plant(root)
    const before = snapshot(root)
    const result = await findNavicatCandidates({ home, platform: 'darwin' })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({
      rootPath: root,
      source: 'default',
      connectionCount: 4,
      jobCount: 3
    })
    expect(result.candidates[0].modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // Read-only: nothing written or touched in the Navicat folder.
    expect(snapshot(root)).toEqual(before)
  })

  it('finds the App Store sandbox (container name matched case-insensitively)', async () => {
    const root = join(
      home,
      'Library',
      'Containers',
      'com.prect.NavicatPremium15',
      'Data',
      ...SUPPORT,
      'Navicat CC'
    )
    plant(root)
    // A container that is not Navicat's is never looked into.
    plant(join(home, 'Library', 'Containers', 'com.other.app', 'Data', ...SUPPORT, 'Navicat CC'))
    const result = await findNavicatCandidates({ home, platform: 'darwin' })
    expect(result.candidates.map((c) => [c.rootPath, c.source])).toEqual([[root, 'appStore']])
  })

  it('ranks several folders: most connections first, then the newest conn.plist', async () => {
    const usual = join(home, ...SUPPORT, 'Navicat CC')
    const legacy = join(home, ...SUPPORT, 'Navicat')
    const store = join(home, 'Library', 'Containers', 'navicat', 'Data', ...SUPPORT, 'Navicat CC')
    plantSmall(usual)
    plant(legacy)
    plantSmall(store)
    const old = new Date('2024-01-01T00:00:00Z')
    utimesSync(join(usual, 'Common', 'conn.plist'), old, old)
    const result = await findNavicatCandidates({ home, platform: 'darwin' })
    expect(result.candidates.map((c) => [c.source, c.connectionCount])).toEqual([
      ['legacy', 4],
      ['appStore', 1],
      ['default', 1]
    ])
  })

  it('skips folders whose conn.plist is missing or does not parse', async () => {
    const broken = join(home, ...SUPPORT, 'Navicat CC')
    mkdirSync(join(broken, 'Common'), { recursive: true })
    writeFileSync(join(broken, 'Common', 'conn.plist'), '<plist><dict><key>MySQL</key')
    // Legacy folder without Common/conn.plist.
    mkdirSync(join(home, ...SUPPORT, 'Navicat', 'Common'), { recursive: true })
    expect((await findNavicatCandidates({ home, platform: 'darwin' })).candidates).toEqual([])
  })

  it('lists a folder reached twice (symlink) only once', async () => {
    const real = join(home, 'Library', 'Containers', 'Navicat', 'Data', ...SUPPORT, 'Navicat CC')
    plant(real)
    mkdirSync(join(home, ...SUPPORT), { recursive: true })
    symlinkSync(real, join(home, ...SUPPORT, 'Navicat CC'))
    const result = await findNavicatCandidates({ home, platform: 'darwin' })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].source).toBe('default')
  })

  for (const platform of ['win32', 'linux'] as const) {
    it(`${platform}: unsupported format, but a copied «Navicat CC» up to two levels deep is found`, async () => {
      const shallow = join(home, 'Navicat CC')
      const deep = join(home, 'Documents', 'navicat cc')
      const tooDeep = join(home, 'a', 'b', 'Navicat CC')
      const hidden = join(home, '.cache', 'Navicat CC')
      plantSmall(shallow)
      plant(deep)
      plant(tooDeep)
      plant(hidden)
      // The macOS folder means nothing outside macOS.
      plant(join(home, ...SUPPORT, 'Navicat CC'))
      const result = await findNavicatCandidates({ home, platform })
      expect(result.supportedPlatform).toBe(false)
      expect(result.candidates.map((c) => [c.rootPath, c.source])).toEqual([
        [deep, 'copied'],
        [shallow, 'copied']
      ])
    })

    it(`${platform}: nothing copied -> no candidates`, async () => {
      mkdirSync(join(home, 'Documents'), { recursive: true })
      expect(await findNavicatCandidates({ home, platform })).toEqual({
        supportedPlatform: false,
        candidates: []
      })
    })
  }

  it('override roots (test switch) replace the usual locations', async () => {
    plant(join(home, ...SUPPORT, 'Navicat CC'))
    const result = await findNavicatCandidates({
      home,
      platform: 'darwin',
      overrideRoots: [FIXTURE_ROOT, join(home, 'missing')]
    })
    expect(result.candidates.map((c) => c.rootPath)).toEqual([FIXTURE_ROOT])
  })
})

describe('candidateRoots', () => {
  it('is empty without a home folder', async () => {
    expect(await candidateRoots('', 'darwin')).toEqual([])
  })
})

describe('rankCandidates', () => {
  it('keeps unknown dates last among equals', () => {
    const c = (rootPath: string, connectionCount: number, modifiedAt: string | null) => ({
      rootPath,
      source: 'default' as const,
      connectionCount,
      jobCount: 0,
      backupCount: 0,
      modifiedAt
    })
    expect(
      rankCandidates([c('a', 1, null), c('b', 1, '2026-01-01T00:00:00.000Z'), c('c', 2, null)]).map(
        (x) => x.rootPath
      )
    ).toEqual(['c', 'b', 'a'])
  })
})
