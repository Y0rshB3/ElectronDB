/**
 * AI assistant context on MongoDB 8.2 (VORTAQ_TEST_MONGO_URL): the structure
 * source reads collection names, index keys, the structural part of a
 * $jsonSchema and sampled field types, and no document value, enum value,
 * view pipeline literal or partial-filter literal reaches the context.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { ConnectionInput } from '@shared/types'
import { parseMongoUri } from '@shared/mongo/uri'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { ConnectionManager } from '@main/db/manager'
import { AiService } from '@main/ai/service'
import { MONGO_ENGINE_NOTE, mongoStructureSource, schemaShape } from '@main/ai/mongoMetadata'
import { isMongoConnection } from '@main/mongo/connection'
import { MONGO_TARGET, describeServer } from './targets'

const DB = `vortaq_ai_mongo_${process.pid}`
const SECRET = 'SECRET-DOC-VALUE-5e1b'
const ENUM = 'ENUM-LITERAL-77aa'
const VIEW_LITERAL = 'VIEW-LITERAL-3c9d'
const PARTIAL_LITERAL = 'PARTIAL-LITERAL-0f0f'

describeServer(MONGO_TARGET, 'AI schema context on MongoDB', (url) => {
  let dir: string
  let manager: ConnectionManager
  let ai: AiService
  let id: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-ai-mongo-'))
    const ctx: AppContext = {
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
    const input: ConnectionInput = {
      name: 'AI Mongo',
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
      ssl: { enabled: false, verifyServer: true },
      backupDir: '',
      extraBackupDirs: [],
      engine: 'mongodb',
      mongo: { ...p.mongo, defaultDatabase: DB }
    }
    id = ctx.connections.save(input).id
    ctx.credentials.set('mysql', id, p.password)
    manager = new ConnectionManager(ctx)
    const conn = await manager.connection(id)
    if (!isMongoConnection(conn)) throw new Error('not mongo')
    const db = conn.db(DB)
    await db.dropDatabase()
    await db.createCollection('people', {
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['email'],
          properties: {
            email: { bsonType: 'string', pattern: '^.+@example' },
            status: { enum: [ENUM, 'other'], description: 'Estado del cliente' }
          }
        }
      }
    })
    await db.collection('people').insertMany([
      { email: `${SECRET}@example.test`, status: ENUM, profile: { age: 30 } },
      { email: 'b@example.test', status: 'other', tags: ['x'] }
    ])
    await db.collection('people').createIndex({ email: 1 }, { unique: true })
    await db
      .collection('people')
      .createIndex(
        { status: 1 },
        { partialFilterExpression: { status: PARTIAL_LITERAL }, name: 'status_partial' }
      )
    await db.createCollection('people_view', {
      viewOn: 'people',
      pipeline: [{ $match: { status: VIEW_LITERAL } }]
    })
    ai = new AiService({
      userDataPath: dir,
      credentials: ctx.credentials,
      settings: ctx.settings,
      environmentOf: () => 'local',
      acquire: () => Promise.reject(new Error('no SQL sessions')),
      isMongo: () => true,
      mongoSource: async () => {
        const c = await manager.connection(id)
        if (!isMongoConnection(c)) throw new Error('not mongo')
        return mongoStructureSource(c)
      },
      emit: () => undefined,
      log: { info: () => undefined, warn: () => undefined }
    })
  })

  afterAll(async () => {
    const conn = await manager?.connection(id).catch(() => null)
    if (conn && isMongoConnection(conn))
      await conn
        .db(DB)
        .dropDatabase()
        .catch(() => undefined)
    await manager?.closeAll()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('describes collections, fields, indexes and the validator shape without values', async () => {
    const preview = await ai.buildContext({ connectionId: id, schema: DB, input: 'clientes' })
    const text = preview.context
    expect(text).toContain(MONGO_ENGINE_NOTE)
    expect(text).toContain('people')
    expect(text).toContain('profile.age')
    expect(text).toMatch(/email/)
    expect(text).toMatch(/email string UQ/)
    expect(text).toContain('status_partial')
    expect(text).toContain('Estado del cliente')
    expect(text).toContain('validador: obligatorios email')
    expect(text).toContain('(MongoDB 8.2')
    expect(text).toContain('vista sobre people')
    for (const secret of [SECRET, ENUM, VIEW_LITERAL, PARTIAL_LITERAL, '^.+@example'])
      expect(text, secret).not.toContain(secret)
  })

  it('lists databases when none is selected', async () => {
    const preview = await ai.buildContext({ connectionId: id, schema: null })
    expect(preview.context).toContain(DB)
  })

  it('keeps only structural keys of a $jsonSchema', () => {
    expect(
      schemaShape({
        bsonType: 'object',
        required: ['a'],
        properties: { a: { bsonType: 'int', minimum: 3, enum: [1], const: 2 } },
        additionalProperties: false
      })
    ).toEqual({ bsonType: 'object', required: ['a'], properties: { a: { bsonType: 'int' } } })
  })
})
