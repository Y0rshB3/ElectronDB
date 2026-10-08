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
  type TestContext
} from './testSupport'

// Jobs stay MySQL-only (docs/multi-engine-design.md, section 11).
describe('automation capability gates', () => {
  let t: TestContext
  let mysqlId: string
  let pgId: string

  beforeEach(() => {
    t = makeContext()
    mysqlId = t.ctx.connections.save(connectionInput('Local')).id
    pgId = t.ctx.connections.save({ ...connectionInput('PG local'), engine: 'postgresql' }).id
  })
  afterEach(() => t.cleanup())

  it('jobs:save validation refuses a step on a PostgreSQL connection', () => {
    const input = jobInput('Mixto', [
      backupTask('t1', mysqlId, 'shop'),
      queryTask('t2', pgId, 'public', 'SELECT 1')
    ])
    expect(() => validateJobInput(input, (id) => t.ctx.connections.get(id))).toThrow(
      'Las tareas automáticas solo pueden usar conexiones MySQL y MariaDB; «PG local» es PostgreSQL.'
    )
  })

  it('jobs:save validation is unchanged for MySQL and for connections that no longer exist', () => {
    const input = jobInput('Solo MySQL', [
      backupTask('t1', mysqlId, 'shop'),
      queryTask('t2', 'missing-conn', 'shop', 'SELECT 1')
    ])
    expect(() => validateJobInput(input, (id) => t.ctx.connections.get(id))).not.toThrow()
    expect(() => validateJobInput(input)).not.toThrow()
  })

  it('a stored job pointing at a PostgreSQL connection fails that step without touching it', async () => {
    const backups = fakeBackupService(t.dir)
    const sessions = fakeSessionFactory()
    const job = t.ctx.jobs.save(
      jobInput(
        'Antiguo',
        [backupTask('t1', pgId, 'public'), queryTask('t2', pgId, 'public', 'SELECT 1')],
        {
          continueOnError: true
        }
      )
    )
    const run = await runJob(t.ctx, { backups, sessions }, job.id, 'manual')
    expect(run.status).toBe('failed')
    expect(run.tasks.map((x) => x.status)).toEqual(['failed', 'failed'])
    for (const task of run.tasks) {
      expect(task.message).toBe(
        'Las tareas automáticas solo pueden usar conexiones MySQL y MariaDB; «PG local» es PostgreSQL.'
      )
    }
    expect(backups.calls).toHaveLength(0)
    expect(sessions.executed).toHaveLength(0)
  })
})
