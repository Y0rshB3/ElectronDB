import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SQL_COPY_NOT_RESTORABLE } from '@shared/restoreTask'
import { findLatestJobBackup } from './latestBackup'
import { buildRollbackPlan } from './rollback'
import { runJob, type RunnerDeps } from './runner'
import {
  backupTask,
  connectionInput,
  fakeBackupService,
  fakeSessionFactory,
  jobInput,
  makeContext,
  restoreTask,
  type FakeBackupService,
  type TestContext
} from './testSupport'

/** Backup steps with «Formato: .sql» (plain dumps for other managers). */
describe('runner: backup steps in .sql format', () => {
  let t: TestContext
  let backups: FakeBackupService
  let deps: RunnerDeps
  let connectionId: string
  let localId: string

  beforeEach(() => {
    t = makeContext()
    backups = fakeBackupService(t.dir)
    deps = { backups, sessions: fakeSessionFactory() }
    connectionId = t.ctx.connections.save(connectionInput('Staging')).id
    localId = t.ctx.connections.save(connectionInput('Local')).id
    backups.objects.set('shop', [
      { type: 'Table', name: 'orders', rows: 7 },
      { type: 'View', name: 'v_orders' }
    ])
  })
  afterEach(() => t.cleanup())

  it('exports the schema to .sql instead of writing an .nb3', async () => {
    const job = t.ctx.jobs.save(
      jobInput('Para otro gestor', [{ ...backupTask('t1', connectionId, 'shop'), format: 'sql' }])
    )
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.status).toBe('success')
    expect(backups.calls).toEqual([])
    expect(backups.exports).toEqual([
      {
        connectionId,
        schema: 'shop',
        includeStructure: true,
        includeData: true,
        includeCreateDatabase: false,
        label: 'para-otro-gestor'
      }
    ])
    expect(run.tasks[0].outputPath).toBe(join(t.dir, 'shop-para-otro-gestor.sql'))
    expect(run.tasks[0].format).toBe('sql')
    const log = readFileSync(run.logPath, 'utf8')
    expect(log).toContain(`  Archivo: ${run.tasks[0].outputPath}`)
    expect(log).toMatch(/Resultado: OK · 2 objetos · 7 filas/)
  })

  it('passes «solo estructura» and reports a failed export as a failed step', async () => {
    const job = t.ctx.jobs.save(
      jobInput('Estructura', [
        { ...backupTask('t1', connectionId, 'shop'), format: 'sql', includeData: false }
      ])
    )
    let run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(backups.exports[0].includeData).toBe(false)
    expect(run.tasks[0].includeData).toBe(false)

    backups.failures.set('shop', 'disco lleno')
    run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.status).toBe('failed')
    expect(run.tasks[0].message).toBe('disco lleno')
  })

  it('keeps .nb3 steps (no format, or format nb3) unchanged', async () => {
    const job = t.ctx.jobs.save(
      jobInput('Nb3', [
        backupTask('t1', connectionId, 'shop'),
        { ...backupTask('t2', connectionId, 'shop'), format: 'nb3' }
      ])
    )
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(backups.exports).toEqual([])
    expect(backups.calls).toHaveLength(2)
    expect(run.tasks.every((x) => x.format === undefined)).toBe(true)
  })

  it('never restores the .sql output of an earlier step (jobs saved by hand)', async () => {
    const job = t.ctx.jobs.save(
      jobInput('Sql y restaurar', [
        { ...backupTask('t1', connectionId, 'shop'), format: 'sql' },
        restoreTask('t2', localId, 't1')
      ])
    )
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.status).toBe('failed')
    expect(run.tasks[1].status).toBe('failed')
    expect(run.tasks[1].message).toMatch(/una copia \.sql; las restauraciones automáticas/)
    expect(backups.restores).toEqual([])
  })

  it('«Última copia en disco» skips .sql outputs', async () => {
    const job = t.ctx.jobs.save(
      jobInput('Sql', [{ ...backupTask('t1', connectionId, 'shop'), format: 'sql' }])
    )
    await runJob(t.ctx, deps, job.id, 'manual')
    expect(await findLatestJobBackup(t.ctx, connectionId, 'shop', async () => true)).toBeNull()
  })

  it('«Restaurar todo» lists a .sql output with a problem instead of reading it', async () => {
    const job = t.ctx.jobs.save(
      jobInput('Sql', [{ ...backupTask('t1', connectionId, 'shop'), format: 'sql' }])
    )
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    const read: string[] = []
    const plan = await buildRollbackPlan(t.ctx, run.id, null, {
      readMeta: async (path) => {
        read.push(path)
        throw new Error('not an nb3')
      },
      fileSize: async () => 10,
      targetSchemas: async () => []
    })
    expect(read).toEqual([])
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0].schema).toBe('shop')
    expect(plan.items[0].problem).toBe(SQL_COPY_NOT_RESTORABLE)
  })
})
