/**
 * .vqb backups of MongoDB 8.2 (VORTAQ_TEST_MONGO_URL): every BSON type comes
 * back unchanged (canonical Extended JSON), with options, validator, indexes
 * and views; restores go into a new database, over existing collections, or
 * REPLACE the database after a safety copy; encrypted copies need their password.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  Binary,
  Decimal128,
  Double,
  EJSON,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
  BSONRegExp
} from 'bson'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { ConnectionInput } from '@shared/types'
import { parseMongoUri } from '@shared/mongo/uri'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { ConnectionManager } from '@main/db/manager'
import { createBackupService, type BackupService } from '@main/backup/index'
import { replaceRestore } from '@main/backup/handlers'
import { isMongoConnection, type MongoDriverConnection } from '@main/mongo/connection'
import { MONGO_TARGET, describeServer } from './targets'

const SRC = `vortaq_vqb_mongo_${process.pid}`
const DST = `${SRC}_copy`
const FAST_SCRYPT = { N: 1024, r: 8, p: 1 }

describeServer(MONGO_TARGET, 'MongoDB .vqb backups (integration)', (url) => {
  let dir: string
  let ctx: AppContext
  let manager: ConnectionManager
  let service: BackupService
  let conn: MongoDriverConnection
  let id: string
  let prodId: string

  const canonicalDocs = async (db: string, coll: string): Promise<string[]> =>
    (await conn.rawColl(db, coll).find({}).sort({ _id: 1 }).toArray()).map((d) =>
      EJSON.stringify(d, { relaxed: false })
    )

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-vqb-mongo-'))
    ctx = {
      userDataPath: dir,
      logDir: join(dir, 'logs'),
      connections: new ConnectionsRepo(dir),
      jobs: new JobsRepo(dir),
      runs: new RunsRepo(dir),
      settings: new SettingsRepo(dir, dir),
      credentials: new CredentialStore(dir, plainCodec, 'plain'),
      emit: <E extends IpcEventChannel>(_c: E, _p: IpcEventMap[E]) => {},
      headless: true
    }
    const p = parseMongoUri(url)
    const input = (name: string, environment: 'local' | 'production'): ConnectionInput => ({
      name,
      color: null,
      environment,
      host: p.host,
      port: p.port,
      username: p.username,
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
      ssl: { enabled: false, verifyServer: true },
      backupDir: join(dir, 'backups'),
      extraBackupDirs: [],
      engine: 'mongodb',
      mongo: { ...p.mongo, defaultDatabase: SRC }
    })
    id = ctx.connections.save(input('Mongo VQB', 'local')).id
    prodId = ctx.connections.save(input('Mongo VQB prod', 'production')).id
    for (const c of [id, prodId]) ctx.credentials.set('mysql', c, p.password)
    manager = new ConnectionManager(ctx)
    service = createBackupService(
      ctx,
      { acquire: () => Promise.reject(new Error('no')) },
      { scrypt: FAST_SCRYPT }
    )
    const c = await manager.connection(id)
    if (!isMongoConnection(c)) throw new Error('not mongo')
    conn = c
    for (const db of [SRC, DST]) await conn.db(db).dropDatabase()
    const db = conn.db(SRC)
    await db.createCollection('people', {
      validator: { $jsonSchema: { bsonType: 'object', required: ['name'] } },
      validationLevel: 'moderate'
    })
    await db.collection<{ _id: unknown; [key: string]: unknown }>('people').insertMany([
      {
        _id: new ObjectId('6ac6f781fc637c60b5590643'),
        name: 'Ana',
        i32: new Int32(7),
        dbl: new Double(5),
        long: Long.fromString('9007199254740993'),
        dec: Decimal128.fromString('19.90'),
        date: new Date('2026-10-07T10:00:00.123Z'),
        old: new Date(-62198755200001),
        uuid: new UUID('0e3b4a3c-7b5f-4b1a-9a7e-1d2e3f4a5b6c'),
        bin: new Binary(new Uint8Array([0, 255, 1]), 128),
        ts: new Timestamp({ t: 1700000000, i: 2 }),
        re: new BSONRegExp('^a.c$', 'imx'),
        min: new MinKey(),
        max: new MaxKey(),
        nested: { arr: [new Int32(1), { deep: Long.fromNumber(-2) }], empty: {} }
      },
      { _id: 'string-id', name: 'Bob', tags: ['a', 'b'] },
      { _id: new Int32(42), name: 'Num' }
    ])
    await db.collection('people').createIndex({ name: 1 }, { unique: true, name: 'name_u' })
    await db
      .collection('people')
      .createIndex(
        { date: -1 },
        { expireAfterSeconds: 3600, partialFilterExpression: { name: { $exists: true } } }
      )
    await db.createCollection('log', { capped: true, size: 65536, max: 100 })
    await db
      .collection('log')
      .insertMany(Array.from({ length: 5 }, (_, i) => ({ n: new Int32(i) })))
    await db
      .collection<{ _id: unknown; [key: string]: unknown }>('big')
      .insertMany(
        Array.from({ length: 2500 }, (_, i) => ({ _id: new Int32(i), v: 'x'.repeat(50) }))
      )
    await db.createCollection('people_names', {
      viewOn: 'people',
      pipeline: [{ $project: { name: 1 } }]
    })
  })

  afterAll(async () => {
    for (const db of [SRC, DST])
      await conn
        ?.db(db)
        .dropDatabase()
        .catch(() => undefined)
    await manager?.closeAll()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  let backupPath = ''
  let encryptedPath = ''

  it('writes a .vqb with collections, documents, indexes and views', async () => {
    const result = await service.create({
      connectionId: id,
      schema: SRC,
      includeData: true,
      format: 'vqb'
    })
    backupPath = result.path
    expect(result.objects).toBe(4)
    expect(result.rows).toBe(3 + 5 + 2500)
    const meta = await service.readMeta(backupPath)
    expect(meta).toMatchObject({ engine: 'mongodb', schema: SRC, databaseType: 'MONGODB' })
    expect(meta.objects.map((o) => `${o.type}:${o.name}`)).toEqual([
      'Collection:big',
      'Collection:log',
      'Collection:people',
      'View:people_names'
    ])
    const verified = await service.verify(backupPath)
    expect(verified.rows).toBe(2508)
  })

  it('restores into a new database with every BSON type unchanged', async () => {
    const result = await service.restore({
      backupPath,
      connectionId: id,
      targetSchema: DST,
      createSchema: true,
      dropObjectsFirst: false,
      includeStructure: true,
      includeData: true,
      continueOnError: false
    })
    expect(result.errors).toEqual([])
    expect(result).toMatchObject({ objectsRestored: 4, rowsInserted: 2508 })
    for (const coll of ['people', 'log', 'big'])
      expect(await canonicalDocs(DST, coll)).toEqual(await canonicalDocs(SRC, coll))
    const infos = await conn.db(DST).listCollections().toArray()
    const byName = Object.fromEntries(
      infos.map((c) => [c.name, c as { options?: Record<string, unknown>; type?: string }])
    )
    expect(byName.log.options).toMatchObject({ capped: true, max: 100 })
    expect(byName.people.options?.validator).toEqual({
      $jsonSchema: { bsonType: 'object', required: ['name'] }
    })
    expect(byName.people.options?.validationLevel).toBe('moderate')
    expect(byName.people_names.type).toBe('view')
    const indexes = await conn.coll(DST, 'people').listIndexes().toArray()
    expect(indexes.find((i) => i.name === 'name_u')).toMatchObject({ unique: true })
    expect(indexes.find((i) => i.name === 'date_-1')).toMatchObject({ expireAfterSeconds: 3600 })
  })

  it('refuses to create over existing collections unless asked to drop them', async () => {
    const refused = await service.restore({
      backupPath,
      connectionId: id,
      targetSchema: DST,
      createSchema: false,
      dropObjectsFirst: false,
      includeStructure: true,
      includeData: true,
      objects: ['people'],
      continueOnError: false
    })
    expect(refused.errors[0].message).toMatch(/ya existe/)
    await conn.coll(DST, 'people').deleteMany({})
    const dataOnly = await service.restore({
      backupPath,
      connectionId: id,
      targetSchema: DST,
      createSchema: false,
      dropObjectsFirst: false,
      includeStructure: false,
      includeData: true,
      objects: ['people'],
      continueOnError: false
    })
    expect(dataOnly).toMatchObject({ objectsRestored: 1, rowsInserted: 3, errors: [] })
  })

  it('replaces the database after a safety copy', async () => {
    await conn.coll(DST, 'people').insertOne({ name: 'extra' })
    await conn.db(DST).createCollection('stray')
    const result = await replaceRestore(
      service,
      {
        backupPath,
        connectionId: id,
        targetSchema: DST,
        createSchema: false,
        dropObjectsFirst: false,
        includeStructure: true,
        includeData: true,
        continueOnError: false,
        replaceSchema: true,
        safetyBackup: true
      },
      () => undefined,
      new AbortController().signal
    )
    expect(result.safetyBackupPath).toMatch(/\.vqb$/)
    const names = (await conn.db(DST).listCollections().toArray())
      .map((c) => c.name)
      .filter((n) => !n.startsWith('system.'))
      .sort()
    expect(names).toEqual(['big', 'log', 'people', 'people_names'])
    expect(await canonicalDocs(DST, 'people')).toEqual(await canonicalDocs(SRC, 'people'))
  })

  it('encrypts copies and needs the password to restore them', async () => {
    const result = await service.create({
      connectionId: id,
      schema: SRC,
      includeData: true,
      format: 'vqb',
      password: 'una-clave-larga',
      objects: ['people']
    })
    encryptedPath = result.path
    expect((await service.readMeta(encryptedPath)).locked).toBe(true)
    await expect(
      service.restore({
        backupPath: encryptedPath,
        connectionId: id,
        targetSchema: `${DST}_enc`,
        createSchema: true,
        dropObjectsFirst: true,
        includeStructure: true,
        includeData: true,
        continueOnError: false
      })
    ).rejects.toThrow(/contraseña/)
    const ok = await service.restore({
      backupPath: encryptedPath,
      connectionId: id,
      targetSchema: `${DST}_enc`,
      createSchema: true,
      dropObjectsFirst: true,
      includeStructure: true,
      includeData: true,
      continueOnError: false,
      password: 'una-clave-larga'
    })
    expect(ok.rowsInserted).toBe(3)
    await conn.db(`${DST}_enc`).dropDatabase()
  })

  it('guards production and the system databases', async () => {
    await expect(
      service.restore({
        backupPath,
        connectionId: prodId,
        targetSchema: DST,
        createSchema: true,
        dropObjectsFirst: true,
        includeStructure: true,
        includeData: true,
        continueOnError: false
      })
    ).rejects.toThrow(/producción/)
    await expect(
      service.restore({
        backupPath,
        connectionId: id,
        targetSchema: 'admin',
        createSchema: true,
        dropObjectsFirst: true,
        includeStructure: true,
        includeData: true,
        continueOnError: false
      })
    ).rejects.toThrow(/sistema/)
  })
})
