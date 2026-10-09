import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionInput, JobTask } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import { buildCopyRestoreSteps } from '@shared/jobRecipes'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { envVar } from '@main/env'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { getConnectionManager, getSessionFactory } from '@main/mysql/manager'
import type { MysqlSession } from '@main/mysql/types'
import { createBackupService } from '@main/backup/index'
import { runJob, type RunnerDeps } from '@main/automation/runner'
import { latestJobPackage } from '@main/automation/jobPackages'
import { validateJobInput } from '@main/ipc/jobValidation'

/**
 * «Restaurar paquete» end to end in a scratch profile: a job copies two
 * databases of «Staging» (MySQL 5.7) and one «Restaurar paquete» step restores
 * the package of this same run into «Local» (MySQL 8.4); another job restores
 * the latest package of a backup-only job. With and without a safety copy.
 *
 *   VORTAQ_TEST_MYSQL_URL=mysql://root:navidog@127.0.0.1:33306/navidog_test     (8.4)
 *   VORTAQ_TEST_MYSQL57_URL=mysql://root:navidog@127.0.0.1:33357/navidog_test   (5.7)
 */

const url84 = envVar('TEST_MYSQL_URL')
const url57 = envVar('TEST_MYSQL57_URL')
const VENTAS = 'rp_ventas'
const AUTH = 'rp_auth'
/** Restore target of rp_auth on Local (renamed in the package step). */
const AUTH_LOCAL = 'rp_auth_local'
/** Suffix of the restores of the other job's package. */
const SUFFIX = '_pkg'

function connectionInput(
  u: URL,
  dir: string,
  name: string,
  environment: ConnectionInput['environment']
): ConnectionInput {
  return {
    name,
    color: null,
    environment,
    host: u.hostname,
    port: Number(u.port || 3306),
    username: decodeURIComponent(u.username),
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
    ssl: { enabled: false, verifyServer: false },
    backupDir: join(dir, 'backups', name),
    extraBackupDirs: []
  }
}

describe.skipIf(!url84 || !url57)(
  '«Restaurar paquete»: Staging 5.7 -> Local 8.4 (integration)',
  () => {
    let dir: string
    let ctx: AppContext
    let deps: RunnerDeps
    let stagingId: string
    let localId: string
    let prodId: string
    let s57: MysqlSession
    let s84: MysqlSession
    let ids = 0
    const newId = () => `rp-${++ids}`

    const rows = async (s: MysqlSession, sql: string) => s.query<Record<string, unknown>>(sql)
    const count = async (s: MysqlSession, sql: string) => Number((await rows(s, sql))[0].n)
    const exists = async (s: MysqlSession, db: string) =>
      (await count(
        s,
        `SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${db}'`
      )) === 1

    function saveJob(name: string, tasks: JobTask[], id?: string) {
      const input = {
        ...(id ? { id } : {}),
        name,
        continueOnError: false,
        tasks,
        schedule: { enabled: true, cron: '0 2 * * *', launchAgent: false }
      }
      validateJobInput(
        input,
        (x) => ctx.connections.get(x),
        [],
        (x) => !!ctx.jobs.get(x)
      )
      return ctx.jobs.save(input)
    }

    const nameOf = (id: string) => ctx.connections.get(id)?.name ?? ''

    /** Copies of rp_ventas and rp_auth, then ONE «Restaurar paquete» step (the recipe's). */
    function ownPackageJob(safetyBackup: boolean): JobTask[] {
      return buildCopyRestoreSteps(
        {
          sourceConnectionId: stagingId,
          targetConnectionId: localId,
          databases: [
            { name: VENTAS, target: VENTAS },
            { name: AUTH, target: AUTH_LOCAL }
          ],
          safetyBackup,
          includeData: true,
          restoreAs: 'package'
        },
        nameOf,
        newId
      )
    }

    beforeAll(async () => {
      const u84 = new URL(url84!)
      const u57 = new URL(url57!)
      dir = mkdtempSync(join(tmpdir(), 'vortaq-package-it-'))
      ctx = {
        userDataPath: dir,
        logDir: join(dir, 'logs'),
        connections: new ConnectionsRepo(dir),
        jobs: new JobsRepo(dir),
        runs: new RunsRepo(dir),
        settings: new SettingsRepo(dir, dir),
        credentials: new CredentialStore(dir, plainCodec, 'plain'),
        emit: <E extends IpcEventChannel>(_channel: E, _payload: IpcEventMap[E]) => {},
        headless: true
      }
      const add = (u: URL, name: string, env: ConnectionInput['environment']): string => {
        const id = ctx.connections.save(connectionInput(u, dir, name, env)).id
        ctx.credentials.set('mysql', id, decodeURIComponent(u.password))
        return id
      }
      stagingId = add(u57, 'Staging', 'staging')
      localId = add(u84, 'Local', 'local')
      prodId = add(u84, 'Prod', 'production')
      const sessions = getSessionFactory(ctx)
      deps = { backups: createBackupService(ctx, sessions), sessions }
      s57 = await sessions.acquire(stagingId)
      s84 = await sessions.acquire(localId)
      for (const sql of [
        `DROP DATABASE IF EXISTS ${VENTAS}`,
        `DROP DATABASE IF EXISTS ${AUTH}`,
        `CREATE DATABASE ${VENTAS} CHARACTER SET utf8mb4`,
        `CREATE TABLE ${VENTAS}.pedidos (id INT PRIMARY KEY, cliente VARCHAR(40) NOT NULL, total DECIMAL(10,2) NOT NULL)`,
        `INSERT INTO ${VENTAS}.pedidos VALUES (1, 'Ana ñandú', 120.50), (2, 'Bruno', 42.00), (3, 'Carla', 7.25)`,
        `CREATE VIEW ${VENTAS}.v_grandes AS SELECT id, total FROM ${VENTAS}.pedidos WHERE total > 40`,
        `CREATE DATABASE ${AUTH} CHARACTER SET utf8mb4`,
        `CREATE TABLE ${AUTH}.usuarios (id INT PRIMARY KEY, email VARCHAR(80) NOT NULL UNIQUE)`,
        `INSERT INTO ${AUTH}.usuarios VALUES (1, 'a@example.test'), (2, 'b@example.test')`
      ])
        await s57.execute(sql)
      // Local holds an older rp_ventas that the package replaces (and the safety copy keeps).
      for (const sql of [
        `DROP DATABASE IF EXISTS ${VENTAS}`,
        `DROP DATABASE IF EXISTS ${AUTH_LOCAL}`,
        `DROP DATABASE IF EXISTS ${VENTAS}${SUFFIX}`,
        `DROP DATABASE IF EXISTS ${AUTH}${SUFFIX}`,
        `CREATE DATABASE ${VENTAS}`,
        `CREATE TABLE ${VENTAS}.solo_local (id INT PRIMARY KEY)`,
        `INSERT INTO ${VENTAS}.solo_local VALUES (42)`
      ])
        await s84.execute(sql)
    }, 120_000)

    afterAll(async () => {
      try {
        for (const db of [VENTAS, AUTH]) await s57?.execute(`DROP DATABASE IF EXISTS ${db}`)
        for (const db of [VENTAS, AUTH_LOCAL, `${VENTAS}${SUFFIX}`, `${AUTH}${SUFFIX}`])
          await s84?.execute(`DROP DATABASE IF EXISTS ${db}`)
      } catch {
        /* best effort */
      }
      await s57?.release().catch(() => undefined)
      await s84?.release().catch(() => undefined)
      await getConnectionManager(ctx).closeAll()
      rmSync(dir, { recursive: true, force: true })
    })

    it("this run's package with a safety copy: one step restores both copies into Local", async () => {
      const tasks = ownPackageJob(true)
      expect(tasks.map((t) => t.type)).toEqual(['backupschema', 'backupschema', 'restorepackage'])
      expect(tasks[2].referenceName).toBe('Restaurar paquete de esta tarea en Local')
      const job = saveJob('Staging a Local (paquete)', tasks)
      const run = await runJob(ctx, deps, job.id, 'manual')
      expect(run.status).toBe('success')
      // The package step became one restore per database, in place.
      expect(run.tasks.map((t) => [t.type, t.schema, t.status, t.packageStepId ?? null])).toEqual([
        ['backupschema', VENTAS, 'success', null],
        ['backupschema', AUTH, 'success', null],
        ['restoreschema', VENTAS, 'success', tasks[2].id],
        ['restoreschema', AUTH_LOCAL, 'success', tasks[2].id]
      ])
      // The existing rp_ventas of Local was saved before it was replaced; rp_auth_local was new.
      expect(run.tasks[2].outputPath && existsSync(run.tasks[2].outputPath)).toBe(true)
      expect(run.tasks[3].outputPath).toBeNull()
      expect(
        await rows(s84, `SELECT id, cliente, total FROM ${VENTAS}.pedidos ORDER BY id`)
      ).toEqual(await rows(s57, `SELECT id, cliente, total FROM ${VENTAS}.pedidos ORDER BY id`))
      expect(await rows(s84, `SELECT id FROM ${VENTAS}.v_grandes ORDER BY id`)).toEqual([
        { id: 1 },
        { id: 2 }
      ])
      expect(
        await count(
          s84,
          `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${VENTAS}' AND TABLE_NAME = 'solo_local'`
        )
      ).toBe(0)
      expect(await rows(s84, `SELECT email FROM ${AUTH_LOCAL}.usuarios ORDER BY id`)).toEqual([
        { email: 'a@example.test' },
        { email: 'b@example.test' }
      ])
      // The stored job keeps its single package step.
      expect(ctx.jobs.get(job.id)!.tasks.map((t) => t.type)).toEqual([
        'backupschema',
        'backupschema',
        'restorepackage'
      ])
      const log = readFileSync(run.logPath, 'utf8')
      expect(log).toContain('Paquete de esta tarea -> Local')
      expect(log).toContain(`2 bases de datos -> Local con copia previa: ${VENTAS}, ${AUTH_LOCAL}`)
    }, 180_000)

    it("this run's package without a safety copy: new rows arrive, no copy of Local is kept", async () => {
      await s57.execute(`INSERT INTO ${VENTAS}.pedidos VALUES (4, 'Diego', 99.99)`)
      const job = saveJob('Staging a Local sin copia previa', ownPackageJob(false))
      const run = await runJob(ctx, deps, job.id, 'manual')
      expect(run.status).toBe('success')
      expect(run.tasks.slice(2).map((t) => t.outputPath)).toEqual([null, null])
      expect(await count(s84, `SELECT COUNT(*) AS n FROM ${VENTAS}.pedidos`)).toBe(4)
    }, 180_000)

    it("another job's latest package, renamed with a suffix, with and without a safety copy", async () => {
      // A backup-only job of Staging: its last run is the package.
      const nightly = saveJob('Copia nocturna Staging', [
        {
          id: newId(),
          type: 'backupschema',
          connectionId: stagingId,
          schema: VENTAS,
          referenceName: 'Copia ventas',
          includeData: true,
          format: 'vqb'
        },
        {
          id: newId(),
          type: 'backupschema',
          connectionId: stagingId,
          schema: AUTH,
          referenceName: 'Copia auth',
          includeData: true,
          format: 'vqb'
        }
      ])
      const made = await runJob(ctx, deps, nightly.id, 'manual')
      expect(made.status).toBe('success')
      expect(latestJobPackage(ctx, nightly.id)!.run.id).toBe(made.id)
      // Rows added after the package: the restore brings the package, not the live data.
      await s57.execute(`INSERT INTO ${VENTAS}.pedidos VALUES (5, 'Eva', 1.00)`)

      const pkgId = newId()
      const job = saveJob('Paquete nocturno a Local', [
        {
          id: pkgId,
          type: 'restorepackage',
          connectionId: localId,
          schema: '',
          referenceName: 'Restaurar paquete de «Copia nocturna Staging» en Local',
          packageSource: { kind: 'job', jobId: nightly.id, jobName: nightly.name },
          packageSuffix: SUFFIX,
          safetyBackup: true,
          includeData: true
        }
      ])
      const first = await runJob(ctx, deps, job.id, 'manual')
      expect(first.status).toBe('success')
      expect(first.tasks.map((t) => t.schema)).toEqual([`${VENTAS}${SUFFIX}`, `${AUTH}${SUFFIX}`])
      // New databases: nothing to keep a safety copy of.
      expect(first.tasks.map((t) => t.outputPath)).toEqual([null, null])
      expect(await count(s84, `SELECT COUNT(*) AS n FROM ${VENTAS}${SUFFIX}.pedidos`)).toBe(4)
      expect(await count(s84, `SELECT COUNT(*) AS n FROM ${AUTH}${SUFFIX}.usuarios`)).toBe(2)
      expect(readFileSync(first.logPath, 'utf8')).toContain(
        'Último paquete de «Copia nocturna Staging»: ejecución del'
      )

      // Second run: the databases exist now, so the safety copies are taken.
      await s84.execute(`INSERT INTO ${VENTAS}${SUFFIX}.pedidos VALUES (99, 'Local', 0)`)
      const second = await runJob(ctx, deps, job.id, 'manual')
      expect(second.status).toBe('success')
      expect(second.tasks.every((t) => !!t.outputPath && existsSync(t.outputPath))).toBe(true)
      expect(await count(s84, `SELECT COUNT(*) AS n FROM ${VENTAS}${SUFFIX}.pedidos`)).toBe(4)

      // Without a safety copy (only rp_auth): replaced directly.
      const direct = saveJob('Paquete nocturno a Local sin copia previa', [
        {
          ...ctx.jobs.get(job.id)!.tasks[0],
          id: newId(),
          packageDatabases: [AUTH],
          safetyBackup: false
        }
      ])
      const third = await runJob(ctx, deps, direct.id, 'manual')
      expect(third.status).toBe('success')
      expect(third.tasks.map((t) => [t.schema, t.outputPath])).toEqual([[`${AUTH}${SUFFIX}`, null]])
      expect(await exists(s84, `${AUTH}${SUFFIX}`)).toBe(true)
    }, 240_000)

    it('a package step into production cannot be saved, nor run if the target becomes production', async () => {
      const tasks = ownPackageJob(true)
      expect(() =>
        saveJob('A producción', [...tasks.slice(0, 2), { ...tasks[2], connectionId: prodId }])
      ).toThrow(/producción/)
    })
  }
)
