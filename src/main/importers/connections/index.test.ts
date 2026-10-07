import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ENGINES } from '@shared/engines'
import { CredentialStore, plainCodec } from '../../credentials/store'
import { importFromNavicat } from '../../navicat/importer'
import { FIXTURE_ROOT } from '../../navicat/testing'
import { ConnectionsRepo, JobsRepo, SettingsRepo } from '../../storage/repos'
import { encryptNcxAes } from '../navicat/ncxCipher'
import { importConnectionFile, previewConnectionFile, type ConnectionImportContext } from './index'
import { IMPORT_FIXTURES } from './testing'
import { previewEngineReason } from './util'

const DBEAVER = join(IMPORT_FIXTURES, 'dbeaver', 'data-sources.json')
const WORKBENCH = join(IMPORT_FIXTURES, 'workbench', 'connections.xml')

describe('connection file import', () => {
  let dir: string
  let ctx: ConnectionImportContext
  let credentials: CredentialStore
  let settings: SettingsRepo
  // PostgreSQL ships its driver in this phase; pin the flag so these tests do not depend on it.
  const pg = ENGINES.postgresql as { available: boolean }
  let pgAvailable: boolean

  beforeEach(() => {
    pgAvailable = pg.available
    pg.available = true
    dir = mkdtempSync(join(tmpdir(), 'vortaq-conn-import-'))
    settings = new SettingsRepo(dir, dir)
    settings.update({ navicatRootPath: FIXTURE_ROOT, backupsRootDir: join(dir, 'backups') })
    credentials = new CredentialStore(dir, plainCodec, 'plain')
    ctx = { connections: new ConnectionsRepo(dir), credentials, settings }
  })
  afterEach(() => {
    pg.available = pgAvailable
    rmSync(dir, { recursive: true, force: true })
  })

  function writeNcx(body: string, ver = '1.5'): string {
    const path = join(dir, 'export.ncx')
    writeFileSync(
      path,
      `<?xml version="1.0" encoding="UTF-8"?>\n<Connections Ver="${ver}">${body}</Connections>`
    )
    return path
  }

  it('previews a DBeaver file and imports its MySQL connections without passwords', async () => {
    const preview = await previewConnectionFile(ctx, 'dbeaver', DBEAVER)
    expect(preview.containsPasswords).toBe(false)
    expect(preview.items).toHaveLength(5)
    expect(preview.items.every((i) => i.existingConnectionId === null && !i.hasPassword)).toBe(true)
    const keys = preview.items.map((i) => i.key)

    const result = await importConnectionFile(ctx, {
      source: 'dbeaver',
      path: DBEAVER,
      keys,
      existingMode: 'replace'
    })
    expect(result.created.map((c) => c.name).sort()).toEqual([
      'Local MySQL',
      'Maria staging',
      'Shop production'
    ])
    expect(result.updated).toEqual([])
    expect(result.passwordsSaved).toBe(0)
    expect(result.warnings).toEqual([
      `«Warehouse» no se ha importado: ${previewEngineReason('PostgreSQL')}`,
      '«Local notes» no se ha importado: Motor no soportado en esta versión: SQLite'
    ])
    const prod = result.created.find((c) => c.name === 'Shop production')!
    expect(prod).toMatchObject({
      engine: 'mysql',
      environment: 'production',
      savePassword: false,
      authMode: 'password',
      backupDir: join(dir, 'backups', 'Shop production'),
      extraBackupDirs: [],
      customDatabases: [],
      source: { app: 'dbeaver', name: 'Shop production', format: 'json' }
    })
    expect(credentials.has('mysql', prod.id)).toBe(false)

    // Preview again: the imported ones are recognised.
    const again = await previewConnectionFile(ctx, 'dbeaver', DBEAVER)
    expect(again.items.find((i) => i.name === 'Shop production')!.existingConnectionId).toBe(
      prod.id
    )
  })

  it('re-import with replace keeps id, backup folder and a production environment', async () => {
    const first = await importConnectionFile(ctx, {
      source: 'workbench',
      path: WORKBENCH,
      keys: ['2F6A1C3E-0B1D-4E5F-9A7B-1C2D3E4F5A6B'],
      existingMode: 'replace'
    })
    const local = first.created[0]
    expect(local).toMatchObject({
      name: 'Local instance 3306',
      environment: 'local',
      source: { app: 'workbench', format: 'xml' }
    })
    ctx.connections.save({
      ...local,
      environment: 'production',
      name: 'Renamed',
      backupDir: '/custom'
    })
    credentials.set('mysql', local.id, 'typed-by-user')

    const second = await importConnectionFile(ctx, {
      source: 'workbench',
      path: WORKBENCH,
      keys: ['2F6A1C3E-0B1D-4E5F-9A7B-1C2D3E4F5A6B'],
      existingMode: 'replace'
    })
    expect(second.created).toEqual([])
    expect(second.updated[0]).toMatchObject({
      id: local.id,
      name: 'Renamed',
      environment: 'production',
      backupDir: '/custom'
    })
    expect(credentials.get('mysql', local.id)).toBe('typed-by-user')
    expect(ctx.connections.list()).toHaveLength(1)
  })

  it('imports .ncx passwords into CredentialStore and never returns them', async () => {
    const path = writeNcx(
      `<Connection ConnectionName="Shop" ConnType="MYSQL" Host="db.example.test" UserName="shop" Password="${encryptNcxAes('pw-1')}"
        SSH="true" SSH_Host="b.example.test" SSH_UserName="ops" SSH_Password="${encryptNcxAes('ssh-1')}"/>
       <Connection ConnectionName="NoPass" ConnType="MYSQL" Host="h"/>`
    )
    const preview = await previewConnectionFile(ctx, 'navicat-ncx', path)
    expect(preview.containsPasswords).toBe(true)
    expect(preview.items.map((i) => i.hasPassword)).toEqual([true, false])
    expect(JSON.stringify(preview)).not.toMatch(/pw-1|ssh-1/)

    const result = await importConnectionFile(ctx, {
      source: 'navicat-ncx',
      path,
      keys: preview.items.map((i) => i.key),
      existingMode: 'passwords'
    })
    expect(JSON.stringify(result)).not.toMatch(/pw-1|ssh-1/)
    expect(result.passwordsSaved).toBe(1)
    const shop = result.created.find((c) => c.name === 'Shop')!
    expect(shop).toMatchObject({
      savePassword: true,
      ssh: { enabled: true, savePassword: true },
      source: { app: 'navicat', name: 'Shop', format: 'ncx', navicatType: 'MySQL' }
    })
    expect(credentials.get('mysql', shop.id)).toBe('pw-1')
    expect(credentials.get('ssh', shop.id)).toBe('ssh-1')
    const nopass = result.created.find((c) => c.name === 'NoPass')!
    expect(nopass.savePassword).toBe(false)
  })

  it('merges .ncx passwords into connections imported from the Navicat folder (passwords only)', async () => {
    const plist = await importFromNavicat(
      { ...ctx, jobs: new JobsRepo(dir) },
      { connections: ['Staging'], jobs: [] }
    )
    const staging = plist.connections[0]
    ctx.connections.save({ ...staging, environment: 'production', customDatabases: ['keep_me'] })

    const path = writeNcx(
      `<Connection ConnectionName="Staging" ConnType="MYSQL" Host="other.example.test" Port="4000" UserName="x" Password="${encryptNcxAes('from-ncx')}"/>`
    )
    const preview = await previewConnectionFile(ctx, 'navicat-ncx', path)
    expect(preview.items[0].existingConnectionId).toBe(staging.id)

    const result = await importConnectionFile(ctx, {
      source: 'navicat-ncx',
      path,
      keys: [preview.items[0].key],
      existingMode: 'passwords'
    })
    expect(result.created).toEqual([])
    expect(result.passwordsSaved).toBe(1)
    const after = ctx.connections.get(staging.id)!
    expect(after).toMatchObject({
      host: staging.host,
      port: staging.port,
      username: staging.username,
      environment: 'production',
      customDatabases: ['keep_me'],
      savePassword: true,
      source: { app: 'navicat', name: 'Staging' }
    })
    expect(after.source!.format).toBeUndefined()
    expect(credentials.get('mysql', staging.id)).toBe('from-ncx')

    // The plist import still finds the same record afterwards.
    const again = await importFromNavicat(
      { ...ctx, jobs: new JobsRepo(dir) },
      { connections: ['Staging'], jobs: [] }
    )
    expect(again.connections[0].id).toBe(staging.id)
    expect(ctx.connections.list()).toHaveLength(1)
  })

  it('replace mode overwrites the data of an existing Navicat connection but keeps its secrets', async () => {
    const path = writeNcx(
      `<Connection ConnectionName="A" ConnType="MYSQL" Host="h1" UserName="u"/>`
    )
    const preview = await previewConnectionFile(ctx, 'navicat-ncx', path)
    const first = await importConnectionFile(ctx, {
      source: 'navicat-ncx',
      path,
      keys: [preview.items[0].key],
      existingMode: 'replace'
    })
    const id = first.created[0].id
    credentials.set('mysql', id, 'typed')
    writeNcx(`<Connection ConnectionName="A" ConnType="MYSQL" Host="h2" UserName="u2"/>`)
    const second = await importConnectionFile(ctx, {
      source: 'navicat-ncx',
      path,
      keys: [preview.items[0].key],
      existingMode: 'replace'
    })
    expect(second.updated[0]).toMatchObject({ id, host: 'h2', username: 'u2' })
    expect(credentials.get('mysql', id)).toBe('typed')

    // passwords mode with a file without passwords leaves it alone, with a warning.
    const third = await importConnectionFile(ctx, {
      source: 'navicat-ncx',
      path,
      keys: [preview.items[0].key],
      existingMode: 'passwords'
    })
    expect(third.updated).toEqual([])
    expect(third.warnings[0]).toContain('no trae contraseñas')
  })

  it('a MariaDB .ncx connection does not merge into a MySQL one with the same name', async () => {
    const path = writeNcx(
      `<Connection ConnectionName="Same" ConnType="MYSQL" Host="h"/><Connection ConnectionName="Same" ConnType="MARIADB" Host="m"/>`
    )
    const preview = await previewConnectionFile(ctx, 'navicat-ncx', path)
    const result = await importConnectionFile(ctx, {
      source: 'navicat-ncx',
      path,
      keys: preview.items.map((i) => i.key),
      existingMode: 'replace'
    })
    expect(result.created.map((c) => c.source?.navicatType).sort()).toEqual(['MariaDB', 'MySQL'])
    expect(result.created.every((c) => c.engine === 'mysql')).toBe(true)
  })

  it('validates the request and reports keys missing from the file', async () => {
    await expect(
      importConnectionFile(ctx, {
        source: 'dbeaver',
        path: DBEAVER,
        keys: [],
        existingMode: 'replace'
      })
    ).rejects.toThrow('Elige al menos una conexión')
    await expect(
      importConnectionFile(ctx, {
        source: 'dbeaver',
        path: DBEAVER,
        keys: ['x'],
        existingMode: 'bogus' as 'replace'
      })
    ).rejects.toThrow('Modo no válido')
    await expect(previewConnectionFile(ctx, 'sql-dump', DBEAVER)).rejects.toThrow(
      'no contiene conexiones'
    )
    await expect(previewConnectionFile(ctx, 'dbeaver', join(dir, 'missing.json'))).rejects.toThrow(
      'No se encontró el archivo'
    )
    const r = await importConnectionFile(ctx, {
      source: 'dbeaver',
      path: DBEAVER,
      keys: ['gone'],
      existingMode: 'replace'
    })
    expect(r.warnings).toEqual(['La conexión «gone» ya no está en el archivo'])
  })
})

describe('PostgreSQL connection import', () => {
  let dir: string
  let ctx: ConnectionImportContext
  let credentials: CredentialStore
  let settings: SettingsRepo
  const pg = ENGINES.postgresql as { available: boolean }
  let pgAvailable: boolean

  beforeEach(() => {
    pgAvailable = pg.available
    pg.available = true
    dir = mkdtempSync(join(tmpdir(), 'vortaq-pg-import-'))
    settings = new SettingsRepo(dir, dir)
    settings.update({ backupsRootDir: join(dir, 'backups') })
    credentials = new CredentialStore(dir, plainCodec, 'plain')
    ctx = { connections: new ConnectionsRepo(dir), credentials, settings }
  })
  afterEach(() => {
    pg.available = pgAvailable
    rmSync(dir, { recursive: true, force: true })
  })

  function writeNcx(body: string): string {
    const path = join(dir, 'pg.ncx')
    writeFileSync(
      path,
      `<?xml version="1.0" encoding="UTF-8"?>\n<Connections Ver="1.5">${body}</Connections>`
    )
    return path
  }

  const LEDGER = `<Connection ConnectionName="Ledger" ConnType="POSTGRESQL" Host="ledger.example.test" UserName="ledger"
      Password="${encryptNcxAes('pg-secret')}" InitialDatabase="ledger_db" SSL="true" SSL_Mode="verify-full" />`

  it('lists PostgreSQL rows as disabled while previews are off, and main refuses them', async () => {
    const path = writeNcx(LEDGER)
    const preview = await previewConnectionFile(ctx, 'navicat-ncx', path)
    expect(preview.items[0]).toMatchObject({
      engine: 'postgresql',
      unsupportedReason: previewEngineReason('PostgreSQL')
    })
    const result = await importConnectionFile(ctx, {
      source: 'navicat-ncx',
      path,
      keys: ['PostgreSQL:Ledger'],
      existingMode: 'replace'
    })
    expect(result.created).toEqual([])
    expect(result.warnings).toEqual([
      `«Ledger» no se ha importado: ${previewEngineReason('PostgreSQL')}`
    ])
    expect(ctx.connections.list()).toEqual([])
  })

  it('imports a PostgreSQL connection with previews on; re-import keeps engine and options', async () => {
    settings.update({ previewEngines: true })
    const path = writeNcx(LEDGER)
    const preview = await previewConnectionFile(ctx, 'navicat-ncx', path)
    expect(preview.items[0].unsupportedReason).toBeNull()
    expect(JSON.stringify(preview)).not.toContain('pg-secret')

    const first = await importConnectionFile(ctx, {
      source: 'navicat-ncx',
      path,
      keys: ['PostgreSQL:Ledger'],
      existingMode: 'replace'
    })
    const created = first.created[0]
    expect(created).toMatchObject({
      engine: 'postgresql',
      host: 'ledger.example.test',
      port: 5432,
      username: 'ledger',
      ssl: { enabled: true, verifyServer: true, mode: 'verify-full' },
      postgres: {
        initialDatabase: 'ledger_db',
        showSystemSchemas: false,
        timeZone: '',
        searchPath: ''
      },
      source: { app: 'navicat', name: 'Ledger', navicatType: 'PostgreSQL', format: 'ncx' }
    })
    expect(credentials.get('mysql', created.id)).toBe('pg-secret')
    expect(first.passwordsSaved).toBe(1)

    // The user tunes the connection; a re-import (replace) keeps engine, id and their options.
    ctx.connections.save({
      ...created,
      postgres: { ...created.postgres!, searchPath: 'app, public', timeZone: 'UTC' }
    })
    const second = await importConnectionFile(ctx, {
      source: 'navicat-ncx',
      path,
      keys: ['PostgreSQL:Ledger'],
      existingMode: 'replace'
    })
    expect(second.created).toEqual([])
    expect(second.updated[0]).toMatchObject({
      id: created.id,
      engine: 'postgresql',
      postgres: { initialDatabase: 'ledger_db', searchPath: 'app, public', timeZone: 'UTC' }
    })
    expect(ctx.connections.list()).toHaveLength(1)
  })

  it('imports DBeaver PostgreSQL entries with previews on', async () => {
    settings.update({ previewEngines: true })
    const result = await importConnectionFile(ctx, {
      source: 'dbeaver',
      path: DBEAVER,
      keys: ['postgres-jdbc-18a2b3c4d61-4c5d6e7f8091a2b3'],
      existingMode: 'replace'
    })
    expect(result.warnings).toEqual([])
    expect(result.created[0]).toMatchObject({
      name: 'Warehouse',
      engine: 'postgresql',
      port: 5432,
      postgres: { initialDatabase: 'warehouse' },
      source: { app: 'dbeaver', format: 'json' }
    })
  })
})
