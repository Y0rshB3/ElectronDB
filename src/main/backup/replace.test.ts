import { mkdtempSync, openSync, rmSync, writeSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '@shared/types'
import {
  connectionInput,
  fakeBackupService,
  fakeSessionFactory,
  type FakeBackupService,
  type FakeSessionFactory
} from '../automation/testSupport'
import { ConnectionsRepo } from '../storage/repos'
import { Nb3Writer } from './nb3/writer'
import { readManifest, verifyBackupFile } from './nb3/reader'
import { indexTar } from './nb3/tar'
import {
  REPLACE_PRODUCTION_MESSAGE,
  ReplaceIncompleteError,
  SAFETY_LABEL,
  readBackupCharset,
  replaceSchemaFromBackup,
  type ReplaceDeps,
  type ReplaceRequest
} from './replace'

const FIXTURE = resolve('tests/fixtures/navicat/backups/demo/20260317144801-fixture.nb3')

describe('replaceSchemaFromBackup', () => {
  let dir: string
  let timeline: string[]
  let backups: FakeBackupService
  let sessions: FakeSessionFactory
  let connections: ConnectionsRepo
  let local: ConnectionConfig
  let deps: ReplaceDeps
  let lines: string[]
  const BACKUP = '/backups/staging/auth/20261005120000-diario.nb3'

  const request = (overrides: Partial<ReplaceRequest> = {}): ReplaceRequest => ({
    backupPath: BACKUP,
    expectedSchema: 'auth',
    connectionId: local.id,
    targetSchema: 'auth',
    safetyBackup: true,
    continueOnError: false,
    ...overrides
  })
  const run = (overrides: Partial<ReplaceRequest> = {}) =>
    replaceSchemaFromBackup(deps, request(overrides), { line: (l) => lines.push(l) })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-replace-'))
    timeline = []
    backups = fakeBackupService(dir, timeline)
    sessions = fakeSessionFactory(timeline)
    connections = new ConnectionsRepo(dir)
    local = connections.save(connectionInput('Local'))
    backups.files.set(BACKUP, 'auth')
    backups.objects.set('auth', [
      { type: 'Table', name: 'users', rows: 3 },
      { type: 'View', name: 'v_users' }
    ])
    lines = []
    deps = {
      connections,
      sessions,
      backups,
      backupCharset: async () => ({ charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' })
    }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('backs up the existing database, then drops, recreates and restores it (in this order)', async () => {
    sessions.schemas.set(local.id, new Set(['auth']))
    const result = await run()
    expect(timeline).toEqual([
      'create:auth',
      'DROP DATABASE `auth`',
      'CREATE DATABASE `auth` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
      'restore:auth'
    ])
    expect(backups.calls[0]).toMatchObject({
      connectionId: local.id,
      schema: 'auth',
      includeData: true,
      label: SAFETY_LABEL
    })
    expect(SAFETY_LABEL).toBe('previo-rollback')
    expect(backups.restores[0]).toMatchObject({
      backupPath: BACKUP,
      connectionId: local.id,
      targetSchema: 'auth',
      createSchema: false,
      includeStructure: true,
      includeData: true,
      continueOnError: false
    })
    expect(result.existed).toBe(true)
    expect(result.safetyBackup?.path).toContain('auth-previo-rollback')
    expect(result.restore.rowsInserted).toBe(3)
    expect(lines.join('\n')).toMatch(/Copia previa de auth \.+ .*OK/)
    expect(lines.join('\n')).toMatch(/Reemplazar base de datos auth \.+ +utf8mb4_0900_ai_ci {2}OK/)
  })

  it('includeData defaults to true when absent and logs «estructura y datos»', async () => {
    const result = await run()
    expect(result.includeData).toBe(true)
    expect(backups.restores[0].includeData).toBe(true)
    expect(backups.restores[0].skipAutoIncrement).toBeUndefined()
    expect(result.restore.structureOnly).toBeUndefined()
    expect(lines).toContain('  Contenido: estructura y datos')
  })

  it('«Solo estructura» restores every object without rows nor AUTO_INCREMENT, keeping safety copy and checks', async () => {
    sessions.schemas.set(local.id, new Set(['auth']))
    const result = await run({ includeData: false })
    expect(timeline).toEqual([
      'create:auth',
      'DROP DATABASE `auth`',
      'CREATE DATABASE `auth` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
      'restore:auth'
    ])
    // The safety copy of the current database still keeps its rows.
    expect(backups.calls[0]).toMatchObject({ includeData: true, label: SAFETY_LABEL })
    expect(backups.restores[0]).toMatchObject({
      includeStructure: true,
      includeData: false,
      skipAutoIncrement: true,
      createSchema: false,
      dropObjectsFirst: false
    })
    expect(result.includeData).toBe(false)
    expect(result.restore).toMatchObject({
      objectsRestored: 2,
      rowsInserted: 0,
      structureOnly: true
    })
    const log = lines.join('\n')
    expect(log).toContain('Contenido: solo estructura')
    expect(log).toMatch(/Comprobar integridad de la copia \.+ .*OK/)
  })

  it('«Solo estructura» keeps the production and system-schema rules', async () => {
    const prod = connections.save({ ...connectionInput('Prod'), environment: 'production' })
    await expect(run({ connectionId: prod.id, includeData: false })).rejects.toThrow(
      REPLACE_PRODUCTION_MESSAGE
    )
    await expect(run({ targetSchema: 'mysql', includeData: false })).rejects.toThrow(
      /base de datos del sistema/
    )
    expect(timeline).toEqual([])
  })

  it('never drops the database when the safety backup fails', async () => {
    sessions.schemas.set(local.id, new Set(['auth']))
    backups.failures.set('auth', 'disk full')
    await expect(run()).rejects.toThrow(
      /No se pudo hacer la copia de seguridad previa de «auth»: disk full\. «auth» no se ha modificado en «Local»\./
    )
    expect(timeline).toEqual(['create:auth'])
    expect(sessions.executed).toEqual([])
    expect(backups.restores).toEqual([])
    expect(lines.join('\n')).toMatch(/Copia previa de auth \.+ +ERROR: disk full/)
  })

  it('verifies the source before touching anything: missing file or another schema aborts', async () => {
    sessions.schemas.set(local.id, new Set(['auth']))
    await expect(run({ backupPath: '/nope/missing.nb3' })).rejects.toThrow(
      /No se encontró el archivo de la copia.*«auth» no se ha modificado/
    )
    await expect(run({ expectedSchema: 'billing' })).rejects.toThrow(
      /contiene la base de datos «auth», no «billing»/
    )
    expect(timeline).toEqual([])
  })

  it('creates a missing database without a safety backup', async () => {
    const result = await run()
    expect(timeline).toEqual([
      'CREATE DATABASE `auth` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
      'restore:auth'
    ])
    expect(result.existed).toBe(false)
    expect(result.safetyBackup).toBeNull()
    expect(lines).toContain('  «auth» no existe en Local: se creará')
  })

  it('replaces without a copy when the safety backup is off, and uses the server default charset when unknown', async () => {
    sessions.schemas.set(local.id, new Set(['auth']))
    deps.backupCharset = async () => null
    await run({ safetyBackup: false })
    expect(timeline).toEqual(['DROP DATABASE `auth`', 'CREATE DATABASE `auth`', 'restore:auth'])
    expect(lines).toContain('  Copia previa desactivada: «auth» se reemplaza sin copia')
  })

  it('refuses a production target without confirmation, before any read or write', async () => {
    const prod = connections.save({ ...connectionInput('Prod'), environment: 'production' })
    await expect(run({ connectionId: prod.id })).rejects.toThrow(REPLACE_PRODUCTION_MESSAGE)
    expect(timeline).toEqual([])
    await run({ connectionId: prod.id, confirmProduction: true })
    expect(backups.restores[0].confirmProduction).toBe(true)
  })

  it('reads the whole backup before touching anything: a damaged data chunk aborts with no safety copy and no DROP', async () => {
    sessions.schemas.set(local.id, new Set(['auth']))
    backups.corrupt.set(
      BACKUP,
      'La copia de seguridad está dañada: la suma de verificación de AAAA.data.00000.sql.gz no coincide'
    )
    await expect(run()).rejects.toThrow(
      /No se puede usar la copia .*suma de verificación .* no coincide\. «auth» no se ha modificado en «Local»\./
    )
    expect(backups.verified).toEqual([BACKUP])
    expect(backups.calls).toEqual([])
    expect(timeline).toEqual([])
    expect(sessions.executed).toEqual([])
    expect(lines.join('\n')).toMatch(
      /Comprobar integridad de la copia \.+ +ERROR: La copia de seguridad está dañada/
    )
  })

  it('logs the integrity check before the safety copy and the DROP', async () => {
    sessions.schemas.set(local.id, new Set(['auth']))
    await run()
    const integrity = lines.findIndex((l) =>
      /Comprobar integridad de la copia \.+ +3 filas {2}OK/.test(l)
    )
    const safety = lines.findIndex((l) => /Copia previa de auth/.test(l))
    expect(integrity).toBeGreaterThanOrEqual(0)
    expect(integrity).toBeLessThan(safety)
  })

  it.each(['mysql', 'sys', 'performance_schema', 'information_schema', 'MySQL'])(
    'never replaces the system database %s (refused before any read or write)',
    async (schema) => {
      sessions.schemas.set(local.id, new Set([schema]))
      await expect(run({ targetSchema: schema })).rejects.toThrow(/base de datos del sistema/)
      expect(backups.verified).toEqual([])
      expect(timeline).toEqual([])
      expect(sessions.executed).toEqual([])
    }
  )

  it('a restore that fails after the DROP says the database is incomplete and where its safety copy is', async () => {
    sessions.schemas.set(local.id, new Set(['auth']))
    backups.restore = async () => {
      throw new Error('Lost connection to MySQL server during query')
    }
    const err = await run().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ReplaceIncompleteError)
    const message = (err as Error).message
    expect(message).toMatch(
      /^No se pudo terminar de restaurar «auth»: Lost connection .*\. «auth» ha quedado incompleta en «Local»\. Para volver al estado anterior restaura la copia previa auth-previo-rollback\.nb3 \(Copias de seguridad › Local › auth\)/
    )
    expect((err as ReplaceIncompleteError).safetyBackupPath).toContain('auth-previo-rollback')
  })

  it('without a safety copy the incomplete message says there is none', async () => {
    sessions.schemas.set(local.id, new Set(['auth']))
    backups.restore = async () => {
      throw new Error('boom')
    }
    await expect(run({ safetyBackup: false })).rejects.toThrow(
      /«auth» ha quedado incompleta en «Local»\. No había copia previa/
    )
  })

  it('a DROP that succeeds but a CREATE that fails is reported as incomplete too', async () => {
    sessions.schemas.set(local.id, new Set(['auth']))
    sessions.failing.set(
      'CREATE DATABASE `auth` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
      'Access denied'
    )
    await expect(run()).rejects.toThrow(
      /No se pudo crear de nuevo «auth» después de borrarla: Access denied.*ha quedado incompleta/
    )
  })

  it('does nothing when cancelled before it starts', async () => {
    sessions.schemas.set(local.id, new Set(['auth']))
    const controller = new AbortController()
    controller.abort()
    await expect(replaceSchemaFromBackup(deps, request(), {}, controller.signal)).rejects.toThrow(
      /cancelada/
    )
    expect(timeline).toEqual([])
  })
})

describe('readBackupCharset', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-charset-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function write(name: string, ddls: string[]): Promise<string> {
    const writer = await Nb3Writer.create(join(dir, name), { schema: 'auth' })
    for (const [i, ddl] of ddls.entries())
      await writer.beginObject('Table', `t${i}`).finish({ ddl })
    await writer.beginObject('View', 'v').finish({ ddl: 'CREATE VIEW `v` AS select 1' })
    return (await writer.finish()).path
  }

  it('picks the most common table default (8.x DDL with COLLATE)', async () => {
    const path = await write('a.nb3', [
      'CREATE TABLE `t0` (`id` int) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
      'CREATE TABLE `t1` (`id` int) ENGINE=InnoDB DEFAULT CHARSET=latin1',
      'CREATE TABLE `t2` (`id` int) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci'
    ])
    expect(await readBackupCharset(path)).toEqual({
      charset: 'utf8mb4',
      collation: 'utf8mb4_0900_ai_ci'
    })
  })

  it('keeps a 5.7 charset without collation, and returns null without tables', async () => {
    const path = await write('b.nb3', [
      'CREATE TABLE `t0` (`id` int(11)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    ])
    expect(await readBackupCharset(path)).toEqual({ charset: 'utf8mb4', collation: null })
    // The Navicat fixture's tables carry no table options.
    expect(await readBackupCharset(FIXTURE)).toBeNull()
  })
})

describe('integrity of a real .nb3 before replacing (regression: damaged data chunk)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-integrity-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function backupWithRows(): Promise<string> {
    const writer = await Nb3Writer.create(join(dir, 'src.nb3'), { schema: 'auth' })
    for (const name of ['a', 'b']) {
      const t = writer.beginObject('Table', name)
      for (let i = 0; i < 2000; i++) await t.addRow(`(${i}, 'row ${i} of ${name}')`)
      await t.finish({ ddl: `CREATE TABLE \`${name}\` (id int, v text)`, fields: ['id', 'v'] })
    }
    return (await writer.finish()).path
  }

  it('the manifest still opens but the full check refuses it, and replace never reaches the server', async () => {
    const path = await backupWithRows()
    expect((await verifyBackupFile(path)).rows).toBe(4000)
    // Overwrite bytes in the middle of the first data chunk.
    const chunk = (await indexTar(path)).find((e) => e.name.endsWith('.data.00000.sql.gz'))!
    const fd = openSync(path, 'r+')
    writeSync(fd, Buffer.alloc(16, 0x5a), 0, 16, chunk.offset + Math.floor(chunk.size / 2))
    closeSync(fd)
    expect((await readManifest(path)).schema).toBe('auth')
    await expect(verifyBackupFile(path)).rejects.toThrow(/La copia de seguridad está dañada/)

    const timeline: string[] = []
    const connections = new ConnectionsRepo(dir)
    const local = connections.save(connectionInput('Local'))
    const sessions = fakeSessionFactory(timeline)
    sessions.schemas.set(local.id, new Set(['auth']))
    const backups = fakeBackupService(dir, timeline)
    backups.readMeta = (p) => readManifest(p)
    backups.verify = (p, signal) => verifyBackupFile(p, signal)
    await expect(
      replaceSchemaFromBackup(
        { connections, sessions, backups, backupCharset: async () => null },
        {
          backupPath: path,
          expectedSchema: 'auth',
          connectionId: local.id,
          targetSchema: 'auth',
          safetyBackup: false,
          continueOnError: false
        }
      )
    ).rejects.toThrow(/La copia de seguridad está dañada.*«auth» no se ha modificado en «Local»/)
    expect(timeline).toEqual([])
    expect(sessions.executed).toEqual([])
  })
})
