import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionInput, JobTask } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import { buildCopyRestoreSteps, type CopyRestoreRecipe } from '@shared/jobRecipes'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { envVar } from '@main/env'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { getConnectionManager, getSessionFactory } from '@main/mysql/manager'
import type { MysqlSession } from '@main/mysql/types'
import { createBackupService } from '@main/backup/index'
import { runJob, type RunnerDeps } from '@main/automation/runner'
import { validateJobInput } from '@main/ipc/jobValidation'

/**
 * «Copiar y restaurar» end to end in a scratch profile: a job built by the
 * editor's recipe (shared/jobRecipes.ts) copies two databases of «Staging»
 * (MySQL 5.7) and restores them into «Local» (MySQL 8.4) in the same run,
 * first with a safety copy of the destination, then without one.
 *
 *   VORTAQ_TEST_MYSQL_URL=mysql://root:navidog@127.0.0.1:33306/navidog_test     (8.4)
 *   VORTAQ_TEST_MYSQL57_URL=mysql://root:navidog@127.0.0.1:33357/navidog_test   (5.7)
 */

const url84 = envVar('TEST_MYSQL_URL')
const url57 = envVar('TEST_MYSQL57_URL')
const VENTAS = 'cr_ventas'
const AUTH = 'cr_auth'
/** Restore target of cr_auth on Local (renamed in the recipe). */
const AUTH_LOCAL = 'cr_auth_local'

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
  '«Copiar y restaurar»: Staging 5.7 -> Local 8.4 (integration)',
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
    const newId = () => `cr-${++ids}`

    const rows = async (s: MysqlSession, sql: string) => s.query<Record<string, unknown>>(sql)

    function recipe(overrides: Partial<CopyRestoreRecipe> = {}): CopyRestoreRecipe {
      return {
        sourceConnectionId: stagingId,
        targetConnectionId: localId,
        databases: [
          { name: VENTAS, target: VENTAS },
          { name: AUTH, target: AUTH_LOCAL }
        ],
        safetyBackup: true,
        includeData: true,
        ...overrides
      }
    }

    function saveRecipeJob(name: string, tasks: JobTask[]) {
      const input = {
        name,
        continueOnError: false,
        tasks,
        schedule: { enabled: true, cron: '0 2 * * *', launchAgent: false }
      }
      validateJobInput(input, (id) => ctx.connections.get(id))
      return ctx.jobs.save(input)
    }

    const nameOf = (id: string) => ctx.connections.get(id)?.name ?? ''

    beforeAll(async () => {
      const u84 = new URL(url84!)
      const u57 = new URL(url57!)
      dir = mkdtempSync(join(tmpdir(), 'vortaq-recipe-it-'))
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
      // Local holds an older cr_ventas that the restore replaces (and the safety copy keeps).
      for (const sql of [
        `DROP DATABASE IF EXISTS ${VENTAS}`,
        `DROP DATABASE IF EXISTS ${AUTH_LOCAL}`,
        `CREATE DATABASE ${VENTAS}`,
        `CREATE TABLE ${VENTAS}.solo_local (id INT PRIMARY KEY)`,
        `INSERT INTO ${VENTAS}.solo_local VALUES (42)`
      ])
        await s84.execute(sql)
    }, 120_000)

    afterAll(async () => {
      try {
        for (const db of [VENTAS, AUTH]) await s57?.execute(`DROP DATABASE IF EXISTS ${db}`)
        for (const db of [VENTAS, AUTH_LOCAL]) await s84?.execute(`DROP DATABASE IF EXISTS ${db}`)
      } catch {
        /* best effort */
      }
      await s57?.release().catch(() => undefined)
      await s84?.release().catch(() => undefined)
      await getConnectionManager(ctx).closeAll()
      rmSync(dir, { recursive: true, force: true })
    })

    it('with a safety copy: copies both databases, then replaces them in Local', async () => {
      const tasks = buildCopyRestoreSteps(recipe(), nameOf, newId)
      expect(tasks.map((t) => t.referenceName)).toEqual([
        'Copia de cr_ventas (Staging)',
        'Copia de cr_auth (Staging)',
        'Restaurar cr_ventas en Local',
        'Restaurar cr_auth_local en Local'
      ])
      const job = saveRecipeJob('Staging a Local', tasks)
      const run = await runJob(ctx, deps, job.id, 'manual')
      expect(run.tasks.map((t) => [t.referenceName, t.status])).toEqual(
        tasks.map((t) => [t.referenceName, 'success'])
      )
      expect(run.status).toBe('success')
      // The copies are .vqb files of this run.
      expect(run.tasks.slice(0, 2).every((t) => t.outputPath?.endsWith('.vqb'))).toBe(true)
      expect(run.tasks.slice(0, 2).every((t) => existsSync(t.outputPath!))).toBe(true)
      // The existing cr_ventas of Local was saved before it was replaced.
      expect(run.tasks[2].outputPath && existsSync(run.tasks[2].outputPath)).toBe(true)

      expect(
        await rows(s84, `SELECT id, cliente, total FROM ${VENTAS}.pedidos ORDER BY id`)
      ).toEqual(await rows(s57, `SELECT id, cliente, total FROM ${VENTAS}.pedidos ORDER BY id`))
      expect(await rows(s84, `SELECT id FROM ${VENTAS}.v_grandes ORDER BY id`)).toEqual([
        { id: 1 },
        { id: 2 }
      ])
      const [{ n }] = await rows(
        s84,
        `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${VENTAS}' AND TABLE_NAME = 'solo_local'`
      )
      expect(Number(n)).toBe(0)
      expect(await rows(s84, `SELECT email FROM ${AUTH_LOCAL}.usuarios ORDER BY id`)).toEqual([
        { email: 'a@example.test' },
        { email: 'b@example.test' }
      ])
    }, 180_000)

    it('without a safety copy: the next run brings the new rows and keeps no copy of Local', async () => {
      await s57.execute(`INSERT INTO ${VENTAS}.pedidos VALUES (4, 'Diego', 99.99)`)
      const tasks = buildCopyRestoreSteps(recipe({ safetyBackup: false }), nameOf, newId)
      expect(tasks.filter((t) => t.type === 'restoreschema').map((t) => t.safetyBackup)).toEqual([
        false,
        false
      ])
      const job = saveRecipeJob('Staging a Local sin copia previa', tasks)
      const run = await runJob(ctx, deps, job.id, 'manual')
      expect(run.status).toBe('success')
      expect(run.tasks.slice(2).map((t) => t.outputPath)).toEqual([null, null])
      const [{ n }] = await rows(s84, `SELECT COUNT(*) AS n FROM ${VENTAS}.pedidos`)
      expect(Number(n)).toBe(4)
    }, 180_000)

    it('structure only: the destination keeps the tables, empty', async () => {
      const tasks = buildCopyRestoreSteps(
        recipe({ includeData: false, databases: [{ name: AUTH, target: AUTH_LOCAL }] }),
        nameOf,
        newId
      )
      const job = saveRecipeJob('Solo estructura', tasks)
      const run = await runJob(ctx, deps, job.id, 'manual')
      expect(run.status).toBe('success')
      const [{ n }] = await rows(s84, `SELECT COUNT(*) AS n FROM ${AUTH_LOCAL}.usuarios`)
      expect(Number(n)).toBe(0)
    }, 180_000)

    it('a recipe into production cannot be saved', () => {
      const tasks = buildCopyRestoreSteps(recipe({ targetConnectionId: prodId }), nameOf, newId)
      expect(() => saveRecipeJob('A producción', tasks)).toThrow(/producción/)
    })
  }
)
