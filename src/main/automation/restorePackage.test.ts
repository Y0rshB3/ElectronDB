import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JobTask } from '@shared/types'
import { validateJobInput } from '../ipc/jobValidation'
import { jobPackageSummaries, latestJobPackage } from './jobPackages'
import { markInterrupted } from './recovery'
import { runJob, type RunnerDeps } from './runner'
import {
  backupTask,
  connectionInput,
  fakeBackupService,
  fakeSessionFactory,
  jobInput,
  makeContext,
  type FakeBackupService,
  type FakeSessionFactory,
  type TestContext
} from './testSupport'

/** «Restaurar paquete» steps run by the job runner with the automation fakes. */

function packageTask(id: string, connectionId: string, overrides: Partial<JobTask> = {}): JobTask {
  return {
    id,
    type: 'restorepackage',
    connectionId,
    schema: '',
    referenceName: 'Restaurar paquete',
    packageSource: { kind: 'own' },
    safetyBackup: true,
    includeData: true,
    ...overrides
  }
}

describe('«Restaurar paquete» steps', () => {
  let t: TestContext
  let timeline: string[]
  let backups: FakeBackupService
  let sessions: FakeSessionFactory
  let deps: RunnerDeps
  let staging: string
  let local: string

  beforeEach(() => {
    t = makeContext()
    timeline = []
    backups = fakeBackupService(t.dir, timeline)
    sessions = fakeSessionFactory(timeline)
    deps = { backups, sessions, backupCharset: async () => null }
    for (const schema of ['auth', 'ventas', 'logs'])
      backups.objects.set(schema, [{ type: 'Table', name: `t_${schema}`, rows: 2 }])
    staging = t.ctx.connections.save({ ...connectionInput('Staging'), environment: 'staging' }).id
    local = t.ctx.connections.save(connectionInput('Local')).id
    sessions.schemas.set(local, new Set(['auth']))
  })
  afterEach(() => t.cleanup())

  /** Makes the copies of a run exist on disk (the fake service records them only). */
  const touch = (paths: (string | null)[]) => paths.forEach((p) => p && writeFileSync(p, ''))

  it("this job's package: one restore per copy made earlier in the run, renamed and with safety copies", async () => {
    const job = t.ctx.jobs.save(
      jobInput('Staging a Local', [
        backupTask('b1', staging, 'auth'),
        backupTask('b2', staging, 'ventas'),
        packageTask('p1', local, { packageTargets: { ventas: 'ventas_dev' } })
      ])
    )
    const run = await runJob(t.ctx, deps, job.id, 'schedule')
    expect(run.status).toBe('success')
    expect(run.tasks.map((x) => [x.taskId, x.type, x.schema, x.packageStepId ?? null])).toEqual([
      ['b1', 'backupschema', 'auth', null],
      ['b2', 'backupschema', 'ventas', null],
      ['p1#1', 'restoreschema', 'auth', 'p1'],
      ['p1#2', 'restoreschema', 'ventas_dev', 'p1']
    ])
    expect(timeline).toEqual([
      'create:auth',
      'create:ventas',
      // Existing auth on Local: safety copy, then replace; ventas_dev is new (no copy).
      'create:auth',
      'DROP DATABASE `auth`',
      'CREATE DATABASE `auth`',
      'restore:auth',
      'CREATE DATABASE `ventas_dev`',
      'restore:ventas_dev'
    ])
    expect(backups.restores.map((r) => r.backupPath)).toEqual([
      run.tasks[0].outputPath,
      run.tasks[1].outputPath
    ])
    expect(run.tasks[2].outputPath).toBeTruthy()
    const log = readFileSync(run.logPath, 'utf8')
    expect(log).toContain('Paso 3/3 · Paquete de esta tarea -> Local')
    expect(log).toContain('2 bases de datos -> Local con copia previa: auth, ventas_dev')
    expect(log).toContain('Paso 4/4 · Base de datos ventas: Staging -> Local · ventas_dev')
    // The job itself is untouched: one package step.
    expect(t.ctx.jobs.get(job.id)!.tasks.map((x) => x.type)).toEqual([
      'backupschema',
      'backupschema',
      'restorepackage'
    ])
  })

  it('without safety copy: replaces directly and keeps no copy of the target', async () => {
    const job = t.ctx.jobs.save(
      jobInput('Sin copia previa', [
        backupTask('b1', staging, 'auth'),
        packageTask('p1', local, { safetyBackup: false })
      ])
    )
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.status).toBe('success')
    expect(run.tasks[1].outputPath).toBeNull()
    expect(timeline).toEqual([
      'create:auth',
      'DROP DATABASE `auth`',
      'CREATE DATABASE `auth`',
      'restore:auth'
    ])
  })

  it("another job's latest package: newest finished run, structure-only copies left out", async () => {
    const nightly = t.ctx.jobs.save(
      jobInput('Copia nocturna Staging', [
        backupTask('b1', staging, 'auth'),
        backupTask('b2', staging, 'ventas'),
        { ...backupTask('b3', staging, 'logs'), includeData: false }
      ])
    )
    const first = await runJob(t.ctx, deps, nightly.id, 'manual')
    await new Promise((r) => setTimeout(r, 5))
    const second = await runJob(t.ctx, deps, nightly.id, 'manual')
    touch([...first.tasks, ...second.tasks].map((x) => x.outputPath))
    expect(latestJobPackage(t.ctx, nightly.id)!.run.id).toBe(second.id)
    const summary = jobPackageSummaries(t.ctx).find((p) => p.jobId === nightly.id)!
    expect(summary.latest!.copies.map((c) => [c.schema, c.structureOnly])).toEqual([
      ['auth', false],
      ['ventas', false],
      ['logs', true]
    ])

    const job = t.ctx.jobs.save(
      jobInput('Llevar a Local', [
        packageTask('p1', local, {
          packageSource: { kind: 'job', jobId: nightly.id, jobName: nightly.name }
        })
      ])
    )
    timeline.length = 0
    backups.restores.length = 0
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.status).toBe('success')
    expect(run.tasks.map((x) => x.schema)).toEqual(['auth', 'ventas'])
    expect(backups.restores.map((r) => r.backupPath)).toEqual([
      second.tasks[0].outputPath,
      second.tasks[1].outputPath
    ])
    const log = readFileSync(run.logPath, 'utf8')
    expect(log).toContain('Último paquete de «Copia nocturna Staging»: ejecución del')
    expect(log).toContain('«logs» no se restaura: su copia es solo de estructura')

    // «Solo estructura» restores every copy, the structure-only one too.
    t.ctx.jobs.save({
      ...t.ctx.jobs.get(job.id)!,
      tasks: [{ ...t.ctx.jobs.get(job.id)!.tasks[0], includeData: false }]
    })
    const structure = await runJob(t.ctx, deps, job.id, 'manual')
    expect(structure.status).toBe('success')
    expect(structure.tasks.map((x) => x.schema)).toEqual(['auth', 'ventas', 'logs'])
  })

  it('refuses the whole package before touching anything: missing database, no package, production', async () => {
    const nightly = t.ctx.jobs.save(jobInput('Copia nocturna', [backupTask('b1', staging, 'auth')]))
    const job = t.ctx.jobs.save(
      jobInput('Llevar a Local', [
        packageTask('p1', local, {
          packageSource: { kind: 'job', jobId: nightly.id },
          packageDatabases: ['auth', 'crm']
        })
      ])
    )
    // No run of «Copia nocturna» yet.
    let run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.tasks).toHaveLength(1)
    expect(run.tasks[0].status).toBe('failed')
    expect(run.tasks[0].message).toMatch(/aún no tiene ningún paquete/)

    const made = await runJob(t.ctx, deps, nightly.id, 'manual')
    touch(made.tasks.map((x) => x.outputPath))
    timeline.length = 0
    run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.tasks[0].message).toMatch(/no tiene «crm»; no se restaura nada/)
    expect(timeline).toEqual([])

    // The target became production after the job was saved.
    t.ctx.connections.save({ ...t.ctx.connections.get(local)!, environment: 'production' })
    const own = t.ctx.jobs.save(
      jobInput('Propio', [backupTask('b1', staging, 'auth'), packageTask('p1', local)])
    )
    timeline.length = 0
    run = await runJob(t.ctx, deps, own.id, 'cli')
    expect(run.tasks.map((x) => x.status)).toEqual(['success', 'failed'])
    expect(run.tasks[1].message).toMatch(/no pueden escribir en producción/)
    expect(timeline).toEqual(['create:auth'])
  })

  it('«Todas» of a package spanning engines restores the copies of the target engine only', async () => {
    const pg = t.ctx.connections.save({
      ...connectionInput('Postgres'),
      engine: 'postgresql',
      port: 5432
    }).id
    backups.objects.set('app', [{ type: 'Table', name: 't_app', rows: 1 }])
    const nightly = t.ctx.jobs.save(
      jobInput('Multimotor', [
        backupTask('b1', staging, 'auth'),
        { ...backupTask('b2', pg, 'app'), format: 'vqb' }
      ])
    )
    const made = await runJob(t.ctx, deps, nightly.id, 'manual')
    touch(made.tasks.map((x) => x.outputPath))
    const job = t.ctx.jobs.save(
      jobInput('A Local', [
        packageTask('p1', local, { packageSource: { kind: 'job', jobId: nightly.id } })
      ])
    )
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.status).toBe('success')
    expect(run.tasks.map((x) => x.schema)).toEqual(['auth'])
    expect(readFileSync(run.logPath, 'utf8')).toContain(
      '«app» no se restaura: es una copia de «Postgres», de otro motor que «Local»'
    )
    // Picked by name, a copy of another engine refuses the whole step.
    t.ctx.jobs.save({
      ...t.ctx.jobs.get(job.id)!,
      tasks: [{ ...t.ctx.jobs.get(job.id)!.tasks[0], packageDatabases: ['auth', 'app'] }]
    })
    timeline.length = 0
    const refused = await runJob(t.ctx, deps, job.id, 'manual')
    expect(refused.tasks[0].message).toMatch(/mismo motor; no se restaura nada/)
    expect(timeline).toEqual([])
  })

  it('checks every copy before replacing anything: a deleted copy refuses the whole package', async () => {
    const nightly = t.ctx.jobs.save(
      jobInput('Copia nocturna', [
        backupTask('b1', staging, 'auth'),
        backupTask('b2', staging, 'ventas')
      ])
    )
    const made = await runJob(t.ctx, deps, nightly.id, 'manual')
    touch([made.tasks[1].outputPath])
    const job = t.ctx.jobs.save(
      jobInput(
        'Llevar a Local',
        [packageTask('p1', local, { packageSource: { kind: 'job', jobId: nightly.id } })],
        { continueOnError: true }
      )
    )
    timeline.length = 0
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.tasks.map((x) => x.status)).toEqual(['failed'])
    expect(run.tasks[0].message).toMatch(/ya no está en disco.*no se restaura nada/)
    expect(timeline).toEqual([])
  })

  it('a failed copy of this run refuses the whole package, even with «Continuar en caso de error»', async () => {
    backups.failures.set('ventas', 'Access denied')
    const job = t.ctx.jobs.save(
      jobInput(
        'Staging a Local',
        [
          backupTask('b1', staging, 'auth'),
          backupTask('b2', staging, 'ventas'),
          packageTask('p1', local)
        ],
        { continueOnError: true }
      )
    )
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.tasks.map((x) => x.status)).toEqual(['success', 'failed', 'failed'])
    expect(run.tasks[2].message).toMatch(/«ventas» no se hizo en esta ejecución/)
    expect(timeline).toEqual(['create:auth', 'create:ventas'])
  })

  it('another job: its newest COMPLETE package wins over a newer partial one; structure-only copies picked by name are refused', async () => {
    const nightly = t.ctx.jobs.save(
      jobInput(
        'Copia nocturna',
        [
          backupTask('b1', staging, 'auth'),
          { ...backupTask('b2', staging, 'logs'), includeData: false },
          backupTask('b3', staging, 'ventas')
        ],
        { continueOnError: true }
      )
    )
    const complete = await runJob(t.ctx, deps, nightly.id, 'manual')
    await new Promise((r) => setTimeout(r, 5))
    backups.failures.set('ventas', 'Access denied')
    const partial = await runJob(t.ctx, deps, nightly.id, 'manual')
    expect(partial.status).toBe('failed')
    expect(latestJobPackage(t.ctx, nightly.id)!.run.id).toBe(complete.id)
    touch([...complete.tasks, ...partial.tasks].map((x) => x.outputPath))
    const job = t.ctx.jobs.save(
      jobInput('A Local', [
        packageTask('p1', local, {
          packageSource: { kind: 'job', jobId: nightly.id },
          packageDatabases: ['auth', 'logs']
        })
      ])
    )
    timeline.length = 0
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.tasks[0].message).toMatch(/«logs» del paquete .* es solo de estructura/)
    expect(timeline).toEqual([])
  })

  it('an interrupted package restore is labelled by its own name, not by a job step', () => {
    const job = t.ctx.jobs.save(
      jobInput('Staging a Local', [backupTask('b1', staging, 'auth'), packageTask('p1', local)])
    )
    const stale = {
      id: 'r1',
      jobId: job.id,
      jobName: job.name,
      status: 'running' as const,
      trigger: 'manual' as const,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      logPath: `${t.dir}/r1.log`,
      tasks: [
        {
          taskId: 'b1',
          referenceName: 'Backup auth',
          status: 'success' as const,
          startedAt: null,
          finishedAt: null,
          message: null,
          outputPath: null,
          type: 'backupschema' as const
        },
        {
          taskId: 'p1#1',
          referenceName: 'Base de datos auth: Staging -> Local',
          status: 'running' as const,
          startedAt: null,
          finishedAt: null,
          message: null,
          outputPath: null,
          type: 'restoreschema' as const,
          connectionId: local,
          schema: 'auth',
          packageStepId: 'p1'
        }
      ]
    }
    const closed = markInterrupted(t.ctx, stale, () => new Date())
    expect(closed.tasks[1].message).toMatch(/«auth» puede haber quedado incompleta en «Local»/)
    expect(readFileSync(stale.logPath, 'utf8')).toContain('Base de datos auth: Staging -> Local')
  })
})

describe('jobs:save validation of «Restaurar paquete»', () => {
  let t: TestContext
  beforeEach(() => (t = makeContext()))
  afterEach(() => t.cleanup())

  it('refuses guarded targets, the own job as «otra tarea», missing jobs and names', () => {
    const staging = t.ctx.connections.save(connectionInput('Staging')).id
    const local = t.ctx.connections.save(connectionInput('Local')).id
    const prod = t.ctx.connections.save({
      ...connectionInput('Prod'),
      environment: 'production'
    }).id
    const lookup = (id: string) => t.ctx.connections.get(id)
    const exists = (id: string) => id === 'job-a'
    const save = (task: JobTask, id?: string) =>
      validateJobInput(
        { ...jobInput('X', [backupTask('b1', staging, 'auth'), task]), ...(id ? { id } : {}) },
        lookup,
        [],
        exists
      )
    expect(() => save(packageTask('p1', local))).not.toThrow()
    expect(() => save(packageTask('p1', prod))).toThrow(/no pueden escribir en producción/)
    expect(() =>
      save(packageTask('p1', local, { packageSource: { kind: 'job', jobId: 'job-a' } }), 'job-a')
    ).toThrow(/su propia tarea/)
    expect(() =>
      save(
        packageTask('p1', local, {
          packageSource: { kind: 'job', jobId: 'gone', jobName: 'Vieja' }
        })
      )
    ).toThrow(/«Vieja», que ya no existe/)
    expect(() => save(packageTask('p1', staging))).toThrow(/sobre sí misma/)
    expect(() => save(packageTask('p1', local, { packageTargets: { auth: 'mysql' } }))).toThrow(
      /sistema de MySQL/
    )
    expect(() => save(packageTask('p1', local, { packageDatabases: [] }))).toThrow(
      /no restaura ninguna base de datos/
    )
    // A package step placed before every copy has nothing of its own to restore.
    expect(() =>
      validateJobInput(
        jobInput('Y', [packageTask('p1', local), backupTask('b1', staging, 'auth')]),
        lookup
      )
    ).toThrow(/no hay ningún paso de copia/)
  })
})
