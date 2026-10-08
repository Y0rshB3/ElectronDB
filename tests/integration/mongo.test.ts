/**
 * MongoDB 8.2 (P4a/P4b) through the real handler layer (ipc/mongo.ts) and the
 * generic ConnectionManager. Servers: a standalone with authentication
 * (VORTAQ_TEST_MONGO_URL, 127.0.0.1:57017) and a single-node replica set for
 * transactions (VORTAQ_TEST_MONGO_RS_URL, 127.0.0.1:57018). See the README
 * for the docker commands.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { EJSON, Double, Int32, Long } from 'bson'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { ConnectionInput, MongoCommandResult } from '@shared/types'
import { parseMongoUri } from '@shared/mongo/uri'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { ConnectionManager } from '@main/db/manager'
import { describeForLog } from '@main/ipc/errorLog'
import { createMongoHandlers } from '@main/ipc/mongo'
import { MONGO_RS_TARGET, MONGO_TARGET, describeServer } from './targets'

type Handlers = ReturnType<typeof createMongoHandlers>

const DB = `vortaq_mongo_${process.pid}`

function inputFromUrl(url: string, overrides: Partial<ConnectionInput> = {}): ConnectionInput {
  const p = parseMongoUri(url)
  return {
    name: 'Mongo IT',
    color: null,
    environment: 'local',
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
    ssl: { enabled: p.ssl.enabled, verifyServer: p.ssl.verifyServer },
    backupDir: '',
    extraBackupDirs: [],
    engine: 'mongodb',
    mongo: { ...p.mongo, defaultDatabase: DB },
    network: { connectTimeoutMs: 5000, keepAliveSec: 60 },
    ...overrides
  }
}

function makeContext(dir: string): AppContext {
  return {
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
}

const parse = (text: string): Record<string, unknown> =>
  EJSON.parse(text, { relaxed: false }) as Record<string, unknown>

function ok(results: MongoCommandResult[]): MongoCommandResult[] {
  const failed = results.find((r) => r.kind === 'error')
  if (failed) throw new Error(`${failed.statement}: ${failed.error}`)
  return results
}

describeServer(MONGO_TARGET, 'MongoDB driver (integration)', (url) => {
  let dir: string
  let ctx: AppContext
  let manager: ConnectionManager
  let h: Handlers
  let id: string
  let prodId: string
  const run = (script: string, extra: Record<string, unknown> = {}) =>
    h.channels['mongo:execute'](id, script, { database: DB, ...extra })

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-mongo-it-'))
    ctx = makeContext(dir)
    const password = parseMongoUri(url).password
    id = ctx.connections.save(inputFromUrl(url)).id
    prodId = ctx.connections.save(
      inputFromUrl(url, { name: 'Mongo IT prod', environment: 'production' })
    ).id
    for (const c of [id, prodId]) ctx.credentials.set('mysql', c, password)
    manager = new ConnectionManager(ctx)
    h = createMongoHandlers(ctx, manager)
    await manager.open(id)
    await h.dropDatabase(id, DB).catch(() => undefined)
  })

  afterAll(async () => {
    await h?.dropDatabase(id, DB).catch(() => undefined)
    await manager?.closeAll()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('tests the connection and reports the topology', async () => {
    const input = inputFromUrl(url)
    const result = await manager.test(input, parseMongoUri(url).password, null)
    expect(result.ok).toBe(true)
    expect(result.serverVersion).toMatch(/^MongoDB 8\.2/)
    expect(result.details?.join(' ')).toMatch(/Independiente/)
    const info = await manager.open(id)
    expect(info.runtime).toMatchObject({ topology: 'standalone', transactions: false })
  })

  it('reports a wrong password with an actionable message', async () => {
    const result = await manager.test(inputFromUrl(url), 'wrong-password', null)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/contraseña|Authentication/i)
  })

  it('creates a database with its first collection and lists it', async () => {
    await h.createDatabase(id, DB, undefined, { collection: 'people' })
    expect((await h.databases(id)).map((d) => d.name)).toContain(DB)
    const collections = await h.channels['mongo:collections'](id, DB)
    expect(collections.map((c) => c.name)).toEqual(['people'])
  })

  it('keeps every BSON type through insert, find and inline edits', async () => {
    const doc = `{
      _id: 1,
      name: 'Ana',
      age: NumberInt(30),
      score: Double(5),
      big: NumberLong('9007199254740993'),
      price: NumberDecimal('19.90'),
      at: ISODate('2026-10-07T10:00:00.000Z'),
      oid: ObjectId('6ac6f781fc637c60b5590643'),
      uuid: UUID('0e3b4a3c-7b5f-4b1a-9a7e-1d2e3f4a5b6c'),
      tags: ['a', 'b', 'c'],
      nested: { city: 'Lima', zip: NumberInt(15001) }
    }`
    const r = await h.channels['mongo:applyChanges'](id, DB, 'people', [{ kind: 'insert', doc }])
    expect(r).toMatchObject({ applied: 1, failure: null })
    expect(r.insertedIds[0]).toBe('{"$numberInt":"1"}')

    const page = await h.channels['mongo:find'](id, {
      database: DB,
      collection: 'people',
      filter: '{ _id: 1 }',
      sort: '',
      projection: '',
      skip: 0,
      limit: 50
    })
    expect(page.whole).toEqual([true])
    const loaded = parse(page.docs[0])
    expect(loaded.age).toBeInstanceOf(Int32)
    expect(loaded.score).toBeInstanceOf(Double)
    expect((loaded.big as Long).toString()).toBe('9007199254740993')
    expect(page.docs[0]).toContain('"price":{"$numberDecimal":"19.90"}')
    expect(page.fields[0].path).toBe('_id')

    // Typing 31 into an Int32 cell keeps an Int32.
    const edit = await h.channels['mongo:applyChanges'](id, DB, 'people', [
      {
        kind: 'update',
        id: '{"$numberInt":"1"}',
        set: { age: '{"$numberInt":"31"}', 'nested.city': '"Cusco"' },
        unset: [],
        expected: { age: '{"$numberInt":"30"}', 'nested.city': '"Lima"' }
      }
    ])
    expect(edit.failure).toBeNull()
    const after = parse(
      (await h.channels['mongo:document'](id, DB, 'people', '{"$numberInt":"1"}'))!
    )
    expect(after.age).toBeInstanceOf(Int32)
    expect(Number(after.age)).toBe(31)
    expect((after.big as Long).toString()).toBe('9007199254740993')
    expect((after.nested as Record<string, unknown>).city).toBe('Cusco')
  })

  it('reports a document changed since it was loaded (optimistic check)', async () => {
    const r = await h.channels['mongo:applyChanges'](id, DB, 'people', [
      {
        kind: 'update',
        id: '{"$numberInt":"1"}',
        set: { name: '"Bea"' },
        unset: [],
        expected: { name: '"not the current name"' }
      }
    ])
    expect(r.applied).toBe(0)
    expect(r.failure?.message).toMatch(/ha cambiado/)
  })

  it('sets arrays whole and removes fields', async () => {
    const r = await h.channels['mongo:applyChanges'](id, DB, 'people', [
      {
        kind: 'update',
        id: '{"$numberInt":"1"}',
        set: { tags: '["a","c"]' },
        unset: ['oid'],
        expected: { tags: '["a","b","c"]', oid: '{"$oid":"6ac6f781fc637c60b5590643"}' }
      }
    ])
    expect(r.failure).toBeNull()
    const after = parse(
      (await h.channels['mongo:document'](id, DB, 'people', '{"$numberInt":"1"}'))!
    )
    expect(after.tags).toEqual(['a', 'c'])
    expect('oid' in after).toBe(false)
  })

  it('refuses a replace of a document not fetched whole, and a stale one', async () => {
    await expect(
      h.channels['mongo:applyChanges'](id, DB, 'people', [
        {
          kind: 'replace',
          id: '{"$numberInt":"1"}',
          doc: '{ name: "x" }',
          fetchedWhole: false as never
        }
      ])
    ).rejects.toThrow(/cargado completo/)
    const stale = await h.channels['mongo:applyChanges'](id, DB, 'people', [
      {
        kind: 'replace',
        id: '{"$numberInt":"1"}',
        doc: '{ name: "x" }',
        fetchedWhole: true,
        original: '{"_id":{"$numberInt":"1"},"name":"old"}'
      }
    ])
    expect(stale.failure?.message).toMatch(/ha cambiado/)
    const current = (await h.channels['mongo:document'](id, DB, 'people', '{"$numberInt":"1"}'))!
    const replaced = await h.channels['mongo:applyChanges'](id, DB, 'people', [
      {
        kind: 'replace',
        id: '{"$numberInt":"1"}',
        doc: "{ _id: 1, name: 'Ana', big: NumberLong('9007199254740993'), extra: true }",
        fetchedWhole: true,
        original: current
      }
    ])
    expect(replaced.failure).toBeNull()
    const after = parse(
      (await h.channels['mongo:document'](id, DB, 'people', '{"$numberInt":"1"}'))!
    )
    expect(Object.keys(after)).toEqual(['_id', 'name', 'big', 'extra'])
    await expect(
      h.channels['mongo:applyChanges'](id, DB, 'people', [
        { kind: 'replace', id: '{"$numberInt":"1"}', doc: '{ _id: 2 }', fetchedWhole: true }
      ])
    ).rejects.toThrow(/_id no se puede cambiar/)
  })

  it('pages with «Cargar más» through an open cursor', async () => {
    const docs = Array.from({ length: 25 }, (_, i) => `{ _id: ${100 + i}, n: ${i} }`).join(',')
    ok(await run(`db.people.insertMany([${docs}])`))
    const [result] = ok(
      await run('db.people.find({ n: { $gte: 0 } }).sort({ n: 1 })', { maxDocs: 10 })
    )
    expect(result.kind).toBe('documents')
    expect(result.page?.docs).toHaveLength(10)
    expect(result.page?.truncated).toBe(true)
    expect(result.readOnlyReason).toBeNull()
    const more = await h.channels['mongo:getMore'](id, result.page!.resultId!, 10)
    expect(more.docs).toHaveLength(10)
    expect(parse(more.docs[0]).n).toEqual(new Int32(10))
    const last = await h.channels['mongo:getMore'](id, more.resultId!, 10)
    expect(last.docs).toHaveLength(5)
    expect(last.resultId).toBeNull()
  })

  it('runs read commands of the query tab', async () => {
    const results = ok(
      await run(`
        show collections
        db.people.countDocuments({ n: { $lt: 5 } })
        db.people.distinct('n', { n: { $lt: 3 } })
        db.people.aggregate([{ $match: { n: { $gte: 0 } } }, { $group: { _id: null, total: { $sum: '$n' } } }])
        db.people.aggregate([{ $match: { n: 1 } }, { $project: { n: 1 } }])
        db.people.find({ n: 1 }).count()
        db.stats()
        db.getCollectionNames()
        db.people.getIndexes()
        db.people.find({ n: 2 }).explain()
      `)
    )
    expect(results[0]).toMatchObject({ kind: 'value', value: 'people' })
    expect(parse(results[1].value!).v).toEqual(new Int32(5))
    expect(results[3].readOnlyReason).toMatch(/\$group/)
    expect(results[4].readOnlyReason).toBeNull()
    expect(results[4].page?.whole).toEqual([false])
    expect(parse(results[5].value!).v).toEqual(new Int32(1))
    expect(results[9].value).toContain('queryPlanner')
  })

  it('follows use <db> and getSiblingDB', async () => {
    const results = ok(
      await run(
        `use other_${process.pid}\ndb.getName()\ndb.getSiblingDB('${DB}').people.findOne({ _id: 1 })`
      )
    )
    expect(results[1].value).toBe(`other_${process.pid}`)
    expect(results[2].page?.docs).toHaveLength(1)
    expect(results.at(-1)?.currentDatabase).toBe(`other_${process.pid}`)
  })

  it('refuses scripts outside the grammar before running anything', async () => {
    await expect(run("db.people.insertOne({ _id: 'x' })\nprocess.exit()")).rejects.toThrow(
      /Solo se admiten/
    )
    expect(await h.channels['mongo:document'](id, DB, 'people', '"x"')).toBeNull()
    await expect(run('db.people.find({ a: Math.random() })')).rejects.toThrow(
      /no se pudo interpretar/
    )
    await expect(run('db.runCommand({ dropDatabase: 1 })')).rejects.toThrow(/admitidas/)
  })

  it('needs the typed confirmation for every write on production', async () => {
    const prod = (script: string, confirm = false) =>
      h.channels['mongo:execute'](prodId, script, { database: DB, confirmProduction: confirm })
    await expect(prod('db.people.updateMany({}, { $set: { flag: 1 } })')).rejects.toThrow(
      /confirmación explícita/
    )
    await expect(prod("db.people.aggregate([{ $out: 'copy' }])")).rejects.toThrow(/confirmación/)
    // $out spelled with an escape still writes: decided from the parsed pipeline.
    await expect(prod("db.people.aggregate([{ '\\u0024out': 'copy' }])")).rejects.toThrow(
      /confirmación/
    )
    await expect(prod("db.people.aggregate([{ $merge: { into: 'copy' } }])")).rejects.toThrow(
      /confirmación/
    )
    // The driver turns aggregate's `out` option into a $out stage: refused everywhere.
    await expect(prod("db.people.aggregate([], { out: 'copy' })")).rejects.toThrow(/«out»/)
    await expect(run("db.people.aggregate([], { out: 'copy' })")).rejects.toThrow(/«out»/)
    await expect(run('db.people.find({}, {}, { writeConcern: { w: 1 } })')).rejects.toThrow(
      /no se admite/
    )
    expect((await h.channels['mongo:collections'](prodId, DB)).map((c) => c.name)).not.toContain(
      'copy'
    )
    ok(await prod('db.people.find({ _id: 1 })'))
    await expect(
      h.channels['mongo:applyChanges'](prodId, DB, 'people', [
        { kind: 'delete', id: '{"$numberInt":"1"}' }
      ])
    ).rejects.toThrow(/confirmación/)
    await expect(
      h.channels['mongo:createIndex'](prodId, DB, 'people', { keys: '{ n: 1 }' })
    ).rejects.toThrow(/confirmación/)
    await expect(h.channels['mongo:clearCollection'](prodId, DB, 'people')).rejects.toThrow(
      /confirmación/
    )
    await expect(h.dropObject(prodId, DB, 'collection', 'people')).rejects.toThrow(/confirmación/)
    await expect(h.dropDatabase(prodId, DB)).rejects.toThrow(/confirmación/)
    const [written] = ok(await prod('db.people.updateOne({ _id: 1 }, { $set: { flag: 2 } })', true))
    expect(written.write).toMatchObject({ matched: 1, modified: 1 })
  })

  it('cancels a runaway query with killOp', async () => {
    ok(
      await run(
        'db.slow.insertMany([' +
          Array.from({ length: 50 }, (_, i) => `{ i: ${i} }`).join(',') +
          '])'
      )
    )
    const executionId = `it-${Date.now()}`
    const started = Date.now()
    const pending = run("db.slow.find({ $where: 'sleep(200) || true' })", { executionId })
    await new Promise((r) => setTimeout(r, 400))
    expect(await h.cancel(id, executionId)).toBe(true)
    const [result] = await pending
    expect(result.kind).toBe('error')
    expect(result.error).toMatch(/cancelada/)
    expect(Date.now() - started).toBeLessThan(5000)
    // A late cancel never hits the next statement.
    expect(await h.cancel(id, executionId)).toBe(false)
    ok(await run('db.slow.countDocuments({})'))
  })

  it('manages indexes, the validator, renames and empties collections', async () => {
    const name = await h.channels['mongo:createIndex'](id, DB, 'people', {
      keys: '{ name: 1, n: -1 }',
      unique: false,
      partialFilter: '{ n: { $gt: 0 } }'
    })
    expect(name).toBe('name_1_n_-1')
    const details = await h.channels['mongo:collectionDetails'](id, DB, 'people')
    const ix = details.indexes.find((i) => i.name === name)
    expect(ix).toMatchObject({ sparse: false, unique: false })
    expect(ix?.partialFilter).toContain('$gt')
    const tree = await h.objects(id, DB, 'index')
    expect(tree.map((o) => o.name)).toContain(`people.${name}`)
    await h.dropObject(id, DB, 'index', { type: 'index', name: `people.${name}`, table: 'people' })
    expect(
      (await h.channels['mongo:collectionDetails'](id, DB, 'people')).indexes.map((i) => i.name)
    ).toEqual(['_id_'])
    await expect(h.channels['mongo:dropIndex'](id, DB, 'people', '_id_')).rejects.toThrow(/_id_/)

    await h.channels['mongo:createCollection'](id, DB, 'validated', {
      validator: "{ $jsonSchema: { bsonType: 'object', required: ['email'] } }"
    })
    const bad = await h.channels['mongo:applyChanges'](id, DB, 'validated', [
      { kind: 'insert', doc: '{ name: 1 }' }
    ])
    expect(bad.failure?.message).toMatch(/no cumple el validador/)
    await h.channels['mongo:setValidator'](id, DB, 'validated', {
      validator: '',
      level: 'off',
      action: 'warn'
    })
    expect((await h.channels['mongo:collectionDetails'](id, DB, 'validated')).validator).toBeNull()

    await h.channels['mongo:renameCollection'](id, DB, 'validated', 'renamed')
    ok(await run('db.renamed.insertMany([{ a: 1 }, { a: 2 }])'))
    expect(await h.channels['mongo:countDocuments'](id, DB, 'renamed')).toBe(2)
    expect(await h.channels['mongo:clearCollection'](id, DB, 'renamed')).toBe(2)
  })

  it('marks views, capped and GridFS chunks read-only', async () => {
    await h.channels['mongo:createCollection'](id, DB, 'log', { capped: true, size: 65536 })
    ok(
      await run(
        "db.createCollection('people_view', { viewOn: 'people', pipeline: [{ $match: { n: { $gte: 0 } } }] })"
      )
    )
    ok(
      await run(
        "db.getCollection('fs.files').insertOne({ _id: 1 })\ndb.getCollection('fs.chunks').insertOne({ files_id: 1, n: 0 })"
      )
    )
    const infos = await h.channels['mongo:collections'](id, DB)
    const byName = Object.fromEntries(infos.map((i) => [i.name, i]))
    expect(byName.log.readOnlyReason).toMatch(/limitada/)
    expect(byName.people_view).toMatchObject({ type: 'view' })
    expect(byName.people_view.readOnlyReason).toMatch(/Vista/)
    expect(byName['fs.chunks'].readOnlyReason).toMatch(/GridFS/)
    await expect(
      h.channels['mongo:applyChanges'](id, DB, 'people_view', [{ kind: 'delete', id: '1' }])
    ).rejects.toThrow(/Vista/)
    const [viewResult] = ok(await run('db.people_view.find()'))
    expect(viewResult.readOnlyReason).toMatch(/Vista/)
  })

  it('samples field names and types without values', async () => {
    ok(
      await run("db.people.insertOne({ _id: 'nested', nested: { zip: NumberInt(1) }, who: 'Ana' })")
    )
    const fields = await h.channels['mongo:sampleFields'](id, DB, 'people', 100)
    const paths = fields.map((f) => f.path)
    expect(paths).toContain('nested.zip')
    expect(fields.find((f) => f.path === 'big')?.types).toEqual({ long: 1 })
    expect(fields.find((f) => f.path === 'nested.zip')?.types).toEqual({ int: 1 })
    expect(JSON.stringify(fields)).not.toContain('Ana')
  })

  it('keeps server text that echoes values out of the log', async () => {
    let caught: unknown = null
    try {
      const r = await h.channels['mongo:applyChanges'](id, DB, 'people', [
        { kind: 'insert', doc: "{ _id: 1, secret: 'zzz-private' }" }
      ])
      caught = new Error(r.failure?.message)
      expect(r.failure?.message).toMatch(/Clave duplicada/)
    } catch (err) {
      caught = err
    }
    const prod = await h.channels['mongo:execute'](
      id,
      "db.people.insertOne({ _id: 1, secret: 'zzz-private' })",
      {
        database: DB
      }
    )
    expect(prod[0].error).toMatch(/duplicate key|Clave duplicada/)
    try {
      await run("db.people.find({ a: 'zzz-private' + 1 })")
    } catch (err) {
      caught = err
    }
    expect(describeForLog(caught)).not.toContain('zzz-private')
  })
})

describeServer(MONGO_RS_TARGET, 'MongoDB replica set (integration)', (url) => {
  let dir: string
  let ctx: AppContext
  let manager: ConnectionManager
  let h: Handlers
  let id: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-mongo-rs-it-'))
    ctx = makeContext(dir)
    id = ctx.connections.save(inputFromUrl(url, { name: 'Mongo RS IT' })).id
    manager = new ConnectionManager(ctx)
    h = createMongoHandlers(ctx, manager)
    await h.dropDatabase(id, DB).catch(() => undefined)
    await h.createDatabase(id, DB, undefined, { collection: 'items' })
  })

  afterAll(async () => {
    await h?.dropDatabase(id, DB).catch(() => undefined)
    await manager?.closeAll()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('detects the replica set and its primary', async () => {
    const info = await manager.open(id)
    expect(info.runtime).toMatchObject({
      topology: 'replicaSet',
      transactions: true,
      memberRole: 'primary'
    })
  })

  it('applies a grid batch atomically and rolls all of it back on a failure', async () => {
    const good = await h.channels['mongo:applyChanges'](id, DB, 'items', [
      { kind: 'insert', doc: '{ _id: 1 }' },
      { kind: 'insert', doc: '{ _id: 2 }' }
    ])
    expect(good).toMatchObject({ applied: 2, atomic: true, failure: null })
    await expect(
      h.channels['mongo:applyChanges'](id, DB, 'items', [
        { kind: 'insert', doc: '{ _id: 3 }' },
        { kind: 'insert', doc: '{ _id: 1 }' }
      ])
    ).rejects.toThrow(/Falló el cambio 2 de 2.*se deshicieron todos/)
    expect(await h.channels['mongo:document'](id, DB, 'items', '{"$numberInt":"3"}')).toBeNull()
  })

  it('keeps a query tab transaction until commit or rollback', async () => {
    const key = 'tab-1'
    const state = await h.channels['mongo:beginTransaction'](id, key)
    expect(state.transactionStatus).toBe('in')
    const [ins] = ok(
      await h.channels['mongo:execute'](id, 'db.items.insertOne({ _id: 10 })', {
        database: DB,
        sessionKey: key
      })
    )
    expect(ins.transactionStatus).toBe('in')
    // Outside the transaction the document is not visible yet.
    expect(await h.channels['mongo:document'](id, DB, 'items', '{"$numberInt":"10"}')).toBeNull()
    await h.rollback(id, key)
    expect((await h.sessionState(id, key)).transactionStatus).toBe('idle')
    expect(await h.channels['mongo:document'](id, DB, 'items', '{"$numberInt":"10"}')).toBeNull()

    await h.channels['mongo:beginTransaction'](id, key)
    ok(
      await h.channels['mongo:execute'](id, 'db.items.insertOne({ _id: 11 })', {
        database: DB,
        sessionKey: key
      })
    )
    await h.commit(id, key)
    expect(
      await h.channels['mongo:document'](id, DB, 'items', '{"$numberInt":"11"}')
    ).not.toBeNull()
    await h.closeSession(id, key)
    expect((await h.sessionState(id, key)).open).toBe(false)
  })

  it('refuses a transaction on a standalone-style request twice', async () => {
    await h.channels['mongo:beginTransaction'](id, 'tab-2')
    await expect(h.channels['mongo:beginTransaction'](id, 'tab-2')).rejects.toThrow(
      /Ya hay una transacción/
    )
    await h.closeSession(id, 'tab-2')
  })
})
