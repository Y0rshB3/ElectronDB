import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionInput, JobRun } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import { groupBackupPackages, packageRestoreSource } from '@shared/backupPackages'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { envVar } from '@main/env'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { getConnectionManager, getSessionFactory } from '@main/mysql/manager'
import type { MysqlSession } from '@main/mysql/types'
import { createBackupService } from '@main/backup/index'
import { listBackups } from '@main/backup/scan'
import {
  buildAnyRollbackPlan,
  createRollbackInspector,
  prepareRollback
} from '@main/automation/rollback'
import { runJob, startJobWith, type RunnerDeps } from '@main/automation/runner'

/**
 * «Restaurar paquete en Local» end to end through the FILE-based path: a job
 * backs up two schemas on MySQL 5.7, the backups list groups them into one
 * package, and the package's files are restored into MySQL 8.4 (which already
 * holds an older rbf_a) with REPLACE semantics and a safety backup.
 *
 *   VORTAQ_TEST_MYSQL_URL=mysql://root:navidog@127.0.0.1:33306/navidog_test     (8.4)
 *   VORTAQ_TEST_MYSQL57_URL=mysql://root:navidog@127.0.0.1:33357/navidog_test   (5.7)
 */

const url84 = envVar('TEST_MYSQL_URL')
const url57 = envVar('TEST_MYSQL57_URL')
const A = 'rbf_a'
const B = 'rbf_b'

const SETUP_57 = [
  `DROP DATABASE IF EXISTS ${A}`,
  `DROP DATABASE IF EXISTS ${B}`,
  `CREATE DATABASE ${A} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE ${A}.users (id INT PRIMARY KEY, name VARCHAR(60) NOT NULL, note TEXT NULL) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `INSERT INTO ${A}.users VALUES (1, 'ñandú 😀', 'línea ''1'''), (2, 'b', NULL), (3, 'c', 'x')`,
  `CREATE VIEW ${A}.v_users AS SELECT id, name FROM ${A}.users`,
  `CREATE DATABASE ${B} CHARACTER SET utf8mb4`,
  `CREATE TABLE ${B}.items (id INT PRIMARY KEY, qty INT NULL)`,
  `INSERT INTO ${B}.items VALUES (1, 5), (2, NULL), (3, 7), (4, 9)`
]
const SETUP_84 = [
  `DROP DATABASE IF EXISTS ${A}`,
  `DROP DATABASE IF EXISTS ${B}`,
  `CREATE DATABASE ${A}`,
  `CREATE TABLE ${A}.users (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL)`,
  `INSERT INTO ${A}.users VALUES (1, 'old-local')`,
  `CREATE TABLE ${A}.local_only (id INT PRIMARY KEY)`
]

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

async function rows(session: MysqlSession, sql: string): Promise<unknown[]> {
  return (await session.query<Record<string, unknown>>(sql)).map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null ? null : String(v)]))
  )
}

async function objectNames(session: MysqlSession, schema: string): Promise<string[]> {
  const list = await session.query<{ name: string }>(
    'SELECT CONCAT(TABLE_TYPE, ":", TABLE_NAME) AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
    [schema]
  )
  return list.map((r) => r.name).sort()
}

describe.skipIf(!url84 || !url57)(
  'rollback of backup FILES: MySQL 5.7 -> 8.4 (integration)',
  () => {
    let dir: string
    let ctx: AppContext
    let deps: RunnerDeps
    let stagingId: string
    let localId: string
    let s57: MysqlSession
    let s84: MysqlSession
    let backupRun: JobRun
    let restoreRun: JobRun

    beforeAll(async () => {
      const u84 = new URL(url84!)
      const u57 = new URL(url57!)
      dir = mkdtempSync(join(tmpdir(), 'vortaq-rollback-files-it-'))
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
      stagingId = add(u57, 'Staging 5.7', 'staging')
      localId = add(u84, 'Local 8.4', 'local')
      const sessions = getSessionFactory(ctx)
      deps = { backups: createBackupService(ctx, sessions), sessions }
      s57 = await sessions.acquire(stagingId)
      s84 = await sessions.acquire(localId)
      for (const sql of SETUP_57) await s57.execute(sql)
      for (const sql of SETUP_84) await s84.execute(sql)
    }, 120_000)

    afterAll(async () => {
      try {
        for (const db of [A, B]) {
          await s57?.execute(`DROP DATABASE IF EXISTS ${db}`)
          await s84?.execute(`DROP DATABASE IF EXISTS ${db}`)
        }
      } catch {
        /* best effort */
      }
      await s57?.release().catch(() => undefined)
      await s84?.release().catch(() => undefined)
      await getConnectionManager(ctx).closeAll()
      rmSync(dir, { recursive: true, force: true })
    })

    it('a job backs up both schemas and the backups list shows them as one package', async () => {
      const job = ctx.jobs.save({
        name: 'Backup staging',
        continueOnError: false,
        tasks: [A, B].map((schema) => ({
          id: `b-${schema}`,
          type: 'backupschema' as const,
          connectionId: stagingId,
          schema,
          referenceName: `Backup ${schema}`,
          includeData: true
        })),
        schedule: { enabled: false, cron: '', launchAgent: false }
      })
      backupRun = await runJob(ctx, deps, job.id, 'manual')
      expect(backupRun.status).toBe('success')
      const listed = await listBackups(ctx, stagingId)
      expect(listed.map((f) => f.run?.runId)).toEqual([backupRun.id, backupRun.id])
      const { packages } = groupBackupPackages(listed)
      expect(packages).toHaveLength(1)
      expect(packages[0].title).toMatch(/^Backup staging · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    }, 120_000)

    it('restores the package files into 8.4 with REPLACE + safety backup: 8.4 equals 5.7', async () => {
      const listed = await listBackups(ctx, stagingId)
      const source = packageRestoreSource(listed, groupBackupPackages(listed))!
      // A whole run would normally reuse the run rollback; force the file path under test.
      const backupPaths = listed.map((f) => f.path).sort()
      expect(source.kind).toBe('run')
      const files = {
        source: 'files' as const,
        backupPaths,
        sourceConnectionId: stagingId,
        title: 'Paquete staging'
      }
      const inspector = createRollbackInspector(ctx, () => getSessionFactory(ctx))
      const plan = await buildAnyRollbackPlan(ctx, files, localId, inspector)
      expect(plan.items.map((i) => [i.schema, i.targetExists, i.problem])).toEqual([
        [A, true, null],
        [B, false, null]
      ])
      // Files of one job's run: recorded under that job and run.
      expect(plan).toMatchObject({ source: 'files', jobId: backupRun.jobId, runId: backupRun.id })
      const prepared = prepareRollback(
        ctx,
        plan,
        { ...files, targetConnectionId: localId, safetyBackup: true },
        ctx.connections.get(localId)!,
        false
      )
      restoreRun = await startJobWith(ctx, deps, prepared.job, 'manual', prepared.options).done
      expect(restoreRun.tasks.map((t) => [t.status, t.message])).toEqual([
        ['success', null],
        ['success', null]
      ])
      expect(restoreRun).toMatchObject({ status: 'success', kind: 'rollback' })
      expect(ctx.runs.get(restoreRun.id)?.jobId).toBe(backupRun.jobId)

      expect(await objectNames(s84, A)).toEqual(await objectNames(s57, A))
      expect(await objectNames(s84, B)).toEqual(await objectNames(s57, B))
      for (const sql of [
        `SELECT id, name, note FROM ${A}.users ORDER BY id`,
        `SELECT id, name FROM ${A}.v_users ORDER BY id`,
        `SELECT id, qty FROM ${B}.items ORDER BY id`
      ])
        expect(await rows(s84, sql)).toEqual(await rows(s57, sql))

      const log = readFileSync(restoreRun.logPath, 'utf8')
      expect(log).toContain('Inicio de «Restaurar todo en Local 8.4 · Paquete staging»')
      expect(log).toMatch(new RegExp(`Comprobar integridad de la copia \\.+ .*OK`))
      expect(log).not.toContain('ñandú')
    }, 180_000)

    it('kept a safety copy of the old 8.4 rbf_a (rbf_b did not exist: none)', () => {
      const safety = restoreRun.tasks[0].outputPath
      expect(safety).toMatch(/-previo-rollback\.nb3$/)
      expect(safety!.startsWith(join(dir, 'backups', 'Local 8.4', A))).toBe(true)
      expect(existsSync(safety!)).toBe(true)
      expect(restoreRun.tasks[1].outputPath).toBeNull()
    })

    it('refuses a file outside every backup folder before touching 8.4', async () => {
      const inspector = createRollbackInspector(ctx, () => getSessionFactory(ctx))
      await expect(
        buildAnyRollbackPlan(
          ctx,
          {
            source: 'files',
            backupPaths: [join(dir, 'elsewhere.nb3')],
            sourceConnectionId: stagingId
          },
          localId,
          inspector
        )
      ).rejects.toThrow(/no está en la carpeta de copias de seguridad de ninguna conexión/)
    })
  }
)
