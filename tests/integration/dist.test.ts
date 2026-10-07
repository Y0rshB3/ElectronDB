import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  expectedArtifacts,
  hashFile,
  parseUpdateYml,
  type Platform
} from '../../scripts/release-lib.mjs'
import { parseSha256Sums } from '../../src/main/updates/macDmg'

/**
 * Real installer builds (slow: several minutes). Opt-in:
 *   npm run build
 *   ELECTRONDB_TEST_DIST_DIR=<scratch dir> npx vitest run tests/integration/dist.test.ts
 * Builds every target with scripts/release.mjs into that folder (never publishes) and checks
 * that latest.yml / latest-linux.yml / latest-mac.yml reference the public file names with the
 * sha512 of the files, and that SHA256SUMS.txt matches.
 */
const DIR = process.env.ELECTRONDB_TEST_DIST_DIR
const ROOT = resolve(__dirname, '..', '..')
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string

describe.skipIf(!DIR)('release build (electron-builder, real)', () => {
  const out = resolve(DIR ?? '.', `v${version}`)

  it(
    'builds all targets and writes consistent update feeds',
    async () => {
      const res = spawnSync(
        process.execPath,
        ['scripts/release.mjs', '--out', out, '--skip-build', '--clean'],
        { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GH_TOKEN: '' } }
      )
      expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0)

      const feeds: Record<Platform, string> = {
        win: `ElectronDB-${version}-x64-setup.exe`,
        linux: `ElectronDB-${version}-x86_64.AppImage`,
        mac: `ElectronDB-${version}-arm64-mac.zip`
      }
      const artifacts = expectedArtifacts(version)
      for (const platform of ['win', 'linux', 'mac'] as const) {
        const yml = parseUpdateYml(readFileSync(join(out, artifacts[platform].updateInfo), 'utf8'))
        expect(yml.version).toBe(version)
        const entry = yml.files.find((f) => f.url === feeds[platform])
        expect(entry?.sha512, `${platform}: ${feeds[platform]}`).toBeTruthy()
        expect(entry?.sha512).toBe(await hashFile(join(out, feeds[platform]), 'sha512', 'base64'))
        for (const name of [...artifacts[platform].binaries, ...artifacts[platform].blockmaps])
          expect(existsSync(join(out, name)), name).toBe(true)
      }
      expect(parseUpdateYml(readFileSync(join(out, 'latest.yml'), 'utf8')).path).toBe(feeds.win)
      expect(parseUpdateYml(readFileSync(join(out, 'latest-linux.yml'), 'utf8')).path).toBe(
        feeds.linux
      )
      const macNames = parseUpdateYml(readFileSync(join(out, 'latest-mac.yml'), 'utf8')).files.map(
        (f) => f.url
      )
      expect(macNames.sort()).toEqual(
        [
          `ElectronDB-${version}-arm64-mac.zip`,
          `ElectronDB-${version}-arm64.dmg`,
          `ElectronDB-${version}-x64-mac.zip`,
          `ElectronDB-${version}-x64.dmg`
        ].sort()
      )

      const sums = parseSha256Sums(readFileSync(join(out, 'SHA256SUMS.txt'), 'utf8'))
      const dmg = `ElectronDB-${version}-arm64.dmg`
      expect(sums.get(dmg)).toBe(await hashFile(join(out, dmg), 'sha256', 'hex'))
      expect([...sums.keys()].sort()).toEqual(
        Object.values(artifacts)
          .flatMap((a) => a.binaries)
          .sort()
      )
    },
    30 * 60 * 1000
  )
})
