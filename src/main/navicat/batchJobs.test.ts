import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Job } from '@shared/types'
import { jobNameFromFile, parseBatchJob, readNavicatJobs } from './batchJobs'
import { FIXTURE_ROOT } from './testing'

describe('readNavicatJobs', () => {
  it('reads the three fixture jobs with 15 backupschema tasks each', async () => {
    const jobs = await readNavicatJobs(FIXTURE_ROOT, [])
    expect(jobs.map((j) => j.fileName)).toEqual([
      'Backup dev.nbatmysql',
      'Backup staging.nbatmysql',
      'backup prod.nbatmysql'
    ])
    expect(jobs.map((j) => j.name)).toEqual(['Backup dev', 'Backup staging', 'backup prod'])
    for (const job of jobs) {
      expect(job.tasks).toHaveLength(15)
      expect(job.continueOnError).toBe(true)
      expect(job.alreadyImported).toBe(false)
      expect(
        job.tasks.every(
          (t) => t.type === 'backupschema' && t.schema && t.referenceName === `Backup ${t.schema}`
        )
      ).toBe(true)
    }
    expect(new Set(jobs[0].tasks.map((t) => t.server))).toEqual(new Set(['Dev']))
    expect(new Set(jobs[1].tasks.map((t) => t.server))).toEqual(new Set(['Staging']))
    expect(new Set(jobs[2].tasks.map((t) => t.server))).toEqual(new Set(['Production']))
  })

  it('flags jobs already imported by source file name', async () => {
    const existing = {
      source: { app: 'navicat', fileName: 'backup prod.nbatmysql', importedAt: 'x' }
    } as Job
    const jobs = await readNavicatJobs(FIXTURE_ROOT, [existing])
    expect(jobs.map((j) => j.alreadyImported)).toEqual([false, false, true])
  })

  it('skips a malformed profile with a warning instead of failing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'electrondb-jobs-'))
    try {
      const profiles = join(root, 'Navicat for MySQL', 'Profiles')
      cpSync(join(FIXTURE_ROOT, 'Navicat for MySQL', 'Profiles'), profiles, { recursive: true })
      writeFileSync(join(profiles, 'broken.nbatmysql'), '{"Jobs": [secret-ish content')
      const warnings: string[] = []
      const jobs = await readNavicatJobs(root, [], warnings)
      expect(jobs).toHaveLength(3)
      expect(warnings).toEqual(['El perfil "broken.nbatmysql" no es un JSON válido; se omitió'])
      expect(warnings[0]).not.toContain('secret')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns an empty list when the profiles dir is missing', async () => {
    expect(await readNavicatJobs('/nonexistent/navicat', [])).toEqual([])
  })
})

describe('parseBatchJob', () => {
  it('derives the name from the file name and tolerates missing sections', () => {
    expect(jobNameFromFile('Nightly.nbatmysql')).toBe('Nightly')
    expect(jobNameFromFile('weird.txt')).toBe('weird.txt')
    const parsed = parseBatchJob('x.nbatmysql', '{"Version":1.3}')
    expect(parsed).toEqual({ fileName: 'x.nbatmysql', name: 'x', continueOnError: true, tasks: [] })
    const noContinue = parseBatchJob(
      'y.nbatmysql',
      '{"General":{"ContinueOnError":false},"Jobs":[{"TypeName":"runquery","Server":"S","Schema":"db"}]}'
    )
    expect(noContinue.continueOnError).toBe(false)
    expect(noContinue.tasks).toEqual([
      { type: 'runquery', server: 'S', schema: 'db', referenceName: '' }
    ])
  })

  it('throws actionable errors on invalid content', () => {
    expect(() => parseBatchJob('bad.nbatmysql', '{')).toThrow(/bad\.nbatmysql/)
    expect(() => parseBatchJob('list.nbatmysql', '[]')).toThrow(/formato/)
  })
})
