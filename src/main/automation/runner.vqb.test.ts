import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertJobPassword, validateJobInput, JOB_PASSWORD_REQUIRED } from '../ipc/jobValidation'
import { MISSING_JOB_PASSWORD, jobBackupPassword, setJobBackupPassword } from './backupKeys'
import { runJob, type RunnerDeps } from './runner'
import {
  backupTask,
  connectionInput,
  fakeBackupService,
  fakeSessionFactory,
  jobInput,
  makeContext,
  type FakeBackupService,
  type TestContext
} from './testSupport'

/** Backup steps in .vqb format, with and without the job's backup password. */
describe('runner: .vqb backup steps', () => {
  let t: TestContext
  let backups: FakeBackupService
  let deps: RunnerDeps
  let connectionId: string

  beforeEach(() => {
    t = makeContext()
    backups = fakeBackupService(t.dir)
    deps = { backups, sessions: fakeSessionFactory() }
    connectionId = t.ctx.connections.save(connectionInput('Staging')).id
  })
  afterEach(() => t.cleanup())

  it('asks the service for a .vqb and records the format on the run', async () => {
    const job = t.ctx.jobs.save(
      jobInput('Copia vqb', [{ ...backupTask('t1', connectionId, 'shop'), format: 'vqb' }])
    )
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.status).toBe('success')
    expect(backups.calls).toEqual([
      { connectionId, schema: 'shop', includeData: true, label: 'copia-vqb', format: 'vqb' }
    ])
    expect(run.tasks[0].format).toBe('vqb')
    expect(run.tasks[0].encrypted).toBeUndefined()
  })

  it('encrypts with the stored job password, never logging it', async () => {
    const job = t.ctx.jobs.save(
      jobInput('Cifrada', [
        { ...backupTask('t1', connectionId, 'shop'), format: 'vqb', encrypt: true }
      ])
    )
    setJobBackupPassword(t.ctx, job.id, 'una clave larga')
    expect(jobBackupPassword(t.ctx, job.id)).toBe('una clave larga')
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.status).toBe('success')
    expect(backups.calls[0]).toMatchObject({ format: 'vqb', password: 'una clave larga' })
    expect(run.tasks[0].encrypted).toBe(true)
    const log = readFileSync(run.logPath, 'utf8')
    expect(log).toContain('Copia .vqb cifrada con la contraseña de la tarea')
    expect(log).not.toContain('una clave larga')
    // The password lives in the credential store only, never in jobs.json.
    expect(readFileSync(`${t.dir}/jobs.json`, 'utf8')).not.toContain('una clave larga')
  })

  it('fails the step with an actionable message when the password is gone', async () => {
    const job = t.ctx.jobs.save(
      jobInput('Sin clave', [
        { ...backupTask('t1', connectionId, 'shop'), format: 'vqb', encrypt: true }
      ])
    )
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.status).toBe('failed')
    expect(run.tasks[0].message).toBe(MISSING_JOB_PASSWORD)
    expect(backups.calls).toEqual([])
  })
})

describe('job validation: formats and encryption', () => {
  const base = (task: object) => jobInput('J', [{ ...backupTask('t1', 'c1', 'shop'), ...task }])

  it('accepts .vqb and refuses encryption of other formats', () => {
    expect(() => validateJobInput(base({ format: 'vqb', encrypt: true }))).not.toThrow()
    expect(() => validateJobInput(base({ format: 'nb3', encrypt: true }))).toThrow(
      'solo puede cifrarse si es una copia en formato .vqb'
    )
    expect(() => validateJobInput(base({ format: 'zip' }))).toThrow('usa .vqb, .nb3 o .sql')
  })

  it('needs a password for encrypted steps: given now or already stored', () => {
    const input = base({ format: 'vqb', encrypt: true })
    expect(() => assertJobPassword(input, false)).toThrow(JOB_PASSWORD_REQUIRED)
    expect(() =>
      assertJobPassword({ ...input, backupPassword: 'nueva clave' }, false)
    ).not.toThrow()
    expect(() => assertJobPassword(input, true)).not.toThrow()
    // Deleting the stored password of a job that still encrypts is refused.
    expect(() => assertJobPassword({ ...input, backupPassword: null }, true)).toThrow(
      JOB_PASSWORD_REQUIRED
    )
    expect(() => assertJobPassword(base({ format: 'vqb' }), false)).not.toThrow()
  })
})
