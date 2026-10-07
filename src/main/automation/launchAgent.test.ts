import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'plist'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Job } from '@shared/types'
import {
  buildLaunchAgentPlist,
  installLaunchAgent,
  launchAgentLabel,
  launchAgentPath,
  launchAgentsDir,
  launchAgentStatus,
  LEGACY_LAUNCH_AGENT_PREFIX,
  LEGACY_LAUNCH_AGENT_PREFIXES,
  LAUNCH_AGENT_PREFIX,
  LEGACY_LAUNCH_AGENTS_NOTICE,
  removeLaunchAgent,
  removeLegacyLaunchAgents,
  supportsLaunchAgents,
  syncLaunchAgents,
  type ExecFileFn,
  type PlatformInfo
} from './launchAgent'
import { clearRaisedNotices, raisedNotices } from '../notices'
import { backupTask, jobInput, makeContext, silentLogger, type TestContext } from './testSupport'

interface ExecCall {
  file: string
  args: string[]
}

function stubExec(
  calls: ExecCall[],
  failing: (args: string[]) => boolean = () => false
): ExecFileFn {
  return async (file, args) => {
    calls.push({ file, args })
    if (failing(args)) throw new Error('launchctl failed')
    return { stdout: '', stderr: '' }
  }
}

describe('launchAgent', () => {
  let t: TestContext
  let platform: PlatformInfo
  let job: Job

  beforeEach(() => {
    t = makeContext()
    platform = {
      os: 'darwin',
      execPath: '/Applications/Vortaq.app/Contents/MacOS/Vortaq',
      appArgs: [],
      uid: 501,
      homeDir: join(t.dir, 'home')
    }
    job = t.ctx.jobs.save(
      jobInput('Nightly', [backupTask('t1', 'c1', 'shop')], {
        schedule: { enabled: true, cron: '30 2 * * 1-5', launchAgent: true }
      })
    )
  })
  afterEach(() => t.cleanup())

  it('builds a packaged-app plist that parses back', () => {
    const xml = buildLaunchAgentPlist(job, t.ctx, platform)
    const parsed = parse(xml) as Record<string, unknown>
    expect(parsed.Label).toBe(`dev.y0rshb3.vortaq.job.${job.id}`)
    expect(parsed.ProgramArguments).toEqual([platform.execPath, `--run-job=${job.id}`])
    expect(parsed.RunAtLoad).toBe(false)
    expect(parsed.StandardOutPath).toBe(
      join(t.ctx.logDir, 'launchd', `${launchAgentLabel(job.id)}.out.log`)
    )
    expect(parsed.StandardErrorPath).toBe(
      join(t.ctx.logDir, 'launchd', `${launchAgentLabel(job.id)}.err.log`)
    )
    const intervals = parsed.StartCalendarInterval as Record<string, number>[]
    expect(intervals).toHaveLength(5)
    expect(intervals[0]).toEqual({ Minute: 30, Hour: 2, Weekday: 1 })
    expect(intervals[4]).toEqual({ Minute: 30, Hour: 2, Weekday: 5 })
  })

  it('passes the app path in dev mode', () => {
    const dev: PlatformInfo = {
      ...platform,
      execPath: '/dev/electron',
      appArgs: ['/src/vortaq']
    }
    const parsed = parse(buildLaunchAgentPlist(job, t.ctx, dev)) as Record<string, unknown>
    expect(parsed.ProgramArguments).toEqual(['/dev/electron', '/src/vortaq', `--run-job=${job.id}`])
  })

  it('installs: writes the plist then runs bootout and bootstrap in order', async () => {
    const calls: ExecCall[] = []
    // bootout fails the first time (agent not loaded yet) and must be ignored
    await installLaunchAgent(job, t.ctx, {
      platform,
      execFile: stubExec(calls, (a) => a[0] === 'bootout'),
      log: silentLogger
    })
    const path = launchAgentPath(platform.homeDir, job.id)
    expect(existsSync(path)).toBe(true)
    expect(path.endsWith(`/Library/LaunchAgents/${launchAgentLabel(job.id)}.plist`)).toBe(true)
    expect(calls.map((c) => c.file)).toEqual(['launchctl', 'launchctl'])
    expect(calls[0].args).toEqual(['bootout', 'gui/501', path])
    expect(calls[1].args).toEqual(['bootstrap', 'gui/501', path])
    expect(launchAgentStatus(job.id, platform.homeDir, platform.os)).toBe(true)
    expect((parse(readFileSync(path, 'utf8')) as Record<string, unknown>).Label).toBe(
      launchAgentLabel(job.id)
    )
    expect(existsSync(join(t.ctx.logDir, 'launchd'))).toBe(true)
  })

  it('removes: bootout then deletes the plist; no-op when absent', async () => {
    const calls: ExecCall[] = []
    const deps = { platform, execFile: stubExec(calls), log: silentLogger }
    await installLaunchAgent(job, t.ctx, deps)
    calls.length = 0
    await removeLaunchAgent(job.id, deps)
    expect(calls.map((c) => c.args[0])).toEqual(['bootout'])
    expect(launchAgentStatus(job.id, platform.homeDir, platform.os)).toBe(false)
    calls.length = 0
    await removeLaunchAgent(job.id, deps)
    expect(calls).toHaveLength(0)
  })

  it('syncLaunchAgents reconciles installed agents with jobs', async () => {
    const calls: ExecCall[] = []
    const deps = { platform, execFile: stubExec(calls), log: silentLogger }
    const inApp = t.ctx.jobs.save(
      jobInput('In app only', [backupTask('t1', 'c1', 'shop')], {
        schedule: { enabled: true, cron: '0 1 * * *', launchAgent: false }
      })
    )
    await syncLaunchAgents(t.ctx, deps)
    expect(launchAgentStatus(job.id, platform.homeDir, platform.os)).toBe(true)
    expect(launchAgentStatus(inApp.id, platform.homeDir, platform.os)).toBe(false)

    // disable the job and delete the other one: both agents must disappear
    t.ctx.jobs.save({ ...job, schedule: { ...job.schedule, enabled: false } })
    const orphan = t.ctx.jobs.save({
      ...jobInput('Orphan', [], {
        schedule: { enabled: true, cron: '0 2 * * *', launchAgent: true }
      })
    })
    await syncLaunchAgents(t.ctx, deps)
    expect(launchAgentStatus(job.id, platform.homeDir, platform.os)).toBe(false)
    expect(launchAgentStatus(orphan.id, platform.homeDir, platform.os)).toBe(true)
    t.ctx.jobs.delete(orphan.id)
    await syncLaunchAgents(t.ctx, deps)
    expect(launchAgentStatus(orphan.id, platform.homeDir, platform.os)).toBe(false)
  })

  describe('legacy (pre-rename) agents', () => {
    const legacyPath = (id: string): string =>
      join(launchAgentsDir(platform.homeDir), `${LEGACY_LAUNCH_AGENT_PREFIX}${id}.plist`)

    it('removeLegacyLaunchAgents boots out and deletes only old-label plists of known jobs', async () => {
      mkdirSync(launchAgentsDir(platform.homeDir), { recursive: true })
      writeFileSync(legacyPath('a'), 'old')
      writeFileSync(legacyPath('b'), 'old')
      writeFileSync(legacyPath('stranger'), 'old')
      const unrelated = join(launchAgentsDir(platform.homeDir), 'com.example.agent.plist')
      writeFileSync(unrelated, 'keep')
      const calls: ExecCall[] = []
      const { removed, unknown } = await removeLegacyLaunchAgents(
        { platform, execFile: stubExec(calls), log: silentLogger },
        new Set(['a', 'b'])
      )
      expect(removed.sort()).toEqual(['a', 'b'])
      expect(unknown).toEqual(['stranger'])
      expect(existsSync(legacyPath('stranger'))).toBe(true)
      expect(existsSync(legacyPath('a'))).toBe(false)
      expect(existsSync(legacyPath('b'))).toBe(false)
      expect(existsSync(unrelated)).toBe(true)
      expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
        ['bootout', 'gui/501'],
        ['bootout', 'gui/501']
      ])
      expect(calls.map((c) => c.args[2]).sort()).toEqual([legacyPath('a'), legacyPath('b')].sort())
    })

    it('a full sync replaces an old-label agent with the new label', async () => {
      mkdirSync(launchAgentsDir(platform.homeDir), { recursive: true })
      writeFileSync(legacyPath(job.id), 'old')
      const calls: ExecCall[] = []
      await syncLaunchAgents(t.ctx, { platform, execFile: stubExec(calls), log: silentLogger })
      expect(existsSync(legacyPath(job.id))).toBe(false)
      expect(launchAgentStatus(job.id, platform.homeDir, platform.os)).toBe(true)
      expect(calls.map((c) => [c.args[0], c.args[2]])).toEqual([
        ['bootout', legacyPath(job.id)],
        ['bootout', launchAgentPath(platform.homeDir, job.id)],
        ['bootstrap', launchAgentPath(platform.homeDir, job.id)]
      ])
    })

    it('a full sync keeps old-label agents of jobs Vortaq does not have and raises a notice', async () => {
      clearRaisedNotices()
      mkdirSync(launchAgentsDir(platform.homeDir), { recursive: true })
      writeFileSync(legacyPath('not-migrated'), 'old')
      const calls: ExecCall[] = []
      await syncLaunchAgents(t.ctx, { platform, execFile: stubExec(calls), log: silentLogger })
      expect(existsSync(legacyPath('not-migrated'))).toBe(true)
      expect(calls.some((c) => c.args[2] === legacyPath('not-migrated'))).toBe(false)
      const notices = raisedNotices(t.ctx.userDataPath)
      expect(notices).toHaveLength(1)
      expect(notices[0].id).toBe(`${LEGACY_LAUNCH_AGENTS_NOTICE}:not-migrated`)
      expect(notices[0].message).toContain(`${LEGACY_LAUNCH_AGENT_PREFIX}not-migrated.plist`)
      clearRaisedNotices()
    })

    it('moves ElectronDB-label agents too, and both old labels of the same job', async () => {
      clearRaisedNotices()
      const electronDbPath = (id: string): string =>
        join(launchAgentsDir(platform.homeDir), `dev.y0rshb3.electrondb.job.${id}.plist`)
      expect(LEGACY_LAUNCH_AGENT_PREFIXES).toEqual([
        'dev.y0rshb3.electrondb.job.',
        'dev.y0rshb3.navidog.job.'
      ])
      expect(LAUNCH_AGENT_PREFIX).toBe('dev.y0rshb3.vortaq.job.')
      mkdirSync(launchAgentsDir(platform.homeDir), { recursive: true })
      writeFileSync(electronDbPath(job.id), 'old')
      writeFileSync(legacyPath(job.id), 'older')
      writeFileSync(electronDbPath('gone'), 'old')
      const calls: ExecCall[] = []
      await syncLaunchAgents(t.ctx, { platform, execFile: stubExec(calls), log: silentLogger })
      expect(existsSync(electronDbPath(job.id))).toBe(false)
      expect(existsSync(legacyPath(job.id))).toBe(false)
      expect(existsSync(electronDbPath('gone'))).toBe(true)
      expect(launchAgentStatus(job.id, platform.homeDir, platform.os)).toBe(true)
      expect(launchAgentPath(platform.homeDir, job.id)).toContain('dev.y0rshb3.vortaq.job.')
      const notices = raisedNotices(t.ctx.userDataPath)
      expect(notices.map((n) => n.id)).toEqual([`${LEGACY_LAUNCH_AGENTS_NOTICE}:gone`])
      expect(notices[0].message).toContain('dev.y0rshb3.electrondb.job.gone.plist')
      clearRaisedNotices()
    })

    it('deletes old-label plists even when bootout fails and never touches them off macOS', async () => {
      mkdirSync(launchAgentsDir(platform.homeDir), { recursive: true })
      writeFileSync(legacyPath('x'), 'old')
      // bootout failures are expected (agent not loaded) and do not prevent the delete
      await removeLegacyLaunchAgents(
        { platform, execFile: stubExec([], () => true), log: silentLogger },
        new Set(['x'])
      )
      expect(existsSync(legacyPath('x'))).toBe(false)
      writeFileSync(legacyPath('y'), 'old')
      const calls: ExecCall[] = []
      const { removed } = await removeLegacyLaunchAgents(
        { platform: { ...platform, os: 'linux' }, execFile: stubExec(calls), log: silentLogger },
        new Set(['y'])
      )
      expect(removed).toEqual([])
      expect(calls).toHaveLength(0)
      expect(existsSync(legacyPath('y'))).toBe(true)
    })
  })

  it('syncLaunchAgents never throws when launchctl fails', async () => {
    const deps = { platform, execFile: stubExec([], () => true), log: silentLogger }
    await expect(syncLaunchAgents(t.ctx, deps)).resolves.toBeUndefined()
  })

  for (const os of ['win32', 'linux'] as const) {
    describe(`on ${os}`, () => {
      it('is not supported', () => {
        expect(supportsLaunchAgents(os)).toBe(false)
        expect(supportsLaunchAgents('darwin')).toBe(true)
      })

      it('syncLaunchAgents writes nothing and never calls launchctl', async () => {
        const calls: ExecCall[] = []
        const other = { ...platform, os }
        await syncLaunchAgents(t.ctx, {
          platform: other,
          execFile: stubExec(calls),
          log: silentLogger
        })
        expect(calls).toHaveLength(0)
        expect(existsSync(launchAgentsDir(other.homeDir))).toBe(false)
        expect(launchAgentStatus(job.id, other.homeDir, os)).toBe(false)
      })

      it('installLaunchAgent refuses with an actionable message', async () => {
        const calls: ExecCall[] = []
        const other = { ...platform, os }
        await expect(
          installLaunchAgent(job, t.ctx, { platform: other, execFile: stubExec(calls) })
        ).rejects.toThrow(/solo está disponible en macOS.*--run-job/)
        expect(calls).toHaveLength(0)
        expect(existsSync(launchAgentsDir(other.homeDir))).toBe(false)
      })

      it('removeLaunchAgent and launchAgentStatus ignore stray plists', async () => {
        const calls: ExecCall[] = []
        const path = launchAgentPath(platform.homeDir, job.id)
        mkdirSync(launchAgentsDir(platform.homeDir), { recursive: true })
        writeFileSync(path, 'stray')
        expect(launchAgentStatus(job.id, platform.homeDir, os)).toBe(false)
        await removeLaunchAgent(job.id, {
          platform: { ...platform, os },
          execFile: stubExec(calls)
        })
        expect(calls).toHaveLength(0)
        expect(existsSync(path)).toBe(true)
      })
    })
  }
})
