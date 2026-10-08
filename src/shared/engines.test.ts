import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NETWORK,
  ENGINE_IDS,
  ENGINES,
  assertCapability,
  engineOf,
  isEngineId,
  isMysqlFamilyEngine,
  pickableEngines,
  withEngineDefaults
} from './engines'
import type { ConnectionConfig, EngineId } from './types'

const mysqlRecord = (overrides: Partial<ConnectionConfig> = {}): ConnectionConfig =>
  ({
    id: 'c1',
    name: 'Local',
    color: null,
    environment: 'local',
    host: '127.0.0.1',
    port: 3306,
    username: 'root',
    savePassword: true,
    customDatabases: [],
    initialQueries: '',
    ssh: {
      enabled: false,
      host: '',
      port: 22,
      username: '',
      authType: 'password',
      savePassword: false
    },
    ssl: { enabled: false, verifyServer: false },
    backupDir: '/tmp/x',
    extraBackupDirs: [],
    createdAt: 'a',
    updatedAt: 'b',
    ...overrides
  }) as ConnectionConfig

describe('engine descriptors', () => {
  it('declares the five engines, keyed by their own id', () => {
    expect(ENGINE_IDS).toEqual(['mysql', 'mariadb', 'postgresql', 'sqlite', 'mongodb'])
    for (const id of ENGINE_IDS) expect(ENGINES[id].id).toBe(id)
  })

  it('ships every driver; PostgreSQL, SQLite and MongoDB are previews', () => {
    const available = ENGINE_IDS.filter((id) => ENGINES[id].available)
    expect(available).toEqual(['mysql', 'mariadb', 'postgresql', 'sqlite', 'mongodb'])
    expect(ENGINES.mysql.capabilities.preview).toBe(false)
    expect(ENGINES.mariadb.capabilities.preview).toBe(false)
    for (const id of ['postgresql', 'sqlite', 'mongodb'] as const) {
      expect(ENGINES[id].capabilities.preview).toBe(true)
    }
  })

  it('gives MariaDB everything MySQL has, plus sequences and RETURNING', () => {
    const { mysql, mariadb } = ENGINES
    expect(mariadb).toMatchObject({ label: 'MariaDB', defaultPort: 3306, defaultUser: 'root' })
    expect(mariadb.groups).toEqual([
      'tables',
      'views',
      'functions',
      'events',
      'sequences',
      'queries',
      'backups'
    ])
    expect(mariadb.capabilities).toEqual({
      ...mysql.capabilities,
      sequences: true,
      returning: 'insert-delete',
      sqlDialect: 'mariadb'
    })
    expect(isMysqlFamilyEngine('mysql')).toBe(true)
    expect(isMysqlFamilyEngine('mariadb')).toBe(true)
    expect(isMysqlFamilyEngine(undefined)).toBe(true)
    expect(isMysqlFamilyEngine('postgresql')).toBe(false)
  })

  it('keeps MySQL exactly as the app behaves today', () => {
    const mysql = ENGINES.mysql
    expect(mysql).toMatchObject({ label: 'MySQL', defaultPort: 3306, defaultUser: 'root' })
    expect(mysql.groups).toEqual(['tables', 'views', 'functions', 'events', 'queries', 'backups'])
    expect(mysql.capabilities).toMatchObject({
      family: 'sql',
      hierarchy: 'database',
      hasSchemas: false,
      hasUsers: true,
      supportsBackupsNb3: true,
      supportsAutomation: true,
      supportsSsh: true,
      supportsSsl: true,
      needsHost: true,
      passwordOptional: false,
      tabSessions: false,
      initialQueries: true,
      createDatabase: 'charset',
      charsets: true,
      events: true,
      routines: true,
      triggers: true,
      sequences: false,
      materializedViews: false,
      definer: true,
      tableEngines: true,
      unsignedTypes: true,
      columnPositions: true,
      alterColumnInPlace: true,
      transactionalDdl: false,
      resultAliasMetadata: true,
      returning: 'none',
      cancel: 'kill-query',
      sqlDialect: 'mysql',
      documentModel: false,
      designer: 'table'
    })
  })

  it('matches the capability table of the design for the other engines', () => {
    const caps = (id: EngineId) => ENGINES[id].capabilities
    // only the MySQL family keeps .nb3 backups; every engine has .vqb backups and automation
    for (const id of ['postgresql', 'sqlite', 'mongodb'] as const) {
      expect(caps(id).supportsBackupsNb3).toBe(false)
      expect(caps(id).supportsBackupsVqb).toBe(true)
      expect(caps(id).supportsAutomation).toBe(true)
    }
    expect(caps('mariadb')).toMatchObject({ sequences: true, returning: 'insert-delete' })
    expect(caps('postgresql')).toMatchObject({
      hierarchy: 'database>schema',
      hasSchemas: true,
      columnPositions: false,
      transactionalDdl: true,
      truncate: { restartIdentity: true, cascade: true },
      resultAliasMetadata: false,
      cancel: 'pg-cancel'
    })
    expect(caps('sqlite')).toMatchObject({
      hierarchy: 'attached',
      supportsBackupsVqb: true,
      tabSessions: true,
      cancel: 'kill-process',
      needsHost: false,
      passwordOptional: true,
      supportsSsh: false,
      alterColumnInPlace: false,
      truncate: false,
      createDatabase: false
    })
    expect(caps('mongodb')).toMatchObject({
      family: 'document',
      sqlDialect: null,
      initialQueries: false,
      designer: 'collection'
    })
    expect(ENGINES.postgresql.groups).toContain('materializedViews')
    expect(ENGINES.mongodb.groups).toEqual(['collections', 'views', 'indexes', 'queries'])
    expect(caps('mongodb').supportsBackupsVqb).toBe(true)
  })
})

describe('engine helpers', () => {
  it('treats a missing engine as MySQL and rejects unknown ones', () => {
    expect(engineOf({}).id).toBe('mysql')
    expect(engineOf({ engine: 'postgresql' }).id).toBe('postgresql')
    expect(() => engineOf({ engine: 'oracle' as EngineId })).toThrow(
      'Motor de base de datos desconocido: "oracle".'
    )
    expect(isEngineId('sqlite')).toBe(true)
    expect(isEngineId('toString')).toBe(false)
    expect(isEngineId(undefined)).toBe(false)
  })

  it('assertCapability throws the given message only when the flag is off', () => {
    expect(() => assertCapability({ engine: 'mysql' }, 'supportsBackupsNb3', 'x')).not.toThrow()
    expect(() => assertCapability({}, 'supportsAutomation', 'x')).not.toThrow()
    expect(() =>
      assertCapability({ engine: 'postgresql' }, 'supportsBackupsNb3', 'Sin copias .nb3')
    ).toThrow('Sin copias .nb3')
  })

  it('offers PostgreSQL, SQLite and MongoDB in the pickers only with previews on', () => {
    expect(pickableEngines(false).map((e) => e.id)).toEqual(['mysql', 'mariadb'])
    expect(pickableEngines(true).map((e) => e.id)).toEqual([
      'mysql',
      'mariadb',
      'postgresql',
      'sqlite',
      'mongodb'
    ])
  })
})

describe('withEngineDefaults', () => {
  it('adds only engine to a legacy MySQL record and keeps every other value', () => {
    const legacy = mysqlRecord()
    delete (legacy as Partial<ConnectionConfig>).engine
    const normalised = withEngineDefaults(legacy)
    expect(normalised).toEqual({ ...legacy, engine: 'mysql' })
    expect(normalised).not.toBe(legacy)
    expect(legacy).not.toHaveProperty('engine')
    for (const block of ['network', 'postgres', 'sqlite', 'mongo']) {
      expect(normalised).not.toHaveProperty(block)
    }
  })

  it('returns the same object when nothing is missing', () => {
    const record = mysqlRecord({ engine: 'mysql' })
    expect(withEngineDefaults(record)).toBe(record)
  })

  it('fills PostgreSQL network and block defaults, keeping stored values', () => {
    const pg = withEngineDefaults(
      mysqlRecord({ engine: 'postgresql', postgres: { initialDatabase: 'app' } as never })
    )
    expect(pg.network).toEqual(DEFAULT_NETWORK)
    expect(pg.postgres).toEqual({
      initialDatabase: 'app',
      showSystemSchemas: false,
      timeZone: '',
      searchPath: ''
    })
    expect(withEngineDefaults(pg)).toBe(pg)
  })

  it('defaults SQLite to read-only on production and fills MongoDB options', () => {
    const prod = withEngineDefaults(mysqlRecord({ engine: 'sqlite', environment: 'production' }))
    expect(prod.sqlite).toMatchObject({ readOnly: true, foreignKeys: false, attached: [] })
    expect(prod.network).toBeUndefined()
    const local = withEngineDefaults(mysqlRecord({ engine: 'sqlite' }))
    expect(local.sqlite?.readOnly).toBe(false)
    const mongo = withEngineDefaults(mysqlRecord({ engine: 'mongodb' }))
    expect(mongo.mongo).toMatchObject({
      topology: 'standalone',
      authSource: 'admin',
      retryWrites: true,
      extraOptions: {}
    })
    expect(mongo.network).toEqual(DEFAULT_NETWORK)
  })
})
