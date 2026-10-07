import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { countNb3Files } from './backupsScan'
import { detectNavicat } from './detect'
import { navicatPaths } from './paths'
import { FIXTURE_ROOT } from './testing'

describe('detectNavicat', () => {
  it('detects the fixture root', async () => {
    const paths = navicatPaths(FIXTURE_ROOT)
    const detection = await detectNavicat(FIXTURE_ROOT)
    expect(detection).toEqual({
      found: true,
      rootPath: FIXTURE_ROOT,
      connPlistPath: paths.connPlist,
      prefPlistPath: paths.prefPlist,
      profilesDir: paths.profilesDir,
      connectionCount: 4,
      jobCount: 3,
      backupCount: 0
    })
  })

  it('never throws for a missing or empty root', async () => {
    const missing = await detectNavicat('/nonexistent/Navicat CC')
    expect(missing).toMatchObject({
      found: false,
      rootPath: '/nonexistent/Navicat CC',
      connectionCount: 0,
      jobCount: 0,
      backupCount: 0,
      connPlistPath: null
    })
    expect((await detectNavicat('')).found).toBe(false)
  })

  describe('with backups under the default savepath', () => {
    let root: string
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'vortaq-detect-'))
      cpSync(FIXTURE_ROOT, root, { recursive: true })
      const settings = navicatPaths(root).settingsDir
      mkdirSync(join(settings, 'Dev', 'accounts'), { recursive: true })
      mkdirSync(join(settings, 'Dev', 'inventory'), { recursive: true })
      mkdirSync(join(settings, 'Production', 'billing'), { recursive: true })
      writeFileSync(join(settings, 'Dev', 'accounts', '20260317144801.nb3'), '')
      writeFileSync(join(settings, 'Dev', 'inventory', '20260317144802.nb3'), '')
      writeFileSync(join(settings, 'Dev', 'inventory', 'notes.txt'), '')
      writeFileSync(join(settings, 'Production', 'billing', '20260317144803-label.NB3'), '')
      // Folders that do not belong to a connection are ignored.
      mkdirSync(join(settings, 'Unknown'), { recursive: true })
      writeFileSync(join(settings, 'Unknown', 'x.nb3'), '')
    })
    afterEach(() => rmSync(root, { recursive: true, force: true }))

    it('counts .nb3 files recursively per connection', async () => {
      const detection = await detectNavicat(root)
      expect(detection.found).toBe(true)
      expect(detection.backupCount).toBe(3)
      expect(await countNb3Files(join(navicatPaths(root).settingsDir, 'Dev'))).toBe(2)
      expect(await countNb3Files('/nonexistent')).toBe(0)
    })

    it('reports a corrupt conn.plist as found with zero connections', async () => {
      writeFileSync(navicatPaths(root).connPlist, '<plist><dict>')
      const detection = await detectNavicat(root)
      expect(detection.found).toBe(true)
      expect(detection.connectionCount).toBe(0)
      expect(detection.jobCount).toBe(3)
    })
  })
})
