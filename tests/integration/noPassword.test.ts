import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnection } from 'mysql2/promise'
import type { ConnectionInput } from '@shared/types'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { envVar } from '@main/env'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { ConnectionManager } from '@main/mysql/manager'

/**
 * Connections that need no password (auth proxies, users with an empty
 * password). Runs against every configured server:
 *   VORTAQ_TEST_MYSQL_URL=mysql://root:navidog@127.0.0.1:33306/navidog_test     (8.4)
 *   VORTAQ_TEST_MYSQL57_URL=mysql://root:navidog@127.0.0.1:33357/navidog_test   (5.7)
 * Creates the throwaway users nd_nopass (empty password) and nd_pass, and drops them.
 */
const servers = [
  { label: 'MySQL 8.4', url: envVar('TEST_MYSQL_URL') },
  { label: 'MySQL 5.7', url: envVar('TEST_MYSQL57_URL') }
]

const NO_PASS = 'nd_nopass'
const WITH_PASS = 'nd_pass'
const WITH_PASS_SECRET = 'nd_pass_Secret1'

for (const server of servers) {
  describe.skipIf(!server.url)(`connections without a password (${server.label})`, () => {
    const u = new URL(server.url ?? 'mysql://x@localhost/x')
    const db = u.pathname.slice(1)
    let dir: string
    let ctx: AppContext
    let manager: ConnectionManager

    const admin = () =>
      createConnection({
        host: u.hostname,
        port: Number(u.port || 3306),
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password)
      })

    const input = (overrides: Partial<ConnectionInput>): ConnectionInput => ({
      name: 'Sin clave',
      color: null,
      environment: 'local',
      host: u.hostname,
      port: Number(u.port || 3306),
      username: NO_PASS,
      savePassword: false,
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
      backupDir: join(tmpdir(), 'vortaq-it-nopass'),
      extraBackupDirs: [],
      ...overrides
    })

    beforeAll(async () => {
      const conn = await admin()
      try {
        for (const user of [NO_PASS, WITH_PASS])
          await conn.query(`DROP USER IF EXISTS '${user}'@'%'`)
        await conn.query(`CREATE USER '${NO_PASS}'@'%' IDENTIFIED BY ''`)
        await conn.query(`CREATE USER '${WITH_PASS}'@'%' IDENTIFIED BY '${WITH_PASS_SECRET}'`)
        for (const user of [NO_PASS, WITH_PASS])
          await conn.query(`GRANT SELECT ON \`${db}\`.* TO '${user}'@'%'`)
      } finally {
        await conn.end()
      }
      dir = mkdtempSync(join(tmpdir(), 'vortaq-it-nopass-'))
      ctx = {
        userDataPath: dir,
        logDir: join(dir, 'logs'),
        connections: new ConnectionsRepo(dir),
        jobs: new JobsRepo(dir),
        runs: new RunsRepo(dir),
        settings: new SettingsRepo(dir, dir),
        credentials: new CredentialStore(dir, plainCodec, 'plain'),
        emit: () => undefined,
        headless: true
      }
      manager = new ConnectionManager(ctx)
    })

    afterAll(async () => {
      await manager?.closeAll()
      const conn = await admin()
      try {
        for (const user of [NO_PASS, WITH_PASS])
          await conn.query(`DROP USER IF EXISTS '${user}'@'%'`)
      } finally {
        await conn.end()
      }
      if (dir) rmSync(dir, { recursive: true, force: true })
    })

    async function whoAmI(id: string): Promise<string> {
      const session = await manager.acquire(id, db)
      try {
        const [rows] = await (await manager.getPool(id)).query('SELECT CURRENT_USER() AS u')
        return String((rows as { u: string }[])[0].u)
      } finally {
        await session.release()
      }
    }

    it("authMode 'none' connects a user with an empty password", async () => {
      const id = ctx.connections.save(input({ name: 'Proxy', authMode: 'none' })).id
      const info = await manager.open(id)
      expect(info.version).toBeTruthy()
      expect(await whoAmI(id)).toMatch(new RegExp(`^${NO_PASS}@`))
      const test = await manager.test(input({ authMode: 'none' }), null, null)
      expect(test).toMatchObject({ ok: true })
      expect(test.connectedWithoutPassword).toBeUndefined()
    })

    it('password mode with nothing stored connects through the empty attempt', async () => {
      const id = ctx.connections.save(input({ name: 'Legado' })).id // no authMode: legacy record
      await manager.open(id)
      expect(await whoAmI(id)).toMatch(new RegExp(`^${NO_PASS}@`))
      const test = await manager.test(input({ authMode: 'password' }), null, null)
      expect(test).toMatchObject({ ok: true, connectedWithoutPassword: true })
    })

    it('a user that needs a password and has none stored gets the actionable error', async () => {
      const id = ctx.connections.save(
        input({ name: 'Con clave', username: WITH_PASS, authMode: 'password' })
      ).id
      await expect(manager.open(id)).rejects.toThrow(
        'No hay contraseña guardada para la conexión Con clave: escríbela en la conexión o marca «Sin contraseña»'
      )
      expect(manager.isOpen(id)).toBe(false)
      const test = await manager.test(input({ name: 'Con clave', username: WITH_PASS }), null, null)
      expect(test.ok).toBe(false)
      expect(test.error).toContain('marca «Sin contraseña»')
      // With the password it works, proving the error was only the missing secret.
      ctx.credentials.set('mysql', id, WITH_PASS_SECRET)
      await manager.open(id)
      expect(await whoAmI(id)).toMatch(new RegExp(`^${WITH_PASS}@`))
    })
  })
}
