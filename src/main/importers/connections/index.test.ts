import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
import { SQLITE_ENCRYPTED_REASON, sqliteFileReviewWarning } from './types'

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
      'Local notes',
      'Maria staging',
      'Shop production',
      'Warehouse'
    ])
    expect(result.updated).toEqual([])
    expect(result.passwordsSaved).toBe(0)
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
    expect(result.created.map((c) => c.engine).sort()).toEqual(['mariadb', 'mysql'])
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

  it('imports a PostgreSQL connection; re-import keeps engine and options', async () => {
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

  describe('SQLite entries', () => {
    const ncxEntry = (name: string, file: string, extra = ''): string =>
      `<Connection ConnectionName="${name}" ConnType="SQLITE" DatabaseFileName="${file}" ${extra}/>`

    it('imports an .ncx SQLite file: no password, FKs off, path kept', async () => {
      const db = join(dir, 'app.db')
      writeFileSync(db, '')
      const missing = join(dir, 'gone.db')
      const path = writeNcx(
        ncxEntry('Notes', db) +
          ncxEntry('Gone', missing) +
          ncxEntry('Windows', 'C:\\data\\x.db') +
          ncxEntry('Locked', db, 'SQLiteEncrypt="true" SQLiteEncryptPassword="ABCDEF"')
      )
      const preview = await previewConnectionFile(ctx, 'navicat-ncx', path, 'darwin')
      const byName = new Map(preview.items.map((i) => [i.name, i]))
      expect(byName.get('Notes')).toMatchObject({ unsupportedReason: null, warnings: [] })
      expect(byName.get('Gone')!.warnings).toEqual([sqliteFileReviewWarning('Gone')])
      expect(byName.get('Windows')!.warnings).toEqual([sqliteFileReviewWarning('Windows')])
      expect(byName.get('Locked')!.unsupportedReason).toBe(SQLITE_ENCRYPTED_REASON)
      expect(preview.containsPasswords).toBe(false)
      // Warnings name the connection, never the path.
      expect(JSON.stringify(preview.items.map((i) => i.warnings))).not.toContain(dir)

      const result = await importConnectionFile(
        ctx,
        {
          source: 'navicat-ncx',
          path,
          keys: ['SQLite:Notes', 'SQLite:Gone', 'SQLite:Windows', 'SQLite:Locked'],
          existingMode: 'replace'
        },
        'darwin'
      )
      expect(result.warnings).toEqual([`«Locked» no se ha importado: ${SQLITE_ENCRYPTED_REASON}`])
      const created = new Map(result.created.map((c) => [c.name, c]))
      expect(created.get('Notes')).toMatchObject({
        engine: 'sqlite',
        host: '',
        port: 0,
        username: '',
        authMode: 'none',
        savePassword: false,
        sqlite: { filePath: db, foreignKeys: false, readOnly: false, attached: [] },
        source: { app: 'navicat', name: 'Notes', navicatType: 'SQLite', format: 'ncx' }
      })
      expect(created.get('Notes')!.sqlite!.pathNeedsReview).toBeUndefined()
      expect(created.get('Gone')!.sqlite).toMatchObject({
        filePath: missing,
        pathNeedsReview: true
      })
      expect(created.get('Windows')!.sqlite).toMatchObject({
        filePath: 'C:\\data\\x.db',
        pathNeedsReview: true
      })
      expect(credentials.has('mysql', created.get('Notes')!.id)).toBe(false)
      // Nothing was created on disk for the missing file.
      expect(existsSync(missing)).toBe(false)
      expect(readdirSync(dir).filter((f) => f.endsWith('.db'))).toEqual(['app.db'])
    })

    it('a production SQLite import opens read-only by default', async () => {
      const db = join(dir, 'prod.db')
      writeFileSync(db, '')
      const path = writeNcx(ncxEntry('Shop production', db))
      const result = await importConnectionFile(ctx, {
        source: 'navicat-ncx',
        path,
        keys: ['SQLite:Shop production'],
        existingMode: 'replace'
      })
      expect(result.created[0]).toMatchObject({
        environment: 'production',
        sqlite: { readOnly: true, foreignKeys: false }
      })
    })

    it('imports DBeaver SQLite entries; existence check is injected', async () => {
      const result = await importConnectionFile(
        ctx,
        {
          source: 'dbeaver',
          path: DBEAVER,
          keys: ['sqlite_jdbc-18a2b3c4d62-5d6e7f8091a2b3c4'],
          existingMode: 'replace'
        },
        'linux',
        (p) => p === '/home/tester/notes.db'
      )
      expect(result.warnings).toEqual([])
      expect(result.created[0]).toMatchObject({
        name: 'Local notes',
        engine: 'sqlite',
        authMode: 'none',
        sqlite: { filePath: '/home/tester/notes.db', foreignKeys: false }
      })
      expect(result.created[0].sqlite!.pathNeedsReview).toBeUndefined()
    })
  })

  it('imports .ncx MongoDB connections with previews on: options and password kept', async () => {
    const path = writeNcx(
      `<Connection ConnectionName="Mongo RS" ConnType="MONGODB" Host="localhost" ConnMethod="ReplicaSet" ReplicaSetName="rs0" UserName="app" Password="${encryptNcxAes('mongo-pass')}"><Member Host="m1.example.test" Port="27017"/><Advance Database="shop"/></Connection>` +
        '<Connection ConnectionName="Mongo Open" ConnType="MONGODB" Host="127.0.0.1"/>'
    )
    const result = await importConnectionFile(
      ctx,
      {
        source: 'navicat-ncx',
        path,
        keys: ['MongoDB:Mongo RS', 'MongoDB:Mongo Open'],
        existingMode: 'replace'
      },
      'darwin'
    )
    expect(result.warnings).toEqual([])
    const byName = new Map(result.created.map((c) => [c.name, c]))
    const rs = byName.get('Mongo RS')!
    expect(rs).toMatchObject({
      engine: 'mongodb',
      authMode: 'password',
      host: 'm1.example.test',
      mongo: {
        topology: 'replicaSet',
        replicaSet: 'rs0',
        defaultDatabase: 'shop',
        retryWrites: true
      }
    })
    expect(rs.network).toMatchObject({ connectTimeoutMs: 10000 })
    expect(credentials.get('mysql', rs.id)).toBe('mongo-pass')
    expect(byName.get('Mongo Open')).toMatchObject({
      authMode: 'none',
      mongo: { authMechanism: 'none' }
    })
  })
})
