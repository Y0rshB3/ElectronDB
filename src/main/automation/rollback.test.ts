import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JobRun } from '@shared/types'
import { MANUAL_ROLLBACKS_JOB_ID } from '@shared/backupPackages'
import {
  buildAnyRollbackPlan,
  buildRollbackPlan,
  prepareRollback,
  type RollbackInspector
} from './rollback'
import { markInterrupted } from './recovery'
import { SettingsRepo } from '../storage/repos'
import { runJob, startJobWith, type RunnerDeps } from './runner'
import {
  backupTask,
  connectionInput,
  fakeBackupService,
  fakeSessionFactory,
  jobInput,
  makeContext,
  queryTask,
  restoreTask,
  type FakeBackupService,
  type FakeSessionFactory,
  type TestContext
} from './testSupport'

describe('rollback of a run («Restaurar todo en Local»)', () => {
  let t: TestContext
  let timeline: string[]
  let backups: FakeBackupService
  let sessions: FakeSessionFactory
  let deps: RunnerDeps
  let stagingId: string
  let localId: string
  let prodId: string
  let inspector: RollbackInspector

  beforeEach(() => {
    t = makeContext()
    timeline = []
    backups = fakeBackupService(t.dir, timeline)
    sessions = fakeSessionFactory(timeline)
    deps = { backups, sessions, backupCharset: async () => null }
    stagingId = t.ctx.connections.save({ ...connectionInput('Staging'), environment: 'staging' }).id
    localId = t.ctx.connections.save(connectionInput('Local')).id
    prodId = t.ctx.connections.save({ ...connectionInput('Prod'), environment: 'production' }).id
    backups.objects.set('auth', [
      { type: 'Table', name: 'users', rows: 10 },
      { type: 'View', name: 'v_users' }
    ])
    backups.objects.set('crm', [{ type: 'Table', name: 'clients', rows: 4 }])
    sessions.schemas.set(localId, new Set(['auth', 'sys']))
    inspector = {
      readMeta: (path) => backups.readMeta(path),
      fileSize: async () => 2048,
      targetSchemas: async (id) => [...(sessions.schemas.get(id) ?? [])]
    }
  })
  afterEach(() => t.cleanup())

  async function stagingRun(): Promise<JobRun> {
    const job = t.ctx.jobs.save(
      jobInput(
        'Backup staging',
        [
          backupTask('b1', stagingId, 'auth'),
          queryTask('q1', stagingId, 'auth', 'SELECT 1'),
          backupTask('b2', stagingId, 'crm')
        ],
        { continueOnError: true }
      )
    )
    return runJob(t.ctx, deps, job.id, 'manual')
  }

  it('flags copies of another engine and that engine’s system databases', async () => {
    const run = await stagingRun()
    const mongoId = t.ctx.connections.save({
      ...connectionInput('Mongo local'),
      engine: 'mongodb'
    }).id
    // A MySQL copy cannot go into MongoDB.
    const plan = await buildRollbackPlan(t.ctx, run.id, mongoId, {
      ...inspector,
      targetSchemas: async () => []
    })
    expect(plan.items.map((i) => i.problem)).toEqual([
      'Es una copia de MySQL/MariaDB y «Mongo local» es MongoDB: una copia solo se restaura en una conexión del mismo motor.',
      'Es una copia de MySQL/MariaDB y «Mongo local» es MongoDB: una copia solo se restaura en una conexión del mismo motor.'
    ])
  })

  it('plans one database per backup step, flagging which ones will be replaced', async () => {
    const run = await stagingRun()
    expect(run.tasks[0]).toMatchObject({
      type: 'backupschema',
      connectionId: stagingId,
      schema: 'auth'
    })
    const plan = await buildRollbackPlan(t.ctx, run.id, localId, inspector)
    expect(plan).toMatchObject({ runId: run.id, jobName: 'Backup staging', targetError: null })
    expect(plan.items).toEqual([
      expect.objectContaining({
        taskId: 'b1',
        schema: 'auth',
        targetSchema: 'auth',
        sourceConnectionName: 'Staging',
        backupPath: run.tasks[0].outputPath,
        sizeBytes: 2048,
        targetExists: true,
        problem: null
      }),
      expect.objectContaining({ taskId: 'b2', schema: 'crm', targetExists: false, problem: null })
    ])
  })

  it('reports an unreachable target and integrity problems per database', async () => {
    const run = await stagingRun()
    backups.files.set(run.tasks[2].outputPath!, 'other')
    inspector.targetSchemas = async () => {
      throw new Error('connect ECONNREFUSED')
    }
    const plan = await buildRollbackPlan(t.ctx, run.id, localId, inspector)
    expect(plan.targetError).toMatch(/No se pudo consultar «Local»: connect ECONNREFUSED/)
    expect(plan.items[0].targetExists).toBeNull()
    expect(plan.items[1].problem).toMatch(/contiene la base de datos «other», no «crm»/)
    backups.files.delete(run.tasks[0].outputPath!)
    const again = await buildRollbackPlan(t.ctx, run.id, null, inspector)
    expect(again.items[0].problem).toMatch(/No se encontró el archivo/)
  })

  it('refuses runs without backups, live runs and rollback runs', async () => {
    const job = t.ctx.jobs.save(jobInput('SQL', [queryTask('q1', localId, 'auth', 'SELECT 1')]))
    const sqlRun = await runJob(t.ctx, deps, job.id, 'manual')
    await expect(buildRollbackPlan(t.ctx, sqlRun.id, localId, inspector)).rejects.toThrow(
      /no generó ninguna copia/
    )
    t.ctx.runs.upsert({ ...sqlRun, id: 'live', status: 'running' })
    await expect(buildRollbackPlan(t.ctx, 'live', localId, inspector)).rejects.toThrow(/en curso/)
    t.ctx.runs.upsert({ ...sqlRun, id: 'rb', kind: 'rollback' })
    await expect(buildRollbackPlan(t.ctx, 'rb', localId, inspector)).rejects.toThrow(
      /ya es una restauración/
    )
  })

  it('restores the run: safety backup -> drop -> create -> restore per database, logged like a job', async () => {
    const run = await stagingRun()
    timeline.length = 0
    const plan = await buildRollbackPlan(t.ctx, run.id, localId, inspector)
    const target = t.ctx.connections.get(localId)!
    const prepared = prepareRollback(
      t.ctx,
      plan,
      { runId: run.id, targetConnectionId: localId, taskIds: ['b1', 'b2'], safetyBackup: true },
      target,
      false
    )
    expect(prepared.job.name).toBe('Restaurar todo en Local · Backup staging')
    expect(prepared.options).toMatchObject({ kind: 'rollback', rollbackOf: run.id })
    const started = startJobWith(t.ctx, deps, prepared.job, 'manual', prepared.options)
    expect(started.run).toMatchObject({ kind: 'rollback', rollbackOf: run.id, jobId: run.jobId })
    const final = await started.done
    expect(final.status).toBe('success')
    expect(timeline).toEqual([
      'create:auth',
      'DROP DATABASE `auth`',
      'CREATE DATABASE `auth`',
      'restore:auth',
      'CREATE DATABASE `crm`',
      'restore:crm'
    ])
    // The safety copy goes to the target connection with its own label; its path is the step output.
    expect(backups.calls.at(-1)).toMatchObject({ connectionId: localId, label: 'previo-rollback' })
    expect(final.tasks[0].outputPath).toContain('auth-previo-rollback')
    expect(final.tasks[1].outputPath).toBeNull()
    expect(backups.restores.map((r) => r.continueOnError)).toEqual([true, true])
    // The rollback does not count as a run of the job itself.
    expect(t.ctx.jobs.get(run.jobId)?.lastRunAt).toBe(run.startedAt)

    const bodies = readFileSync(final.logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(11))
    expect(bodies[0]).toMatch(
      /^Inicio de «Restaurar todo en Local · Backup staging» · .* · manual · 2 pasos$/
    )
    expect(bodies).toContain('Paso 1/2 · Base de datos auth: Staging -> Local')
    expect(bodies).toContain('Paso 2/2 · Base de datos crm: Staging -> Local')
    expect(bodies).toContainEqual(expect.stringMatching(/^ {2}Copia previa de auth \.+ .*OK$/))
    expect(bodies).toContainEqual(
      expect.stringMatching(/^ {2}Reemplazar base de datos auth \.+ +por defecto {2}OK$/)
    )
    expect(bodies).toContainEqual(expect.stringMatching(/^ {2}Crear base de datos crm \.+/))
    expect(bodies).toContainEqual(expect.stringMatching(/^ {2}Tabla users \.+ +10 filas {2}OK$/))
    expect(bodies).toContainEqual(expect.stringMatching(/^ {2}Vista v_users \.+ +OK$/))
    expect(bodies).toContainEqual(
      expect.stringMatching(/^ {2}Resultado: OK · 2 objetos · 10 filas · /)
    )
    expect(bodies.at(-1)).toBe('Finalizado correctamente: 2 de 2 pasos OK.')
  })

  it('«Solo estructura» (includeData false) replaces every database with empty tables and says so in the log', async () => {
    const run = await stagingRun()
    const plan = await buildRollbackPlan(t.ctx, run.id, localId, inspector)
    const prepared = prepareRollback(
      t.ctx,
      plan,
      {
        runId: run.id,
        targetConnectionId: localId,
        taskIds: ['b1', 'b2'],
        safetyBackup: true,
        includeData: false
      },
      t.ctx.connections.get(localId)!,
      false
    )
    expect(prepared.job.tasks.map((x) => x.includeData)).toEqual([false, false])
    const final = await startJobWith(t.ctx, deps, prepared.job, 'manual', prepared.options).done
    expect(final.status).toBe('success')
    const restores = backups.restores.slice(-2)
    expect(restores.map((r) => [r.includeData, r.skipAutoIncrement])).toEqual([
      [false, true],
      [false, true]
    ])
    // The safety copy of the database being replaced keeps its rows.
    expect(backups.calls.at(-1)).toMatchObject({ includeData: true, label: 'previo-rollback' })
    const bodies = readFileSync(final.logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(11))
    expect(bodies).toContain('Paso 1/2 · Base de datos auth: Staging -> Local (solo estructura)')
    expect(bodies).toContainEqual(expect.stringMatching(/^ {2}Contenido: solo estructura/))
    expect(bodies).toContainEqual(
      expect.stringMatching(/^ {2}Resultado: OK · Solo estructura: 2 objetos, 0 filas · /)
    )
    expect(bodies).toContain(
      '  Paso 1/2 · Base de datos auth: Staging -> Local (solo estructura): Solo estructura: 2 objetos, 0 filas'
    )
    expect(bodies.at(-1)).toBe('Finalizado correctamente: 2 de 2 pasos OK.')
  })

  it('a rollback request without includeData (older callers) restores structure and data', async () => {
    const run = await stagingRun()
    const plan = await buildRollbackPlan(t.ctx, run.id, localId, inspector)
    const prepared = prepareRollback(
      t.ctx,
      plan,
      { runId: run.id, targetConnectionId: localId, taskIds: ['b1'], safetyBackup: false },
      t.ctx.connections.get(localId)!,
      false
    )
    expect(prepared.job.tasks[0].includeData).toBe(true)
    await startJobWith(t.ctx, deps, prepared.job, 'manual', prepared.options).done
    expect(backups.restores.at(-1)).toMatchObject({ includeData: true })
    expect(backups.restores.at(-1)?.skipAutoIncrement).toBeUndefined()
  })

  it('skips a database whose safety backup fails (ERROR) and keeps going with the others', async () => {
    const run = await stagingRun()
    const plan = await buildRollbackPlan(t.ctx, run.id, localId, inspector)
    timeline.length = 0
    backups.failures.set('auth', 'Permission denied')
    const prepared = prepareRollback(
      t.ctx,
      plan,
      { runId: run.id, targetConnectionId: localId, taskIds: ['b1', 'b2'], safetyBackup: true },
      t.ctx.connections.get(localId)!,
      false
    )
    const final = await startJobWith(t.ctx, deps, prepared.job, 'manual', prepared.options).done
    expect(final.status).toBe('failed')
    expect(final.tasks.map((x) => x.status)).toEqual(['failed', 'success'])
    expect(final.tasks[0].message).toMatch(/copia de seguridad previa de «auth»: Permission denied/)
    // auth was never dropped.
    expect(timeline).toEqual(['create:auth', 'CREATE DATABASE `crm`', 'restore:crm'])
    const log = readFileSync(final.logPath, 'utf8')
    expect(log).toContain(
      '  ERROR · Paso 1/2 · Base de datos auth: Staging -> Local: No se pudo hacer'
    )
  })

  it('a partly restored database says so: failed objects, incomplete state and how to undo; the summary lists the safety copies', async () => {
    const run = await stagingRun()
    const plan = await buildRollbackPlan(t.ctx, run.id, localId, inspector)
    backups.restoreFailures.set(
      'v_users',
      'This function has none of DETERMINISTIC (ER_BINLOG_UNSAFE_ROUTINE 1418). Pista: activa log_bin_trust_function_creators.'
    )
    const prepared = prepareRollback(
      t.ctx,
      plan,
      { runId: run.id, targetConnectionId: localId, taskIds: ['b1', 'b2'], safetyBackup: true },
      t.ctx.connections.get(localId)!,
      false
    )
    const final = await startJobWith(t.ctx, deps, prepared.job, 'manual', prepared.options).done
    expect(final.tasks.map((x) => x.status)).toEqual(['failed', 'success'])
    const message = final.tasks[0].message!
    expect(message).toMatch(
      /^1 objeto con error al restaurar «auth»: v_users \(1 objeto, 10 filas restaurados\)\./
    )
    expect(message).toContain('Error en v_users: This function has none of DETERMINISTIC')
    expect(message).toContain('Pista: activa log_bin_trust_function_creators')
    expect(message).toContain('«auth» ha quedado incompleta en «Local».')
    expect(message).toContain(
      'Para volver al estado anterior restaura la copia previa auth-previo-rollback.nb3 (Copias de seguridad › Local › auth) con «Reemplazar la base de datos completa».'
    )
    const bodies = readFileSync(final.logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(11))
    const summary = bodies.slice(bodies.indexOf('Resumen'))
    expect(summary).toContainEqual(
      expect.stringMatching(
        /^ {2}ERROR · Paso 1\/2 · .*: 1 objeto con error al restaurar «auth»: v_users/
      )
    )
    expect(summary).toContain(
      '  Copias previas (para deshacer: Copias de seguridad › conexión › base de datos › Restaurar › «Reemplazar la base de datos completa»):'
    )
    expect(summary).toContain('    auth en Local: auth-previo-rollback.nb3')
  })

  it('cancelling after the DROP reports the database as incomplete with its safety copy', async () => {
    const run = await stagingRun()
    const plan = await buildRollbackPlan(t.ctx, run.id, localId, inspector)
    const prepared = prepareRollback(
      t.ctx,
      plan,
      { runId: run.id, targetConnectionId: localId, taskIds: ['b1', 'b2'], safetyBackup: true },
      t.ctx.connections.get(localId)!,
      false
    )
    const controller = new AbortController()
    backups.restore = async () => {
      controller.abort()
      throw new Error('Restauración cancelada')
    }
    timeline.length = 0
    const final = await startJobWith(t.ctx, deps, prepared.job, 'manual', {
      ...prepared.options,
      signal: controller.signal
    }).done
    expect(final.status).toBe('cancelled')
    expect(timeline).toEqual(['create:auth', 'DROP DATABASE `auth`', 'CREATE DATABASE `auth`'])
    expect(final.tasks[0].message).toMatch(
      /^Ejecución cancelada\. Restauración cancelada\. «auth» ha quedado incompleta en «Local»\. Para volver al estado anterior restaura la copia previa auth-previo-rollback\.nb3/
    )
    expect(final.tasks[1].message).toBe('Ejecución cancelada.')
    expect(readFileSync(final.logPath, 'utf8')).toContain(
      '    auth en Local: auth-previo-rollback.nb3'
    )
  })

  it('an interrupted restore step (app quit or crash) is closed with the same warning', async () => {
    const run = await stagingRun()
    const stale: JobRun = {
      ...run,
      id: 'rb-stale',
      kind: 'rollback',
      status: 'running',
      finishedAt: null,
      logPath: join(t.dir, 'rb-stale.log'),
      tasks: [
        {
          taskId: 'rollback-b1',
          referenceName: 'Base de datos auth: Staging -> Local',
          status: 'running',
          startedAt: run.startedAt,
          finishedAt: null,
          message: null,
          outputPath: join(t.dir, 'auth', '20261006000000-previo-rollback.nb3'),
          type: 'restoreschema',
          connectionId: localId,
          schema: 'auth'
        }
      ]
    }
    const closed = markInterrupted(t.ctx, stale, () => new Date())
    expect(closed.tasks[0].message).toMatch(
      /^Interrumpida: .* «auth» puede haber quedado incompleta en «Local»\. Para volver al estado anterior restaura la copia previa 20261006000000-previo-rollback\.nb3/
    )
    expect(readFileSync(stale.logPath, 'utf8')).toContain(
      '    auth en Local: 20261006000000-previo-rollback.nb3'
    )
  })

  it('never plans a system database and flags structure-only or empty copies', async () => {
    const job = t.ctx.jobs.save(
      jobInput('Sistema y estructura', [
        backupTask('b1', stagingId, 'mysql'),
        { ...backupTask('b2', stagingId, 'auth'), includeData: false },
        backupTask('b3', stagingId, 'crm')
      ])
    )
    backups.objects.set('crm', [{ type: 'Table', name: 'clients', rows: 0 }])
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    const plan = await buildRollbackPlan(t.ctx, run.id, localId, inspector)
    expect(plan.items[0].problem).toMatch(/«mysql» es una base de datos del sistema/)
    expect(plan.items[1]).toMatchObject({ structureOnly: true, objects: 2 })
    expect(plan.items[1].warning).toMatch(/solo de estructura .*«auth» en «Local» quedarán vacías/)
    expect(plan.items[2]).toMatchObject({ structureOnly: false, rows: 0 })
    expect(plan.items[2].warning).toMatch(/no tiene ninguna fila/)
    // Even a hand-made request cannot reach the DROP of a system database.
    expect(() =>
      prepareRollback(
        t.ctx,
        plan,
        { runId: run.id, targetConnectionId: localId, taskIds: ['b1'], safetyBackup: true },
        t.ctx.connections.get(localId)!,
        false
      )
    ).toThrow(/base de datos del sistema/)
  })

  it('needs a confirmed production target and refuses invalid selections', async () => {
    const run = await stagingRun()
    const plan = await buildRollbackPlan(t.ctx, run.id, prodId, inspector)
    const prod = t.ctx.connections.get(prodId)!
    const request = {
      runId: run.id,
      targetConnectionId: prodId,
      taskIds: ['b1'],
      safetyBackup: true
    }
    expect(() => prepareRollback(t.ctx, plan, request, prod, false)).toThrow(/producción/)
    const confirmed = prepareRollback(t.ctx, plan, request, prod, true)
    expect(confirmed.options.allowProductionRestore).toBe(true)
    expect(() => prepareRollback(t.ctx, plan, { ...request, taskIds: [] }, prod, true)).toThrow(
      /al menos una/
    )
    expect(() => prepareRollback(t.ctx, plan, { ...request, taskIds: ['zz'] }, prod, true)).toThrow(
      /ya no está/
    )
  })

  it('a listed staging target needs the typed confirmation; an unlisted one does not', async () => {
    const run = await stagingRun()
    const plan = await buildRollbackPlan(t.ctx, run.id, stagingId, inspector)
    const staging = t.ctx.connections.get(stagingId)!
    const request = {
      runId: run.id,
      targetConnectionId: stagingId,
      taskIds: ['b1'],
      safetyBackup: true
    }
    expect(
      prepareRollback(t.ctx, plan, request, staging, false).options.allowProductionRestore
    ).toBe(false)
    t.ctx.settings.update({ typedConfirmEnvironments: ['production', 'staging'] })
    expect(() => prepareRollback(t.ctx, plan, request, staging, false)).toThrow(
      /«Staging» es una conexión de entorno Staging: confirma el reemplazo escribiendo su nombre/
    )
    const confirmed = prepareRollback(t.ctx, plan, request, staging, true)
    expect(confirmed.options.allowProductionRestore).toBe(true)
    timeline.length = 0
    // Without the runner flag the listed target is never touched either.
    const final = await startJobWith(t.ctx, deps, confirmed.job, 'manual', {
      ...confirmed.options,
      allowProductionRestore: false
    }).done
    expect(final.status).toBe('failed')
    expect(final.tasks[0].message).toMatch(/entorno Staging/)
    expect(timeline).toEqual([])
  })

  it('production stays guarded when the settings file leaves it out', async () => {
    const run = await stagingRun()
    const plan = await buildRollbackPlan(t.ctx, run.id, prodId, inspector)
    writeFileSync(
      join(t.dir, 'settings.json'),
      JSON.stringify({ typedConfirmEnvironments: ['staging'] })
    )
    const ctx = { ...t.ctx, settings: new SettingsRepo(t.dir, t.dir) }
    const request = {
      runId: run.id,
      targetConnectionId: prodId,
      taskIds: ['b1'],
      safetyBackup: true
    }
    expect(() => prepareRollback(ctx, plan, request, ctx.connections.get(prodId)!, false)).toThrow(
      /producción/
    )
  })

  it('a rollback to production without the confirmation flag never touches the server', async () => {
    const run = await stagingRun()
    const plan = await buildRollbackPlan(t.ctx, run.id, prodId, inspector)
    const prepared = prepareRollback(
      t.ctx,
      plan,
      { runId: run.id, targetConnectionId: prodId, taskIds: ['b1'], safetyBackup: true },
      t.ctx.connections.get(prodId)!,
      true
    )
    timeline.length = 0
    // Simulate a caller that dropped the confirmation on the way to the runner.
    const final = await startJobWith(t.ctx, deps, prepared.job, 'manual', {
      ...prepared.options,
      allowProductionRestore: false
    }).done
    expect(final.status).toBe('failed')
    expect(final.tasks[0].message).toMatch(/producción/)
    expect(timeline).toEqual([])
  })
})

describe('restore steps inside a job', () => {
  let t: TestContext
  let timeline: string[]
  let backups: FakeBackupService
  let sessions: FakeSessionFactory
  let deps: RunnerDeps

  beforeEach(() => {
    t = makeContext()
    timeline = []
    backups = fakeBackupService(t.dir, timeline)
    sessions = fakeSessionFactory(timeline)
    deps = { backups, sessions, backupCharset: async () => null }
    backups.objects.set('auth', [{ type: 'Table', name: 'users', rows: 2 }])
  })
  afterEach(() => t.cleanup())

  it('«Staging -> Local»: backs up each schema, then restores it with the same name', async () => {
    const staging = t.ctx.connections.save({
      ...connectionInput('Staging'),
      environment: 'staging'
    })
    const local = t.ctx.connections.save(connectionInput('Local'))
    sessions.schemas.set(local.id, new Set(['auth']))
    const job = t.ctx.jobs.save(
      jobInput('Staging -> Local', [
        backupTask('b1', staging.id, 'auth'),
        {
          id: 'r1',
          type: 'restoreschema',
          connectionId: local.id,
          schema: '',
          referenceName: 'Restaurar auth',
          restoreSource: { kind: 'task', taskId: 'b1' },
          safetyBackup: true
        }
      ])
    )
    const run = await runJob(t.ctx, deps, job.id, 'schedule')
    expect(run.status).toBe('success')
    expect(timeline).toEqual([
      'create:auth',
      'create:auth',
      'DROP DATABASE `auth`',
      'CREATE DATABASE `auth`',
      'restore:auth'
    ])
    expect(backups.calls.map((c) => c.connectionId)).toEqual([staging.id, local.id])
    expect(run.tasks[1]).toMatchObject({ type: 'restoreschema', schema: 'auth' })
    const log = readFileSync(run.logPath, 'utf8')
    expect(log).toContain('Paso 2/2 · Base de datos auth: Staging -> Local')
  })

  it('refuses at run time a restore step whose target became production', async () => {
    const staging = t.ctx.connections.save({
      ...connectionInput('Staging'),
      environment: 'staging'
    })
    const target = t.ctx.connections.save(connectionInput('Antes local'))
    const job = t.ctx.jobs.save(
      jobInput('Programada', [
        backupTask('b1', staging.id, 'auth'),
        {
          id: 'r1',
          type: 'restoreschema',
          connectionId: target.id,
          schema: '',
          referenceName: 'Restaurar auth',
          restoreSource: { kind: 'task', taskId: 'b1' }
        }
      ])
    )
    t.ctx.connections.save({ ...target, environment: 'production' })
    timeline.length = 0
    const run = await runJob(t.ctx, deps, job.id, 'cli')
    expect(run.tasks.map((x) => x.status)).toEqual(['success', 'failed'])
    expect(run.tasks[1].message).toMatch(/no pueden escribir en producción/)
    expect(timeline).toEqual(['create:auth'])
  })

  it('refuses a scheduled restore step into an environment listed in Ajustes › Seguridad, naming it', async () => {
    const local = t.ctx.connections.save(connectionInput('Local'))
    const staging = t.ctx.connections.save({
      ...connectionInput('Pre'),
      environment: 'staging'
    })
    const job = t.ctx.jobs.save(
      jobInput('Local -> Pre', [
        backupTask('b1', local.id, 'auth'),
        {
          id: 'r1',
          type: 'restoreschema',
          connectionId: staging.id,
          schema: '',
          referenceName: 'Restaurar auth',
          restoreSource: { kind: 'task', taskId: 'b1' }
        }
      ])
    )
    // Not listed: the restore runs as before.
    const ok = await runJob(t.ctx, deps, job.id, 'schedule')
    expect(ok.status).toBe('success')
    t.ctx.settings.update({ typedConfirmEnvironments: ['production', 'staging'] })
    timeline.length = 0
    for (const kind of ['schedule', 'cli', 'manual'] as const) {
      const run = await runJob(t.ctx, deps, job.id, kind)
      expect(run.tasks.map((x) => x.status)).toEqual(['success', 'failed'])
      expect(run.tasks[1].message).toMatch(/«Pre», una conexión de entorno Staging/)
      expect(run.tasks[1].message).not.toMatch(/producción/)
    }
    // Only the backups ran: nothing was dropped or restored on «Pre».
    expect(timeline.every((x) => x === 'create:auth')).toBe(true)
  })

  it('«latest» restores the newest COMPLETE job backup of that connection, never structure-only, other-connection or manual files', async () => {
    const staging = t.ctx.connections.save({
      ...connectionInput('Staging'),
      environment: 'staging'
    })
    const other = t.ctx.connections.save(connectionInput('Otra'))
    const local = t.ctx.connections.save(connectionInput('Local'))
    // 1) full backup of staging.auth, 2) later structure-only one, 3) later one of another connection.
    const full = t.ctx.jobs.save(jobInput('Completa', [backupTask('b1', staging.id, 'auth')]))
    const struct = t.ctx.jobs.save(
      jobInput('Estructura', [{ ...backupTask('b1', staging.id, 'auth'), includeData: false }])
    )
    const foreign = t.ctx.jobs.save(jobInput('Otra conexión', [backupTask('b1', other.id, 'auth')]))
    const fullRun = await runJob(t.ctx, deps, full.id, 'manual')
    await new Promise((r) => setTimeout(r, 5))
    const structRun = await runJob(t.ctx, deps, struct.id, 'manual')
    await new Promise((r) => setTimeout(r, 5))
    const foreignRun = await runJob(t.ctx, deps, foreign.id, 'manual')
    expect(structRun.tasks[0].includeData).toBe(false)
    for (const r of [fullRun, structRun, foreignRun]) writeFileSync(r.tasks[0].outputPath!, '')
    // A newer manual/Navicat file in the folder is not a job output: ignored.
    backups.listed.set(`${staging.id}:auth`, [
      {
        path: join(t.dir, '20991231000000-manual.nb3'),
        fileName: '20991231000000-manual.nb3',
        connectionId: staging.id,
        schema: 'auth',
        sizeBytes: 1,
        createdAt: '2099-12-31T00:00:00.000Z',
        modifiedAt: '2099-12-31T00:00:00.000Z',
        source: 'electrondb',
        label: 'manual'
      }
    ])
    const job = t.ctx.jobs.save(
      jobInput('Última', [
        {
          id: 'r1',
          type: 'restoreschema',
          connectionId: local.id,
          schema: '',
          referenceName: 'Restaurar auth',
          restoreSource: { kind: 'latest', connectionId: staging.id, schema: 'auth' },
          safetyBackup: true
        }
      ])
    )
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.status).toBe('success')
    expect(backups.restores[0].backupPath).toBe(fullRun.tasks[0].outputPath)
    expect(readFileSync(run.logPath, 'utf8')).toContain(
      'Copia más reciente con datos: tarea «Completa»'
    )

    // Once that file is gone there is no complete copy left: nothing is touched.
    rmSync(fullRun.tasks[0].outputPath!)
    backups.restores.length = 0
    timeline.length = 0
    const again = await runJob(t.ctx, deps, job.id, 'manual')
    expect(again.tasks[0].status).toBe('failed')
    expect(again.tasks[0].message).toMatch(
      /No hay ninguna copia completa \(con datos\) de «auth» de Staging/
    )
    expect(timeline).toEqual([])
  })

  it('refuses at run time a step restoring a structure-only backup step', async () => {
    const staging = t.ctx.connections.save(connectionInput('Staging'))
    const local = t.ctx.connections.save(connectionInput('Local'))
    const job = t.ctx.jobs.save(
      jobInput('Sin datos', [
        { ...backupTask('b1', staging.id, 'auth'), includeData: false },
        {
          id: 'r1',
          type: 'restoreschema',
          connectionId: local.id,
          schema: '',
          referenceName: 'Restaurar auth',
          restoreSource: { kind: 'task', taskId: 'b1' }
        }
      ])
    )
    const run = await runJob(t.ctx, deps, job.id, 'schedule')
    expect(run.tasks[1].status).toBe('failed')
    expect(run.tasks[1].message).toMatch(/solo de estructura/)
    expect(backups.restores).toEqual([])
    expect(sessions.executed).toEqual([])
  })

  it('a «Solo estructura» restore step may restore a structure-only backup step, with empty tables', async () => {
    const staging = t.ctx.connections.save(connectionInput('Staging'))
    const local = t.ctx.connections.save(connectionInput('Local'))
    const job = t.ctx.jobs.save(
      jobInput('Solo estructura', [
        { ...backupTask('b1', staging.id, 'auth'), includeData: false },
        restoreTask('r1', local.id, 'b1', { includeData: false })
      ])
    )
    expect(t.ctx.jobs.get(job.id)?.tasks[1].includeData).toBe(false)
    const run = await runJob(t.ctx, deps, job.id, 'schedule')
    expect(run.status).toBe('success')
    expect(backups.restores[0]).toMatchObject({ includeData: false, skipAutoIncrement: true })
    expect(readFileSync(run.logPath, 'utf8')).toContain('Solo estructura: 1 objeto, 0 filas')
  })

  it('a restore step saved before 0.1.6 (no includeData) restores structure and data', async () => {
    const staging = t.ctx.connections.save(connectionInput('Staging'))
    const local = t.ctx.connections.save(connectionInput('Local'))
    const legacy = restoreTask('r1', local.id, 'b1')
    delete legacy.includeData
    const job = t.ctx.jobs.save(
      jobInput('Antiguo', [backupTask('b1', staging.id, 'auth'), legacy])
    )
    const run = await runJob(t.ctx, deps, job.id, 'schedule')
    expect(run.status).toBe('success')
    expect(backups.restores[0]).toMatchObject({ includeData: true })
    const log = readFileSync(run.logPath, 'utf8')
    expect(log).toMatch(/Resultado: OK · 1 objeto · 2 filas/)
    expect(log).not.toContain('solo estructura')
  })

  it('fails the step (without restoring) when the source backup step failed', async () => {
    const staging = t.ctx.connections.save({
      ...connectionInput('Staging'),
      environment: 'staging'
    })
    const local = t.ctx.connections.save(connectionInput('Local'))
    backups.failures.set('auth', 'Access denied')
    const job = t.ctx.jobs.save(
      jobInput(
        'Falla origen',
        [
          backupTask('b1', staging.id, 'auth'),
          {
            id: 'r1',
            type: 'restoreschema',
            connectionId: local.id,
            schema: '',
            referenceName: 'Restaurar auth',
            restoreSource: { kind: 'task', taskId: 'b1' }
          }
        ],
        { continueOnError: true }
      )
    )
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.tasks.map((x) => x.status)).toEqual(['failed', 'failed'])
    expect(run.tasks[1].message).toMatch(/no generó ninguna copia/)
    expect(backups.restores).toEqual([])
    expect(sessions.executed).toEqual([])
  })

  it('reports object errors of the restore as a failed step', async () => {
    const staging = t.ctx.connections.save({
      ...connectionInput('Staging'),
      environment: 'staging'
    })
    const local = t.ctx.connections.save(connectionInput('Local'))
    backups.restoreFailures.set('users', "Table 'users' already exists")
    const job = t.ctx.jobs.save(
      jobInput('Con errores', [
        backupTask('b1', staging.id, 'auth'),
        {
          id: 'r1',
          type: 'restoreschema',
          connectionId: local.id,
          schema: '',
          referenceName: 'Restaurar auth',
          restoreSource: { kind: 'task', taskId: 'b1' }
        }
      ])
    )
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.tasks[1].status).toBe('failed')
    expect(run.tasks[1].message).toMatch(/1 objeto con error al restaurar «auth»/)
    const log = readFileSync(run.logPath, 'utf8')
    expect(log).toMatch(/Tabla users \.+ +ERROR: Table 'users' already exists/)
  })
})

describe('file-based rollback (packages of the backups list)', () => {
  let t: TestContext
  let timeline: string[]
  let backups: FakeBackupService
  let sessions: FakeSessionFactory
  let deps: RunnerDeps
  let stagingId: string
  let localId: string
  let prodId: string
  let inspector: RollbackInspector
  let navicatDir: string

  beforeEach(() => {
    t = makeContext()
    timeline = []
    backups = fakeBackupService(t.dir, timeline)
    sessions = fakeSessionFactory(timeline)
    deps = { backups, sessions, backupCharset: async () => null }
    navicatDir = join(t.dir, 'navicat')
    stagingId = t.ctx.connections.save({
      ...connectionInput('Staging'),
      environment: 'staging',
      backupDir: t.dir,
      extraBackupDirs: [navicatDir]
    }).id
    localId = t.ctx.connections.save({
      ...connectionInput('Local'),
      backupDir: join(t.dir, 'local')
    }).id
    prodId = t.ctx.connections.save({ ...connectionInput('Prod'), environment: 'production' }).id
    backups.objects.set('auth', [{ type: 'Table', name: 'users', rows: 10 }])
    backups.objects.set('crm', [{ type: 'Table', name: 'clients', rows: 4 }])
    sessions.schemas.set(localId, new Set(['auth']))
    inspector = {
      readMeta: (path) => backups.readMeta(path),
      fileSize: async () => 1024,
      targetSchemas: async (id) => [...(sessions.schemas.get(id) ?? [])]
    }
  })
  afterEach(() => t.cleanup())

  /** Two Navicat batch files (no run): auth and crm under <navicat>/<schema>/. */
  function navicatPackage(): string[] {
    const a = join(navicatDir, 'auth', '20261005231600-backup-staging.nb3')
    const c = join(navicatDir, 'crm', '20261005231800-backup-staging.nb3')
    backups.files.set(a, 'auth')
    backups.files.set(c, 'crm')
    return [a, c]
  }

  const files = (backupPaths: string[], title = 'backup-staging · 2026-10-05 23:16') => ({
    source: 'files' as const,
    backupPaths,
    sourceConnectionId: stagingId,
    title
  })

  it('plans files of a Navicat package: replaced vs created, recorded under the manual list', async () => {
    const paths = navicatPackage()
    const plan = await buildAnyRollbackPlan(t.ctx, files(paths), localId, inspector)
    expect(plan).toMatchObject({
      source: 'files',
      runId: '',
      jobId: MANUAL_ROLLBACKS_JOB_ID,
      jobName: 'backup-staging · 2026-10-05 23:16',
      targetError: null
    })
    expect(plan.items.map((i) => [i.taskId, i.schema, i.targetExists, i.problem])).toEqual([
      [paths[0], 'auth', true, null],
      [paths[1], 'crm', false, null]
    ])
    expect(plan.items[0].sourceConnectionName).toBe('Staging')
  })

  it('refuses paths outside every backup folder, non-.nb3 files, deeper files and repeats', async () => {
    const [a] = navicatPackage()
    const outside = join(tmpdir(), 'elsewhere', 'auth.nb3')
    backups.files.set(outside, 'auth')
    await expect(
      buildAnyRollbackPlan(t.ctx, files([a, outside]), localId, inspector)
    ).rejects.toThrow(/no está en la carpeta de copias de seguridad de ninguna conexión/)
    await expect(
      buildAnyRollbackPlan(t.ctx, files([join(t.dir, '..', 'x', 'a.nb3')]), localId, inspector)
    ).rejects.toThrow(/ninguna conexión/)
    await expect(
      buildAnyRollbackPlan(t.ctx, files([join(t.dir, 'auth', 'notes.txt')]), localId, inspector)
    ).rejects.toThrow(/no es una copia de seguridad \(\.vqb o \.nb3\)/)
    await expect(
      buildAnyRollbackPlan(t.ctx, files([join(t.dir, 'a', 'b', 'c.nb3')]), localId, inspector)
    ).rejects.toThrow(/ninguna conexión/)
    await expect(buildAnyRollbackPlan(t.ctx, files([a, a]), localId, inspector)).rejects.toThrow(
      /repetida/
    )
    await expect(buildAnyRollbackPlan(t.ctx, files([]), localId, inspector)).rejects.toThrow(
      /al menos una copia/
    )
    await expect(
      buildAnyRollbackPlan(t.ctx, files(['relative/auth.nb3']), localId, inspector)
    ).rejects.toThrow(/no válida/)
  })

  it('refuses two copies of the same database, asking to pick one', async () => {
    const [a] = navicatPackage()
    const again = join(navicatDir, 'auth', '20261004231600-backup-staging.nb3')
    backups.files.set(again, 'auth')
    await expect(
      buildAnyRollbackPlan(t.ctx, files([a, again]), localId, inspector)
    ).rejects.toThrow(
      /Hay 2 copias de «auth» en la selección .*selecciona solo una por base de datos/
    )
  })

  it('a system database is blocked in the plan and refused when requested', async () => {
    const sys = join(navicatDir, 'mysql', '20261005231600-backup-staging.nb3')
    backups.files.set(sys, 'mysql')
    const plan = await buildAnyRollbackPlan(t.ctx, files([sys]), localId, inspector)
    expect(plan.items[0].problem).toMatch(/mysql/)
    const request = {
      ...files([sys]),
      targetConnectionId: localId,
      safetyBackup: true
    }
    expect(() =>
      prepareRollback(t.ctx, plan, request, t.ctx.connections.get(localId)!, false)
    ).toThrow(/mysql/)
  })

  it('production needs the confirmation; without the runner flag nothing is touched', async () => {
    const paths = navicatPackage()
    const plan = await buildAnyRollbackPlan(t.ctx, files(paths), prodId, inspector)
    const prod = t.ctx.connections.get(prodId)!
    const request = { ...files(paths), targetConnectionId: prodId, safetyBackup: true }
    expect(() => prepareRollback(t.ctx, plan, request, prod, false)).toThrow(/producción/)
    const prepared = prepareRollback(t.ctx, plan, request, prod, true)
    expect(prepared.options.allowProductionRestore).toBe(true)
    timeline.length = 0
    // A job run (scheduled or not) without the confirmed flag never replaces production databases.
    const final = await startJobWith(t.ctx, deps, prepared.job, 'schedule', {
      ...prepared.options,
      allowProductionRestore: false
    }).done
    expect(final.status).toBe('failed')
    expect(final.tasks.every((task) => /producción/.test(task.message ?? ''))).toBe(true)
    expect(timeline).toEqual([])
  })

  it('restores the files with safety backup and integrity check, as a rollback run in history', async () => {
    const paths = navicatPackage()
    const plan = await buildAnyRollbackPlan(t.ctx, files(paths), localId, inspector)
    const prepared = prepareRollback(
      t.ctx,
      plan,
      { ...files(paths), targetConnectionId: localId, safetyBackup: true },
      t.ctx.connections.get(localId)!,
      false
    )
    expect(prepared.job).toMatchObject({
      id: MANUAL_ROLLBACKS_JOB_ID,
      name: 'Restaurar todo en Local · backup-staging · 2026-10-05 23:16'
    })
    expect(prepared.job.tasks.map((task) => task.id)).toEqual([
      'rollback-file-1',
      'rollback-file-2'
    ])
    expect(prepared.options.rollbackOf).toBeUndefined()
    timeline.length = 0
    const final = await startJobWith(t.ctx, deps, prepared.job, 'manual', prepared.options).done
    expect(final).toMatchObject({
      status: 'success',
      kind: 'rollback',
      jobId: MANUAL_ROLLBACKS_JOB_ID
    })
    expect(backups.verified).toEqual(paths)
    expect(timeline).toEqual([
      'create:auth',
      'DROP DATABASE `auth`',
      'CREATE DATABASE `auth`',
      'restore:auth',
      'CREATE DATABASE `crm`',
      'restore:crm'
    ])
    expect(final.tasks[0].outputPath).toBeTruthy()
    expect(t.ctx.runs.list(MANUAL_ROLLBACKS_JOB_ID).map((r) => r.id)).toEqual([final.id])
    const log = readFileSync(final.logPath, 'utf8')
    expect(log).toContain('Base de datos auth: Staging -> Local')
    expect(log).toContain(`Origen: ${paths[0]}`)
  })

  it('files written by one job are recorded under that job (and its run when only one)', async () => {
    const job = t.ctx.jobs.save(
      jobInput('Backup staging', [
        backupTask('b1', stagingId, 'auth'),
        backupTask('b2', stagingId, 'crm')
      ])
    )
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    const paths = run.tasks.map((task) => task.outputPath!)
    const plan = await buildAnyRollbackPlan(t.ctx, files(paths, ''), localId, inspector)
    expect(plan).toMatchObject({ jobId: job.id, runId: run.id, jobName: 'Backup staging' })
    const prepared = prepareRollback(
      t.ctx,
      plan,
      { ...files(paths, ''), targetConnectionId: localId, safetyBackup: false },
      t.ctx.connections.get(localId)!,
      false
    )
    expect(prepared.job.id).toBe(job.id)
    expect(prepared.options.rollbackOf).toBe(run.id)
    // Mixed with a Navicat file: no single job, the manual list.
    const [navicatAuth] = navicatPackage()
    const mixed = await buildAnyRollbackPlan(
      t.ctx,
      files([navicatAuth, paths[1]]),
      localId,
      inspector
    )
    expect(mixed.jobId).toBe(MANUAL_ROLLBACKS_JOB_ID)
  })

  it('the request is checked against the rebuilt plan', async () => {
    const paths = navicatPackage()
    const plan = await buildAnyRollbackPlan(t.ctx, files([paths[0]]), localId, inspector)
    expect(() =>
      prepareRollback(
        t.ctx,
        plan,
        { ...files(paths), targetConnectionId: localId, safetyBackup: true },
        t.ctx.connections.get(localId)!,
        false
      )
    ).toThrow(/ya no está disponible/)
  })
})
