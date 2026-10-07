import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { Environment, ProgressEvent } from '@shared/types'
import type { AppContext } from '../context'
import {
  NAVICAT_DELETE_MESSAGE,
  OUTSIDE_DELETE_MESSAGE,
  createBackupHandlers,
  deleteBackupFile
} from './handlers'
import { createBackupService, readBackupMeta, type BackupService } from './index'
import { getIndexCache } from './indexCache'
import { FakeSessionFactory, connectionFixture, connectionsOf } from './testing/fakeSession'

const FIXTURE = resolve('tests/fixtures/navicat/backups/demo/20260317144801-fixture.nb3')

describe('backup handlers', () => {
  let root: string
  let own: string
  let navicat: string
  let ctx: AppContext
  let events: ProgressEvent[]
  let typed: Environment[]

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vortaq-handlers-'))
    own = join(root, 'own')
    navicat = join(root, 'navicat')
    mkdirSync(join(own, 'demo'), { recursive: true })
    mkdirSync(join(navicat, 'demo'), { recursive: true })
    events = []
    typed = ['production']
    ctx = {
      settings: { get: () => ({ typedConfirmEnvironments: typed }) },
      userDataPath: join(root, 'userData'),
      connections: connectionsOf(
        connectionFixture({ backupDir: own, extraBackupDirs: [navicat] }),
        connectionFixture({ id: 'prod', environment: 'production', backupDir: join(root, 'prod') }),
        connectionFixture({ id: 'stg', name: 'Pre', environment: 'staging' })
      ),
      emit: <E extends IpcEventChannel>(channel: E, payload: IpcEventMap[E]) => {
        if (channel === 'event:progress') events.push(payload as ProgressEvent)
      }
    } as unknown as AppContext
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const handlersWith = (service: BackupService) => createBackupHandlers(ctx, async () => service)

  describe('delete guard', () => {
    it('deletes files inside a connection backupDir and forgets the cache entry', async () => {
      const path = join(own, 'demo', '20260101000000.nb3')
      copyFileSync(FIXTURE, path)
      await readBackupMeta(ctx.userDataPath, path)
      const s = statSync(path)
      expect(
        getIndexCache(ctx.userDataPath).get(path, { size: s.size, mtimeMs: s.mtimeMs })
      ).not.toBeNull()
      await deleteBackupFile(ctx.connections.list(), ctx.userDataPath, path)
      expect(existsSync(path)).toBe(false)
      expect(
        getIndexCache(ctx.userDataPath).get(path, { size: s.size, mtimeMs: s.mtimeMs })
      ).toBeNull()
    })

    it("refuses Navicat's own files, even through a symlink inside backupDir", async () => {
      const path = join(navicat, 'demo', '20260101000000.nb3')
      writeFileSync(path, 'x')
      const h = handlersWith({} as BackupService)
      await expect(h.delete(path)).rejects.toThrow(NAVICAT_DELETE_MESSAGE)
      symlinkSync(path, join(own, 'demo', 'link.nb3'))
      await expect(h.delete(join(own, 'demo', 'link.nb3'))).rejects.toThrow(NAVICAT_DELETE_MESSAGE)
      expect(existsSync(path)).toBe(true)
    })

    it('refuses paths outside every backupDir, traversal and non-.nb3 files', async () => {
      const outside = join(root, 'elsewhere.nb3')
      writeFileSync(outside, 'x')
      const h = handlersWith({} as BackupService)
      await expect(h.delete(outside)).rejects.toThrow(OUTSIDE_DELETE_MESSAGE)
      await expect(h.delete(join(own, '..', 'elsewhere.nb3'))).rejects.toThrow(
        OUTSIDE_DELETE_MESSAGE
      )
      await expect(h.delete(join(own, 'demo', 'x.sql'))).rejects.toThrow(/no es un backup/)
      await expect(h.delete('relative/x.nb3')).rejects.toThrow(/absoluta/)
      expect(existsSync(outside)).toBe(true)
    })
  })

  it('objectDdl joins DDL, index and trigger DDL', async () => {
    const h = handlersWith({} as BackupService)
    const ddl = await h.objectDdl(FIXTURE, '11111111-1111-4111-8111-111111111111')
    expect(ddl).toMatch(/^CREATE TABLE `account`/)
  })

  it('meta is cached by path|size|mtime', async () => {
    const path = join(own, 'demo', '20260101000000.nb3')
    copyFileSync(FIXTURE, path)
    const h = handlersWith({} as BackupService)
    const first = await h.meta(path)
    expect(first.objects).toHaveLength(3)
    const s = statSync(path)
    getIndexCache(ctx.userDataPath).set(
      path,
      { size: s.size, mtimeMs: s.mtimeMs },
      { ...first, comment: 'desde caché' }
    )
    expect((await h.meta(path)).comment).toBe('desde caché')
  })

  it('create forwards progress with operationId and a final done event', async () => {
    const service = createBackupService(
      ctx,
      new FakeSessionFactory({
        tables: [{ name: 't', columns: [{ name: 'id', columnType: 'int' }], rows: [[1]] }]
      })
    )
    const h = handlersWith(service)
    const result = await h.create('op-1', {
      connectionId: 'conn-1',
      schema: 'demo',
      includeData: true
    })
    expect(result.rows).toBe(1)
    expect(events.every((e) => e.operationId === 'op-1' && e.kind === 'backup')).toBe(true)
    expect(events.filter((e) => e.done)).toHaveLength(1)
    expect(events[events.length - 1]).toMatchObject({ done: true, phase: 'done' })
    expect(h.running()).toEqual([])
  })

  it('restore emits done:true with the error when it fails (production guard)', async () => {
    const service = createBackupService(ctx, new FakeSessionFactory())
    const h = handlersWith(service)
    await expect(
      h.restore('op-2', {
        backupPath: FIXTURE,
        connectionId: 'prod',
        targetSchema: 'x',
        createSchema: true,
        dropObjectsFirst: false,
        includeStructure: true,
        includeData: true,
        continueOnError: false
      })
    ).rejects.toThrow(/producción/)
    expect(events).toEqual([
      expect.objectContaining({
        operationId: 'op-2',
        kind: 'restore',
        done: true,
        error: expect.stringMatching(/producción/)
      })
    ])
  })

  describe('typed confirmation of Ajustes › Seguridad', () => {
    const restoreTo = (h: ReturnType<typeof handlersWith>, op: string, extra = {}) =>
      h.restore(op, {
        backupPath: FIXTURE,
        connectionId: 'stg',
        targetSchema: 'x',
        createSchema: true,
        dropObjectsFirst: false,
        includeStructure: true,
        includeData: true,
        continueOnError: false,
        ...extra
      })
    const okService = (calls: string[]) =>
      ({
        restore: async () => {
          calls.push('restore')
          return { objectsRestored: 1, rowsInserted: 0, errors: [], durationMs: 1 }
        }
      }) as unknown as BackupService

    it('refuses an unconfirmed restore on a staging connection when staging is listed', async () => {
      typed = ['production', 'staging']
      const calls: string[] = []
      await expect(restoreTo(handlersWith(okService(calls)), 'op-s1')).rejects.toThrow(
        /«Pre» \(entorno Staging\) necesita confirmación explícita/
      )
      expect(calls).toEqual([])
      expect(events.at(-1)).toMatchObject({ operationId: 'op-s1', done: true, phase: 'error' })
    })

    it('restores on staging once confirmed, or when staging is not listed', async () => {
      typed = ['production', 'staging']
      const calls: string[] = []
      await restoreTo(handlersWith(okService(calls)), 'op-s2', { confirmProduction: true })
      typed = ['production']
      await restoreTo(handlersWith(okService(calls)), 'op-s3')
      expect(calls).toEqual(['restore', 'restore'])
    })

    it('production stays guarded even when the settings file leaves it out', async () => {
      typed = []
      const calls: string[] = []
      await expect(
        restoreTo(handlersWith(okService(calls)), 'op-s4', { connectionId: 'prod' })
      ).rejects.toThrow(/producción/)
      expect(calls).toEqual([])
    })
  })

  it('restore with replaceSchema replaces the whole database (undo of a rollback) through service.replace', async () => {
    const replaced: unknown[] = []
    const service = {
      readMeta: async () => ({ schema: 'demo' }),
      restore: async () => {
        throw new Error('objects restore must not be used')
      },
      replace: async (request: unknown, hooks: { progress?: (s: string, e: unknown) => void }) => {
        replaced.push(request)
        hooks.progress?.('safety', {
          phase: 'object',
          current: 0,
          total: 1,
          message: 'demo',
          done: false
        })
        return {
          existed: true,
          connectionName: 'Local',
          safetyBackup: {
            path: '/b/demo/x-previo-rollback.nb3',
            sizeBytes: 1,
            objects: 1,
            rows: 1,
            durationMs: 1
          },
          charset: null,
          restore: { objectsRestored: 2, rowsInserted: 5, errors: [], durationMs: 3 }
        }
      }
    } as unknown as BackupService
    const h = handlersWith(service)
    const result = await h.restore('op-r', {
      backupPath: FIXTURE,
      connectionId: 'conn-1',
      targetSchema: 'demo',
      createSchema: true,
      dropObjectsFirst: true,
      includeStructure: false,
      includeData: true,
      objects: ['ignored'],
      continueOnError: false,
      replaceSchema: true,
      safetyBackup: true
    })
    expect(replaced).toEqual([
      {
        backupPath: FIXTURE,
        expectedSchema: 'demo',
        connectionId: 'conn-1',
        targetSchema: 'demo',
        safetyBackup: true,
        continueOnError: false,
        includeData: true
      }
    ])
    expect(result).toMatchObject({
      objectsRestored: 2,
      safetyBackupPath: '/b/demo/x-previo-rollback.nb3'
    })
    expect(events[0]).toMatchObject({ operationId: 'op-r', message: 'Copia previa · demo' })
    expect(events.at(-1)).toMatchObject({ done: true, phase: 'done' })
  })

  it('restore with replaceSchema and includeData false asks service.replace for «Solo estructura»', async () => {
    const replaced: { includeData?: boolean }[] = []
    const service = {
      readMeta: async () => ({ schema: 'demo' }),
      replace: async (request: { includeData?: boolean }) => {
        replaced.push(request)
        return {
          existed: false,
          connectionName: 'Local',
          safetyBackup: null,
          charset: null,
          includeData: false,
          restore: {
            objectsRestored: 4,
            rowsInserted: 0,
            errors: [],
            durationMs: 3,
            structureOnly: true
          }
        }
      }
    } as unknown as BackupService
    const result = await handlersWith(service).restore('op-s', {
      backupPath: FIXTURE,
      connectionId: 'conn-1',
      targetSchema: 'demo',
      createSchema: true,
      dropObjectsFirst: true,
      includeStructure: true,
      includeData: false,
      continueOnError: false,
      replaceSchema: true,
      safetyBackup: true
    })
    expect(replaced[0].includeData).toBe(false)
    expect(result).toMatchObject({ rowsInserted: 0, structureOnly: true })
    expect(events.at(-1)).toMatchObject({
      done: true,
      message: 'Restauración completada · Solo estructura: 4 objetos, 0 filas'
    })
  })

  it('replaceSchema on production still needs confirmProduction (real service, nothing touched)', async () => {
    const sessions = new FakeSessionFactory()
    const service = createBackupService(ctx, sessions)
    const h = handlersWith(service)
    await expect(
      h.restore('op-rp', {
        backupPath: FIXTURE,
        connectionId: 'prod',
        targetSchema: 'demo',
        createSchema: false,
        dropObjectsFirst: false,
        includeStructure: true,
        includeData: true,
        continueOnError: false,
        replaceSchema: true
      })
    ).rejects.toThrow(/producción/)
  })

  it('restore that resolves with object errors flags the final event as an error', async () => {
    const service = {
      restore: async () => ({
        objectsRestored: 0,
        rowsInserted: 0,
        errors: [{ object: 'items', message: 'boom' }],
        durationMs: 1
      })
    } as unknown as BackupService
    const h = handlersWith(service)
    const result = await h.restore('op-4', {
      backupPath: FIXTURE,
      connectionId: 'conn-1',
      targetSchema: 'x',
      createSchema: true,
      dropObjectsFirst: false,
      includeStructure: true,
      includeData: true,
      continueOnError: false
    })
    expect(result.errors).toHaveLength(1)
    expect(events[events.length - 1]).toMatchObject({
      operationId: 'op-4',
      done: true,
      phase: 'error',
      error: 'items: boom'
    })
  })

  it('cancel aborts the running operation and rejects duplicate ids', async () => {
    const service = {
      create: (
        _o: unknown,
        progress: (e: Omit<ProgressEvent, 'operationId' | 'kind'>) => void,
        signal: AbortSignal
      ) =>
        new Promise((_resolve, reject) => {
          progress({ phase: 'object', current: 0, total: 1, message: 'x', done: false })
          signal.addEventListener('abort', () => reject(new Error('Backup cancelado')))
        })
    } as unknown as BackupService
    const h = handlersWith(service)
    const pending = h.create('op-3', { connectionId: 'conn-1', schema: 'demo', includeData: true })
    await new Promise((r) => setTimeout(r, 0))
    await expect(
      h.create('op-3', { connectionId: 'conn-1', schema: 'demo', includeData: true })
    ).rejects.toThrow(/en curso/)
    expect(h.running()).toEqual(['op-3'])
    await h.cancel('op-3')
    await expect(pending).rejects.toThrow('Backup cancelado')
    expect(events[events.length - 1]).toMatchObject({
      operationId: 'op-3',
      done: true,
      phase: 'cancelled'
    })
    await h.cancel('unknown')
  })
})
