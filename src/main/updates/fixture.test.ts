import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixtureFetch } from './fixture'
import { UpdateService } from './service'
import { apiRelease } from './testing'

describe('fixtureFetch (ELECTRONDB_UPDATES_FIXTURE)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'electrondb-fixture-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const svc = (file: string) =>
    new UpdateService({
      stateDir: dir,
      currentVersion: '0.1.2',
      platform: 'win32',
      arch: 'x64',
      runMode: () => ({ runMode: 'packaged' }),
      fetch: fixtureFetch(file)
    })

  it('serves a release file as the GitHub answer', async () => {
    const file = join(dir, 'release.json')
    writeFileSync(file, JSON.stringify(apiRelease()))
    const result = await svc(file).check(true)
    expect(result).toMatchObject({ status: 'available', latestVersion: '0.1.3' })
    expect(result.download?.fileName).toBe('ElectronDB-0.1.3-x64-setup.exe')
  })

  it('simulates HTTP errors and malformed bodies', async () => {
    const limited = join(dir, 'limited.json')
    writeFileSync(limited, JSON.stringify({ httpStatus: 429 }))
    expect((await svc(limited).check(true)).error).toMatch(/limitado/)
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{ nope')
    expect((await svc(broken).check(true)).error).toMatch(/formato esperado/)
  })
})
