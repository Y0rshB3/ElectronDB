import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialStore, plainCodec } from '../credentials/store'
import { ConnectionsRepo, JobsRepo, SettingsRepo } from '../storage/repos'
import { importFromNavicat, safeDirName, type ImportContext } from './importer'
import { FIXTURE_ROOT } from './testing'

const ALL_CONNECTIONS = ['Dev', 'Home Lab', 'Production', 'Staging']
const ALL_JOBS = ['Backup dev.nbatmysql', 'Backup staging.nbatmysql', 'backup prod.nbatmysql']

describe('importFromNavicat', () => {
  let dir: string
  let ctx: ImportContext
  let credentials: CredentialStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'electrondb-import-'))
    const settings = new SettingsRepo(dir, dir)
    settings.update({ navicatRootPath: FIXTURE_ROOT, backupsRootDir: join(dir, 'backups') })
    credentials = new CredentialStore(dir, plainCodec, 'plain')
    ctx = { connections: new ConnectionsRepo(dir), jobs: new JobsRepo(dir), settings }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('imports connections and jobs idempotently, resolving task connections', async () => {
    const first = await importFromNavicat(ctx, { connections: ALL_CONNECTIONS, jobs: ALL_JOBS })
    expect(first.warnings).toEqual([])
    expect(first.connections.map((c) => c.name).sort()).toEqual(ALL_CONNECTIONS)
    expect(first.jobs.map((j) => j.name).sort()).toEqual([
      'Backup dev',
      'Backup staging',
      'backup prod'
    ])

    const local = first.connections.find((c) => c.name === 'Dev')!
    expect(local).toMatchObject({
      host: '127.0.0.1',
      port: 13306,
      username: 'root',
      environment: 'local',
      // Navicat never says whether a password is needed: assume one.
      authMode: 'password',
      savePassword: true,
      color: null,
      backupDir: join(dir, 'backups', 'Dev'),
      extraBackupDirs: []
    })
    expect(local.source).toMatchObject({ app: 'navicat', name: 'Dev' })
    const lab = first.connections.find((c) => c.name === 'Home Lab')!
    expect(lab.ssh).toMatchObject({
      enabled: true,
      authType: 'key',
      port: 2200,
      privateKeyPath: '/Users/tester/.ssh/id_ed25519'
    })
    expect(lab.backupDir).toBe(join(dir, 'backups', 'Home Lab'))

    const localJob = first.jobs.find((j) => j.name === 'Backup dev')!
    expect(localJob.tasks).toHaveLength(15)
    expect(
      localJob.tasks.every(
        (t) => t.type === 'backupschema' && t.connectionId === local.id && t.includeData === true
      )
    ).toBe(true)
    expect(localJob.schedule).toEqual({ enabled: false, cron: '0 3 * * *', launchAgent: false })
    expect(localJob.continueOnError).toBe(true)
    expect(localJob.source).toMatchObject({ app: 'navicat', fileName: 'Backup dev.nbatmysql' })
    const staging = first.connections.find((c) => c.name === 'Staging')!
    expect(
      first.jobs
        .find((j) => j.name === 'Backup staging')!
        .tasks.every((t) => t.connectionId === staging.id)
    ).toBe(true)

    // A stored password survives re-import because the record keeps its id.
    credentials.set('mysql', local.id, 's3cret')

    const second = await importFromNavicat(ctx, { connections: ALL_CONNECTIONS, jobs: ALL_JOBS })
    expect(second.warnings).toEqual([])
    expect(ctx.connections.list()).toHaveLength(4)
    expect(ctx.jobs.list()).toHaveLength(3)
    expect(second.connections.find((c) => c.name === 'Dev')?.id).toBe(local.id)
    expect(second.connections.find((c) => c.name === 'Dev')?.createdAt).toBe(local.createdAt)
    const localJobAgain = second.jobs.find((j) => j.name === 'Backup dev')!
    expect(localJobAgain.id).toBe(localJob.id)
    expect(localJobAgain.tasks.map((t) => t.id)).toEqual(localJob.tasks.map((t) => t.id))
    expect(credentials.get('mysql', local.id)).toBe('s3cret')

    // Persisted: a fresh repo instance sees the same records.
    expect(new ConnectionsRepo(dir).list().map((c) => c.name)).toEqual(ALL_CONNECTIONS)
    expect(new JobsRepo(dir).list()).toHaveLength(3)
  })

  it('warns and skips tasks whose server has not been imported', async () => {
    const result = await importFromNavicat(ctx, {
      connections: ['Dev'],
      jobs: ['backup prod.nbatmysql']
    })
    expect(result.connections).toHaveLength(1)
    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0].tasks).toEqual([])
    expect(result.warnings).toHaveLength(15)
    expect(result.warnings[0]).toMatch(/"Production"/)
    expect(result.warnings[0]).toMatch(/backup prod/)
  })

  it('resolves servers against connections imported in earlier runs', async () => {
    await importFromNavicat(ctx, { connections: ['Production'], jobs: [] })
    const result = await importFromNavicat(ctx, {
      connections: [],
      jobs: ['backup prod.nbatmysql']
    })
    expect(result.warnings).toEqual([])
    const production = ctx.connections.list().find((c) => c.name === 'Production')!
    expect(result.jobs[0].tasks).toHaveLength(15)
    expect(result.jobs[0].tasks.every((t) => t.connectionId === production.id)).toBe(true)
  })

  it('warns about unknown selections and ignores malformed requests', async () => {
    const result = await importFromNavicat(ctx, { connections: ['Nope'], jobs: ['nope.nbatmysql'] })
    expect(result.connections).toEqual([])
    expect(result.jobs).toEqual([])
    expect(result.warnings).toHaveLength(2)
    const empty = await importFromNavicat(ctx, {} as never)
    expect(empty).toEqual({ connections: [], jobs: [], warnings: [] })
  })

  it('keeps a renamed connection and its backupDir on re-import', async () => {
    const first = await importFromNavicat(ctx, { connections: ['Dev'], jobs: [] })
    const local = first.connections[0]
    ctx.connections.save({ ...local, name: 'Docker MySQL', backupDir: '/custom/dir' })
    const second = await importFromNavicat(ctx, { connections: ['Dev'], jobs: [] })
    expect(second.connections[0]).toMatchObject({
      id: local.id,
      name: 'Docker MySQL',
      backupDir: '/custom/dir',
      host: '127.0.0.1'
    })
    expect(ctx.connections.list()).toHaveLength(1)
  })

  it("keeps a user's «Sin contraseña» choice on re-import", async () => {
    const first = await importFromNavicat(ctx, { connections: ['Dev'], jobs: [] })
    ctx.connections.save({ ...first.connections[0], authMode: 'none' })
    const second = await importFromNavicat(ctx, { connections: ['Dev'], jobs: [] })
    expect(second.connections[0].authMode).toBe('none')
  })
})

describe('importFromNavicat re-import safety', () => {
  let dir: string
  let ctx: ImportContext
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'electrondb-import-'))
    const settings = new SettingsRepo(dir, dir)
    settings.update({ navicatRootPath: FIXTURE_ROOT, backupsRootDir: join(dir, 'backups') })
    ctx = { connections: new ConnectionsRepo(dir), jobs: new JobsRepo(dir), settings }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('maps Production to production and never downgrades a production flag', async () => {
    const first = await importFromNavicat(ctx, { connections: ['Production', 'Dev'], jobs: [] })
    expect(first.connections.find((c) => c.name === 'Production')?.environment).toBe('production')
    const local = first.connections.find((c) => c.name === 'Dev')!
    ctx.connections.save({ ...local, environment: 'production', extraBackupDirs: ['/my/extra'] })
    const second = await importFromNavicat(ctx, { connections: ['Dev'], jobs: [] })
    expect(second.connections[0]).toMatchObject({
      environment: 'production',
      extraBackupDirs: ['/my/extra']
    })
  })

  it('does not write into the Navicat folder', async () => {
    const { readdirSync, statSync } = await import('node:fs')
    const snapshot = (root: string): string[] =>
      readdirSync(root, { recursive: true, withFileTypes: false } as never).map(
        (p) => `${String(p)}:${statSync(join(root, String(p))).mtimeMs}`
      )
    const before = snapshot(FIXTURE_ROOT)
    await importFromNavicat(ctx, { connections: ALL_CONNECTIONS, jobs: ALL_JOBS })
    expect(snapshot(FIXTURE_ROOT)).toEqual(before)
  })
})

describe('safeDirName', () => {
  it('replaces path-hostile characters', () => {
    expect(safeDirName('Home Lab')).toBe('Home Lab')
    expect(safeDirName('a/b:c*d?e"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i')
    expect(safeDirName('..hidden')).toBe('hidden')
    expect(safeDirName('   ')).toBe('connection')
  })
})
