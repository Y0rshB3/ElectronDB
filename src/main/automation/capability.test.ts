import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validateJobInput } from '../ipc/jobValidation'
import { runJob } from './runner'
import {
  backupTask,
  connectionInput,
  fakeBackupService,
  fakeSessionFactory,
  jobInput,
  makeContext,
  queryTask,
  restoreTask,
  type TestContext
} from './testSupport'

// Every engine has automation; query steps and .nb3/.sql copies stay MySQL/MariaDB only and
// restores stay within one engine (shared/jobEngines.ts).
describe('automation per-engine rules', () => {
  let t: TestContext
  let mysqlId: string
  let pgId: string
  let mongoId: string

  beforeEach(() => {
    t = makeContext()
    mysqlId = t.ctx.connections.save(connectionInput('Local')).id
    pgId = t.ctx.connections.save({ ...connectionInput('PG local'), engine: 'postgresql' }).id
    mongoId = t.ctx.connections.save({ ...connectionInput('Mongo local'), engine: 'mongodb' }).id
  })
  afterEach(() => t.cleanup())

  const lookup = (id: string) => t.ctx.connections.get(id)

  it('jobs:save accepts .vqb backups of every engine', () => {
    const input = jobInput('Mixto', [
      backupTask('t1', mysqlId, 'shop'),
      { ...backupTask('t2', pgId, 'app'), format: 'vqb', encrypt: true },
      { ...backupTask('t3', mongoId, 'logs'), format: 'vqb' }
    ])
    expect(() => validateJobInput(input, lookup)).not.toThrow()
  })

  it('jobs:save refuses query steps and .nb3/.sql copies outside MySQL/MariaDB', () => {
    expect(() =>
      validateJobInput(jobInput('Q', [queryTask('t1', pgId, 'app', 'SELECT 1')]), lookup)
    ).toThrow(
      'El Query t1 es una consulta sobre «PG local» (PostgreSQL): los pasos de consulta solo están disponibles en conexiones MySQL y MariaDB.'
    )
    expect(() =>
      validateJobInput(jobInput('B', [backupTask('t1', mongoId, 'logs')]), lookup)
    ).toThrow('El Backup logs copia «Mongo local» (MongoDB): sus copias solo pueden ser .vqb.')
    expect(() =>
      validateJobInput(jobInput('S', [{ ...backupTask('t1', pgId, 'app'), format: 'sql' }]), lookup)
    ).toThrow(/sus copias solo pueden ser \.vqb/)
  })

  it('jobs:save refuses a restore into another engine', () => {
    const input = jobInput('Cruzado', [
      { ...backupTask('b1', pgId, 'app'), format: 'vqb' },
      restoreTask('r1', mongoId, 'b1', { schema: 'app_copia' })
    ])
    expect(() => validateJobInput(input, lookup)).toThrow(
      /restauraría una copia de PostgreSQL \(«PG local»\) en «Mongo local», que es MongoDB/
    )
  })

  it('jobs:save refuses each engine’s own system databases as restore targets', () => {
    const input = jobInput('Sistema', [
      { ...backupTask('b1', mongoId, 'logs'), format: 'vqb' },
      restoreTask('r1', mongoId, 'b1', { schema: 'admin' })
    ])
    expect(() => validateJobInput(input, lookup)).toThrow(
      /«admin» es una base de datos del sistema de MongoDB/
    )
  })

  it('a stored job breaking the rules fails those steps without touching anything', async () => {
    const backups = fakeBackupService(t.dir)
    const sessions = fakeSessionFactory()
    const job = t.ctx.jobs.save(
      jobInput(
        'Antiguo',
        [backupTask('t1', pgId, 'public'), queryTask('t2', pgId, 'public', 'SELECT 1')],
        { continueOnError: true }
      )
    )
    const run = await runJob(t.ctx, { backups, sessions }, job.id, 'manual')
    expect(run.status).toBe('failed')
    expect(run.tasks.map((x) => x.message)).toEqual([
      'El paso «Backup public» copia «PG local» (PostgreSQL): sus copias solo pueden ser .vqb.',
      'El paso «Query t2» es una consulta sobre «PG local» (PostgreSQL): los pasos de consulta solo están disponibles en conexiones MySQL y MariaDB.'
    ])
    expect(backups.calls).toHaveLength(0)
    expect(sessions.executed).toHaveLength(0)
  })
})
