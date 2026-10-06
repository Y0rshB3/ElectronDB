import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JobLogEvent, JobRun, ProgressEvent } from '@shared/types'
import { RunsRepo } from '../storage/repos'
import { jobNameSlug, runJob, splitStatements, startJob, type RunnerDeps } from './runner'
import {
  backupTask,
  connectionInput,
  fakeBackupService,
  fakeSessionFactory,
  jobInput,
  makeContext,
  queryTask,
  type FakeBackupService,
  type FakeSessionFactory,
  type TestContext
} from './testSupport'

describe('runner', () => {
  let t: TestContext
  let backups: FakeBackupService
  let sessions: FakeSessionFactory
  let deps: RunnerDeps
  let connectionId: string

  const jobRunEvents = (): JobRun[] =>
    t.events.filter((e) => e.channel === 'event:jobRun').map((e) => e.payload as JobRun)

  beforeEach(() => {
    t = makeContext()
    backups = fakeBackupService(t.dir)
    sessions = fakeSessionFactory()
    deps = { backups, sessions }
    connectionId = t.ctx.connections.save(connectionInput('Local')).id
  })
  afterEach(() => t.cleanup())

  it('runs backup and query tasks sequentially and persists the run', async () => {
    const job = t.ctx.jobs.save(
      jobInput('Nightly Ñandú', [
        backupTask('t1', connectionId, 'shop'),
        queryTask(
          't2',
          connectionId,
          'shop',
          'DELETE FROM audit WHERE at < NOW();\nOPTIMIZE TABLE audit'
        )
      ])
    )
    const run = await runJob(t.ctx, deps, job.id, 'manual')

    expect(run.status).toBe('success')
    expect(run.trigger).toBe('manual')
    expect(run.finishedAt).not.toBeNull()
    expect(run.tasks.map((x) => x.status)).toEqual(['success', 'success'])
    expect(run.tasks[0].outputPath).toBe(join(t.dir, 'shop-nightly-nandu.nb3'))
    expect(backups.calls).toEqual([
      { connectionId, schema: 'shop', includeData: true, label: 'nightly-nandu' }
    ])
    expect(sessions.executed.map((e) => e.sql)).toEqual([
      'DELETE FROM audit WHERE at < NOW()',
      'OPTIMIZE TABLE audit'
    ])
    expect(sessions.executed[0].schema).toBe('shop')
    expect(sessions.released).toBe(1)
    expect(run.logPath).toBe(join(t.ctx.logDir, 'jobs', `${run.id}.log`))

    // persisted through the real RunsRepo (fresh instance re-reads the file)
    const persisted = new RunsRepo(t.dir).get(run.id)
    expect(persisted?.status).toBe('success')
    expect(persisted?.tasks[1].status).toBe('success')
    expect(t.ctx.jobs.get(job.id)?.lastRunAt).toBe(run.startedAt)

    // log content: lifecycle only, never SQL
    const log = readFileSync(run.logPath, 'utf8')
    expect(log).toMatch(
      /^\[\d{2}:\d{2}:\d{2}\] Inicio de «Nightly Ñandú» · .* · manual · 2 pasos$/m
    )
    expect(log).toContain('] Paso 1/2 · Base de datos shop (Local)')
    expect(log).toContain(`  Archivo: ${run.tasks[0].outputPath}`)
    expect(log).toContain('] Paso 2/2 · Consulta «Query t2» · shop (Local)')
    expect(log).toMatch(/ {2}Sentencia 1\/2 \.+ +0 filas afectadas {2}OK$/m)
    expect(log).toContain('  Resultado: OK · 2 sentencias')
    expect(log).toContain('Finalizado correctamente: 2 de 2 pasos OK.')
    expect(log).not.toContain('DELETE FROM')
  })

  it('emits event:jobRun on every change, starting with the running snapshot', async () => {
    const job = t.ctx.jobs.save(jobInput('Single', [backupTask('t1', connectionId, 'shop')]))
    const started = startJob(t.ctx, deps, job.id, 'schedule')
    expect(started.run.status).toBe('running')
    expect(started.run.tasks[0].status).toBe('queued')
    await started.done
    const statuses = jobRunEvents().map((r) => `${r.status}/${r.tasks[0].status}`)
    expect(statuses).toEqual([
      'running/queued',
      'running/running',
      'running/success',
      'success/success'
    ])
    // progress of the backup is forwarded with the run id as operation id
    const progress = t.events.find((e) => e.channel === 'event:progress')?.payload as {
      operationId: string
      kind: string
    }
    expect(progress).toMatchObject({ operationId: started.run.id, kind: 'job' })
  })

  it('stops at the first failure when continueOnError is false', async () => {
    backups.failures.set('shop', 'disk full')
    const job = t.ctx.jobs.save(
      jobInput('Strict', [
        backupTask('t1', connectionId, 'shop'),
        queryTask('t2', connectionId, 'shop', 'SELECT 1'),
        backupTask('t3', connectionId, 'crm')
      ])
    )
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.status).toBe('failed')
    expect(run.tasks.map((x) => x.status)).toEqual(['failed', 'cancelled', 'cancelled'])
    expect(run.tasks[0].message).toBe('disk full')
    expect(run.tasks[1].message).toMatch(/Omitido/)
    expect(sessions.executed).toHaveLength(0)
    expect(backups.calls).toHaveLength(1)
    const log = readFileSync(run.logPath, 'utf8')
    expect(log).toContain('  Resultado: ERROR · disk full')
    expect(log).toContain('] Paso 2/3 · Consulta «Query t2» · shop (Local)')
    expect(log).toContain('  Resultado: OMITIDO · Omitido por un error anterior.')
    expect(log).toContain('  Pasos: 3 · Correctos: 0 · Con error: 1 · Cancelados: 0 · Omitidos: 2')
    expect(log).toContain('Finalizado con errores: 1 de 3 pasos con error.')
  })

  it('continues past failures when continueOnError is true, run still failed', async () => {
    backups.failures.set('shop', 'disk full')
    sessions.failing.set('BAD SQL', 'syntax error near BAD')
    const job = t.ctx.jobs.save(
      jobInput(
        'Lenient',
        [
          backupTask('t1', connectionId, 'shop'),
          queryTask('t2', connectionId, 'shop', 'BAD SQL'),
          backupTask('t3', connectionId, 'crm')
        ],
        { continueOnError: true }
      )
    )
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.status).toBe('failed')
    expect(run.tasks.map((x) => x.status)).toEqual(['failed', 'failed', 'success'])
    expect(run.tasks[1].message).toBe('syntax error near BAD')
    expect(run.tasks[2].outputPath).toContain('crm')
    expect(sessions.released).toBe(1)
  })

  it('fails a task whose connection does not exist with a Spanish message', async () => {
    const job = t.ctx.jobs.save(jobInput('Ghost', [backupTask('t1', 'missing-conn', 'shop')]))
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.status).toBe('failed')
    expect(run.tasks[0].message).toMatch(/La conexión del paso "Backup shop" no existe/)
    expect(backups.calls).toHaveLength(0)
  })

  it('cancels the run and remaining tasks when the signal aborts', async () => {
    backups.hangOn = 'shop'
    const job = t.ctx.jobs.save(
      jobInput(
        'Cancelable',
        [backupTask('t1', connectionId, 'shop'), queryTask('t2', connectionId, 'shop', 'SELECT 1')],
        {
          continueOnError: true
        }
      )
    )
    const controller = new AbortController()
    const started = startJob(t.ctx, deps, job.id, 'manual', controller.signal)
    await new Promise((r) => setTimeout(r, 5))
    controller.abort()
    const run = await started.done
    expect(run.status).toBe('cancelled')
    expect(run.tasks.map((x) => x.status)).toEqual(['cancelled', 'cancelled'])
    expect(sessions.executed).toHaveLength(0)
    const log = readFileSync(run.logPath, 'utf8')
    expect(log).toContain('  Resultado: CANCELADO · Ejecución cancelada.')
    expect(log).toContain('Ejecución cancelada: 0 de 2 pasos completados.')
    expect(log).toContain('Cancelados: 2 · Omitidos: 0')
    expect(t.ctx.runs.get(run.id)?.status).toBe('cancelled')
  })

  it('throws for an unknown job before creating any run', () => {
    expect(() => startJob(t.ctx, deps, 'nope', 'manual')).toThrow(/no existe/)
    expect(t.ctx.runs.list(null)).toHaveLength(0)
    expect(existsSync(join(t.ctx.logDir, 'jobs'))).toBe(false)
  })

  it('never rejects when infrastructure fails mid-run', async () => {
    const job = t.ctx.jobs.save(jobInput('Broken infra', [backupTask('t1', connectionId, 'shop')]))
    let calls = 0
    const upsert = t.ctx.runs.upsert.bind(t.ctx.runs)
    t.ctx.runs.upsert = (run) => {
      if (++calls === 2) throw new Error('disk gone')
      return upsert(run)
    }
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.status).toBe('failed')
    expect(run.finishedAt).not.toBeNull()
  })
})

describe('runner log', () => {
  let t: TestContext
  let backups: FakeBackupService
  let sessions: FakeSessionFactory
  let deps: RunnerDeps
  let connectionId: string

  beforeEach(() => {
    t = makeContext()
    backups = fakeBackupService(t.dir)
    sessions = fakeSessionFactory()
    // Deterministic clock: every reading advances one second from 17:38:10.
    let tick = 0
    const base = new Date(2026, 9, 5, 17, 38, 10).getTime()
    deps = { backups, sessions, now: () => new Date(base + 1000 * tick++) }
    connectionId = t.ctx.connections.save(connectionInput('Local')).id
    backups.objects.set('accounts', [
      { type: 'Table', name: 'person', rows: 0 },
      { type: 'Table', name: 'user', rows: 1234 },
      { type: 'View', name: 'v_people' },
      { type: 'Procedure', name: 'p_cleanup' }
    ])
  })
  afterEach(() => t.cleanup())

  const fileLines = (run: JobRun): string[] =>
    readFileSync(run.logPath, 'utf8').split('\n').filter(Boolean)
  const streamed = (runId: string): JobLogEvent[] =>
    t.events
      .filter((e) => e.channel === 'event:jobLog')
      .map((e) => e.payload as JobLogEvent)
      .filter((e) => e.runId === runId)

  it('writes a heading per database, one aligned line per object, the result and a summary', async () => {
    const job = t.ctx.jobs.save(jobInput('Diario', [backupTask('t1', connectionId, 'accounts')]))
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.status).toBe('success')
    const lines = fileLines(run)
    for (const line of lines) expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\] /)
    const bodies = lines.map((l) => l.slice(11))
    expect(bodies[0]).toBe('Inicio de «Diario» · 05/10/2026 · manual · 1 paso')
    expect(lines[0].startsWith('[17:38:1')).toBe(true)
    expect(bodies[1]).toBe('Paso 1/1 · Base de datos accounts (Local)')
    expect(bodies[2]).toBe('  Encontrados 4 objetos (2 tablas, 1 vista, 1 procedimiento)')
    const objects = bodies.slice(3, 7)
    expect(objects[0]).toMatch(/^ {2}Tabla person \.+ +0 filas {2}OK$/)
    expect(objects[1]).toMatch(/^ {2}Tabla user \.+ +1\.234 filas {2}OK$/)
    expect(objects[2]).toMatch(/^ {2}Vista v_people \.+ +OK$/)
    expect(objects[3]).toMatch(/^ {2}Procedimiento p_cleanup \.+ +OK$/)
    // Navicat-like alignment: every status sits in the same column.
    expect(new Set(objects.map((l) => l.lastIndexOf('OK'))).size).toBe(1)
    expect(bodies[7]).toBe(`  Archivo: ${run.tasks[0].outputPath}`)
    expect(bodies[8]).toMatch(/^ {2}Resultado: OK · 4 objetos · 1\.234 filas · 2,0 KB · \d+,\d s$/)
    expect(bodies.slice(9)).toEqual([
      'Resumen',
      '  Pasos: 1 · Correctos: 1 · Con error: 0 · Cancelados: 0 · Omitidos: 0',
      expect.stringMatching(/^ {2}Duración total: \d+,\d s$/),
      'Finalizado correctamente: 1 de 1 paso OK.'
    ])
  })

  it('streams exactly the file lines through event:jobLog, batched and in order', async () => {
    const job = t.ctx.jobs.save(
      jobInput('Dos', [
        backupTask('t1', connectionId, 'accounts'),
        backupTask('t2', connectionId, 'crm')
      ])
    )
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    const events = streamed(run.id)
    expect(events.length).toBeGreaterThan(1)
    let next = 0
    for (const e of events) {
      expect(e.seq).toBe(next)
      next += e.lines.length
    }
    const lines = events.flatMap((e) => e.lines)
    expect(events.length).toBeLessThan(lines.length)
    expect(lines).toEqual(fileLines(run))
    // The final run state is published after the last log lines.
    const order = t.events.map((e) => e.channel)
    expect(order.lastIndexOf('event:jobLog')).toBeLessThan(order.lastIndexOf('event:jobRun'))
  })

  it('with continueOnError logs the failing object and lists failed steps in the summary', async () => {
    backups.objects.set('crm', [
      { type: 'Table', name: 'clients', rows: 5 },
      { type: 'Table', name: 'orders', error: 'Lost connection\nto server' }
    ])
    backups.failures.set('nope', "Unknown database 'nope'")
    const job = t.ctx.jobs.save(
      jobInput(
        'Tolerante',
        [
          backupTask('t1', connectionId, 'accounts'),
          backupTask('t2', connectionId, 'crm'),
          backupTask('t3', connectionId, 'nope')
        ],
        { continueOnError: true }
      )
    )
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    expect(run.tasks.map((x) => x.status)).toEqual(['success', 'failed', 'failed'])
    const bodies = fileLines(run).map((l) => l.slice(11))
    expect(bodies).toContain('Paso 2/3 · Base de datos crm (Local)')
    expect(bodies.find((b) => b.includes('Tabla orders'))).toMatch(
      /^ {2}Tabla orders \.+ +ERROR: Lost connection to server$/
    )
    expect(bodies).toContainEqual(
      expect.stringMatching(
        /^ {2}Resultado: ERROR · Error al respaldar orders: Lost connection to server · /
      )
    )
    const summary = bodies.slice(bodies.indexOf('Resumen'))
    expect(summary).toEqual([
      'Resumen',
      '  Pasos: 3 · Correctos: 1 · Con error: 2 · Cancelados: 0 · Omitidos: 0',
      '  ERROR · Paso 2/3 · Base de datos crm (Local): Error al respaldar orders: Lost connection to server',
      "  ERROR · Paso 3/3 · Base de datos nope (Local): Unknown database 'nope'",
      expect.stringMatching(/^ {2}Duración total: /),
      'Finalizado con errores: 2 de 3 pasos con error.'
    ])
    // Every line is a single physical line.
    for (const line of fileLines(run)) expect(line).not.toMatch(/[\r\n]/)
  })

  it('forwards backup progress with the step, step count and object position', async () => {
    const job = t.ctx.jobs.save(
      jobInput('Progreso', [
        queryTask('t0', connectionId, 'accounts', 'SELECT 1'),
        backupTask('t1', connectionId, 'accounts')
      ])
    )
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    const progress = t.events
      .filter((e) => e.channel === 'event:progress')
      .map((e) => e.payload as ProgressEvent)
    expect(progress.every((p) => p.operationId === run.id && p.kind === 'job')).toBe(true)
    expect(progress[0]).toMatchObject({
      phase: 'step',
      detail: { jobName: 'Progreso', step: 1, steps: 2, stepLabel: 'Query t0' }
    })
    expect(progress.find((p) => p.phase === 'object')?.detail).toMatchObject({
      objectType: 'Statement',
      objectName: '1/1',
      step: 1
    })
    const userDone = progress.find(
      (p) => p.phase === 'objectDone' && p.detail?.objectName === 'user'
    )
    expect(userDone?.detail).toMatchObject({
      step: 2,
      steps: 2,
      stepLabel: 'accounts',
      objectType: 'Table',
      objectIndex: 2,
      objects: 4,
      objectsDone: 2,
      rows: 1234
    })
  })

  it('logs affected rows per statement but never the SQL text', async () => {
    sessions.affected.set("UPDATE t SET secret = 'x'", 3)
    const job = t.ctx.jobs.save(
      jobInput('SQL', [queryTask('t1', connectionId, 'accounts', "UPDATE t SET secret = 'x'")])
    )
    const run = await runJob(t.ctx, deps, job.id, 'manual')
    const log = readFileSync(run.logPath, 'utf8')
    expect(log).toMatch(/Sentencia 1\/1 \.+ +3 filas afectadas {2}OK/)
    expect(log).not.toContain('secret')
  })
})

describe('helpers', () => {
  it('splitStatements splits on semicolons at line ends and drops comments', () => {
    expect(splitStatements('a;\nb; \r\n-- only comment;\nc')).toEqual(['a', 'b', 'c'])
    expect(splitStatements("update t set s = 'x;y' where id = 1;\n")).toEqual([
      "update t set s = 'x;y' where id = 1"
    ])
    expect(splitStatements('   ')).toEqual([])
  })

  it('jobNameSlug produces a file-safe label', () => {
    expect(jobNameSlug('Backup Producción (diario)')).toBe('backup-produccion-diario')
    expect(jobNameSlug('***')).toBe('job')
  })
})
