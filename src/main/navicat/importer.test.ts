import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialStore, plainCodec } from '../credentials/store'
import { ConnectionsRepo, ENGINE_CHANGE_MESSAGE, JobsRepo, SettingsRepo } from '../storage/repos'
import { importFromNavicat, safeDirName, type ImportContext } from './importer'
import { FIXTURE_ROOT, MULTI_TYPE_CONN_PLIST } from './testing'

const ALL_CONNECTIONS = ['Dev', 'Home Lab', 'Production', 'Staging']
const ALL_JOBS = ['Backup dev.nbatmysql', 'Backup staging.nbatmysql', 'backup prod.nbatmysql']

describe('importFromNavicat', () => {
  let dir: string
  let ctx: ImportContext
  let credentials: CredentialStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-import-'))
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
    dir = mkdtempSync(join(tmpdir(), 'vortaq-import-'))
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

describe('importFromNavicat engine model', () => {
  let dir: string
  let ctx: ImportContext
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-import-'))
    const settings = new SettingsRepo(dir, dir)
    settings.update({ navicatRootPath: FIXTURE_ROOT, backupsRootDir: join(dir, 'backups') })
    ctx = { connections: new ConnectionsRepo(dir), jobs: new JobsRepo(dir), settings }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('imports MySQL sections as engine mysql', async () => {
    const result = await importFromNavicat(ctx, { connections: ['Dev'], jobs: [] })
    expect(result.connections[0].engine).toBe('mysql')
    expect(new ConnectionsRepo(dir).get(result.connections[0].id)?.engine).toBe('mysql')
  })

  it('never turns a record of another engine into MySQL on re-import', async () => {
    const first = await importFromNavicat(ctx, { connections: ['Dev'], jobs: [] })
    const dev = first.connections[0]
    // A record with the same Navicat identity but another engine (written by a later phase).
    const { engine: _engine, ...rest } = dev
    ctx.connections.delete(dev.id)
    const other = ctx.connections.save({ ...rest, engine: 'postgresql', host: 'pg.local' })
    expect(other.id).toBe(dev.id)

    await expect(importFromNavicat(ctx, { connections: ['Dev'], jobs: [] })).rejects.toThrow(
      ENGINE_CHANGE_MESSAGE
    )
    expect(ctx.connections.get(dev.id)).toMatchObject({ engine: 'postgresql', host: 'pg.local' })
  })
  it('never resolves a batch-job server to a connection of another engine', async () => {
    // Same display name as the job's Navicat server, but PostgreSQL: jobs stay MySQL-only.
    const first = await importFromNavicat(ctx, { connections: ['Production'], jobs: [] })
    const { engine: _engine, id: _id, ...rest } = first.connections[0]
    ctx.connections.delete(first.connections[0].id)
    ctx.connections.save({ ...rest, source: undefined, engine: 'postgresql' })
    const result = await importFromNavicat(ctx, {
      connections: [],
      jobs: ['backup prod.nbatmysql']
    })
    expect(result.jobs[0].tasks).toEqual([])
    expect(result.warnings[0]).toMatch(/"Production"/)
  })
})

describe('importFromNavicat: MariaDB and PostgreSQL sections (P5)', () => {
  let dir: string
  let root: string
  let ctx: ImportContext

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-import-multi-'))
    root = join(dir, 'Navicat CC')
    mkdirSync(join(root, 'Common'), { recursive: true })
    writeFileSync(join(root, 'Common', 'conn.plist'), MULTI_TYPE_CONN_PLIST)
    const settings = new SettingsRepo(dir, dir)
    settings.update({ navicatRootPath: root, backupsRootDir: join(dir, 'backups') })
    ctx = { connections: new ConnectionsRepo(dir), jobs: new JobsRepo(dir), settings }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const keys = ['Shared name', 'MariaDB\u001fShared name', 'PostgreSQL\u001fPG local']

  it('creates one connection per section, with the section kept for identity', async () => {
    const result = await importFromNavicat(ctx, { connections: keys, jobs: [] })
    // PostgreSQL is a preview engine: refused (with the reason) while previews are off.
    expect(result.connections.map((c) => `${c.engine}:${c.name}`)).toEqual([
      'mysql:Shared name',
      'mariadb:Shared name'
    ])
    expect(result.warnings).toEqual([
      'La conexión "PG local" no se ha importado: PostgreSQL está en vista previa: actívalo en Ajustes › Motores en vista previa'
    ])
    const [mysql, maria] = result.connections
    expect(mysql.source?.navicatType).toBeUndefined()
    expect(maria.source).toMatchObject({
      app: 'navicat',
      name: 'Shared name',
      navicatType: 'MariaDB'
    })
    expect(maria).toMatchObject({ host: 'maria.example.test', port: 3307 })

    // Re-import updates in place, per section.
    const again = await importFromNavicat(ctx, { connections: keys.slice(0, 2), jobs: [] })
    expect(again.connections.map((c) => c.id)).toEqual([mysql.id, maria.id])
    expect(ctx.connections.list()).toHaveLength(2)
  })

  it('imports PostgreSQL with previews on, and never an unsupported fork', async () => {
    ctx.settings.update({ previewEngines: true })
    const result = await importFromNavicat(ctx, {
      connections: [
        'PostgreSQL\u001fPG local',
        'PostgreSQL\u001fPG cluster',
        'PostgreSQL\u001fWarehouse'
      ],
      jobs: []
    })
    expect(result.connections.map((c) => c.name)).toEqual(['PG local', 'PG cluster'])
    const pg = result.connections[0]
    expect(pg).toMatchObject({
      engine: 'postgresql',
      port: 55432,
      customDatabases: ['shop'],
      ssl: { mode: 'verify-full', caCertPath: '/certs/root.crt' },
      postgres: { initialDatabase: 'shop', showSystemSchemas: false },
      source: { navicatType: 'PostgreSQL' }
    })
    expect(result.warnings).toContain(
      '«PG cluster»: Varios servidores: solo se usa el primero (pg1.example.test)'
    )
    expect(result.warnings.some((w) => w.includes('"Warehouse" no se ha importado'))).toBe(true)
  })

  it('a MySQL-section record promoted to MariaDB keeps matching and stays MariaDB', async () => {
    const [first] = (await importFromNavicat(ctx, { connections: ['Shared name'], jobs: [] }))
      .connections
    expect(ctx.connections.promoteToMariaDb(first.id)?.engine).toBe('mariadb')
    const [again] = (await importFromNavicat(ctx, { connections: ['Shared name'], jobs: [] }))
      .connections
    expect(again).toMatchObject({ id: first.id, engine: 'mariadb' })
  })
})
