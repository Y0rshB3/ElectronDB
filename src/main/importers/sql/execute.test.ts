import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SQL_IMPORT_CANCELLED, type SqlDumpImportOptions } from '@shared/importers'
import type { ProgressEvent } from '@shared/types'
import { importSqlDump, IMPORT_PRODUCTION_MESSAGE } from './execute'
import { testDeps, type DumpSession, type TestDeps } from './testing'

const FIXTURES = join(__dirname, '../../../../tests/fixtures/importers/sql')
const fixture = (name: string): string => join(FIXTURES, name)

type Event = Omit<ProgressEvent, 'operationId' | 'kind'>

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'vortaq-sqlimp-unit-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function write(name: string, text: string | Buffer): string {
  const path = join(dir, name)
  writeFileSync(path, text)
  return path
}

function configure(deps: TestDeps, fn: (s: DumpSession) => void): void {
  const prev = deps.sessions.setup
  deps.sessions.setup = (s) => {
    prev(s)
    fn(s)
  }
}

const options = (overrides: Partial<SqlDumpImportOptions>): SqlDumpImportOptions => ({
  path: fixture('mysqldump-8.sql'),
  connectionId: 'conn-1',
  mode: 'intoSchema',
  targetSchema: 'destino',
  createSchema: true,
  replaceSchema: false,
  safetyBackup: true,
  continueOnError: false,
  ...overrides
})

async function run(deps: TestDeps, opts: Partial<SqlDumpImportOptions>, signal?: AbortSignal) {
  const events: Event[] = []
  const result = await importSqlDump(deps, options(opts), (e) => events.push(e), signal)
  return { result, events, session: deps.sessions.sessions[0] }
}

describe('importSqlDump', () => {
  it('runs a mysqldump file into the target schema with counts and progress', async () => {
    const deps = testDeps()
    const { result, events, session } = await run(deps, {})
    expect(result.errors).toEqual([])
    expect(result.created).toMatchObject({
      tables: 2,
      views: 1,
      routines: 2,
      triggers: 1,
      events: 1
    })
    // 3 + 2 rows
    expect(result.rowsAffected).toBe(5)
    expect(result.databases).toEqual(['destino'])
    expect(result.bytesRead).toBe(result.bytesTotal)
    expect(session.released).toBe(true)
    expect(session.executed.slice(0, 3)).toEqual([
      'CREATE DATABASE IF NOT EXISTS `destino`',
      'USE destino',
      'SET NAMES utf8mb4'
    ])
    // statements go to the server as written (conditional comments included)
    expect(session.executed).toContain('/*!40000 ALTER TABLE `clientes` DISABLE KEYS */')
    expect(session.executed.some((s) => s.endsWith('LOCK TABLES `clientes` WRITE'))).toBe(true)
    // session state put back
    expect(session.executed.slice(-3)).toEqual([
      'SET FOREIGN_KEY_CHECKS = 1',
      'SET UNIQUE_CHECKS = 1',
      'SET SQL_MODE = ? -- ["STRICT_TRANS_TABLES"]'
    ])
    const phases = events.map((e) => e.phase)
    expect(phases[0]).toBe('start')
    expect(phases.at(-1)).toBe('finish')
    expect(phases).toContain('database')
    expect(events.filter((e) => e.phase === 'object').map((e) => e.message)).toContain(
      'Tabla clientes creada'
    )
    expect(
      events.find((e) => e.phase === 'object' && e.detail?.objectType === 'Trigger')
    ).toMatchObject({
      message: 'Trigger pedidos_bi creado',
      detail: { objectName: 'pedidos_bi' }
    })
    const currents = events.map((e) => e.current)
    expect(currents).toEqual([...currents].sort((a, b) => a - b))
    expect(events.every((e) => e.total === result.bytesTotal)).toBe(true)
  })

  it('strips a DEFINER wrapped in conditional comments when the account does not exist', async () => {
    const deps = testDeps()
    const { result, events, session } = await run(deps, {})
    expect(result.errors).toEqual([])
    const trigger = session.executed.find((s) => s.includes('TRIGGER `pedidos_bi`'))!
    expect(trigger).not.toMatch(/DEFINER\s*=/)
    expect(trigger).toContain('/*!50017*/')
    const view = session.executed.find((s) => s.includes('VIEW `v_resumen` AS select'))!
    expect(view).toContain('/*!50013 SQL SECURITY DEFINER */')
    const fn = session.executed.find((s) => s.includes('FUNCTION `iva`'))!
    expect(fn.startsWith('CREATE FUNCTION')).toBe(true)
    expect(events.filter((e) => e.phase === 'warning').map((e) => e.message)).toEqual([
      'El DEFINER app_owner@% no existe o no se puede usar en el destino: los objetos se crean con el usuario de la conexión.'
    ])
  })

  it('keeps the DEFINER when the account exists and retries without it on failure', async () => {
    const deps = testDeps()
    configure(deps, (s) => {
      s.accounts = null // unknown: keep the DDL as it is
      s.fail = (sql) =>
        /DEFINER\s*=/.test(sql) && sql.includes('PROCEDURE')
          ? Object.assign(new Error('Access denied; you need SUPER'), { errno: 1227 })
          : null
    })
    const { result, session } = await run(deps, {})
    expect(result.errors).toEqual([])
    expect(session.executed.find((s) => s.includes('FUNCTION `iva`'))).toContain(
      'DEFINER=`app_owner`@`%`'
    )
    expect(session.executed.find((s) => s.includes('PROCEDURE `alta_cliente`'))).not.toContain(
      'DEFINER'
    )
  })

  it('redirects USE and skips CREATE DATABASE in intoSchema mode, warning for several databases', async () => {
    const deps = testDeps()
    const { result, events, session } = await run(deps, { path: fixture('two-databases.sql') })
    expect(result.skipped).toBe(2)
    expect(session.executed.filter((s) => s.startsWith('USE'))).toEqual([
      'USE destino',
      'USE `destino`',
      'USE `destino`'
    ])
    expect(session.executed.some((s) => /CREATE DATABASE[^\n]*ventas/.test(s))).toBe(false)
    expect(result.databases).toEqual(['destino'])
    expect(events.filter((e) => e.phase === 'warning')[0].message).toMatch(
      /varias bases de datos \(ventas, crm\): todo se importa en destino/
    )
  })

  it('runs USE and CREATE DATABASE as written in asFile mode and tracks the databases', async () => {
    const deps = testDeps()
    const { result, events, session } = await run(deps, {
      path: fixture('two-databases.sql'),
      mode: 'asFile',
      targetSchema: null,
      createSchema: false
    })
    expect(result.errors).toEqual([])
    expect(result.databases).toEqual(['ventas', 'crm'])
    expect(result.created.databases).toBe(2)
    expect(session.executed).toContain('USE `crm`')
    expect(events.filter((e) => e.phase === 'database').map((e) => e.message)).toEqual([
      'Base de datos ventas',
      'Base de datos crm'
    ])
    expect(events.some((e) => e.phase === 'warning')).toBe(false)
  })

  it('reports errors with their line numbers and stops at the first one by default', async () => {
    const deps = testDeps()
    configure(deps, (s) => {
      s.fail = (sql) =>
        sql.includes('t_missing')
          ? Object.assign(new Error("Table 'destino.t_missing' doesn't exist"), { errno: 1146 })
          : sql.startsWith('THIS')
            ? Object.assign(new Error('You have an error in your SQL syntax'), { errno: 1064 })
            : null
    })
    const stopped = await run(deps, { path: fixture('errors.sql') })
    expect(stopped.result.errors).toHaveLength(1)
    expect(stopped.result.errors[0]).toMatchObject({
      line: 5,
      statement: 'INSERT INTO t_missing VALUES (2)'
    })
    expect(stopped.result.errors[0].message).toMatch(/t_missing/)
    expect(stopped.result.executed).toBe(2)
    expect(stopped.events.find((e) => e.phase === 'objectError')).toMatchObject({
      message: 'Error en la línea 5',
      detail: { objectName: 'INSERT INTO t_missing VALUES (2)' }
    })

    const deps2 = testDeps()
    configure(deps2, (s) => {
      s.fail = (sql) =>
        sql.includes('t_missing') || sql.startsWith('THIS') ? new Error('falla') : null
    })
    const all = await run(deps2, { path: fixture('errors.sql'), continueOnError: true })
    expect(all.result.errors.map((e) => e.line)).toEqual([5, 7])
    expect(all.result.executed).toBe(4)
    expect(all.result.rowsAffected).toBe(3)
  })

  it('reads gzip files as a stream with byte progress on the compressed file', async () => {
    const text = readFileSync(fixture('mysqldump-8.sql'))
    const gz = write('dump.sql.gz', gzipSync(text))
    const deps = testDeps()
    const { result } = await run(deps, { path: gz })
    expect(result.errors).toEqual([])
    expect(result.created.tables).toBe(2)
    expect(result.bytesTotal).toBe(gzipSync(text).length)
    expect(result.bytesRead).toBe(result.bytesTotal)
  })

  it('reads a file whose multibyte characters span read chunks', async () => {
    const rows = Array.from({ length: 30_000 }, (_, i) => `(${i},'ñandú😀${i}')`).join(',')
    const path = write(
      'big.sql',
      `\uFEFFCREATE TABLE t (id INT, s TEXT);\nINSERT INTO t VALUES ${rows};\n`
    )
    const deps = testDeps()
    const { result, session } = await run(deps, { path })
    expect(result.errors).toEqual([])
    expect(result.rowsAffected).toBe(30_000)
    const insert = session.executed.find((s) => s.startsWith('INSERT'))!
    expect(insert).toContain("(29999,'ñandú😀29999')")
    expect(insert).not.toContain('�')
    expect(session.executed).toContain('CREATE TABLE t (id INT, s TEXT)')
  })

  it('sends raw bytes unchanged (BLOB bytes that are not UTF-8)', async () => {
    const bytes = Buffer.concat([
      Buffer.from("CREATE TABLE b (id INT, d BLOB, s TEXT);\nINSERT INTO b VALUES (1,'", 'utf8'),
      Buffer.from([0x00, 0xff, 0xfe, 0x80, 0xc3]),
      Buffer.from("','ñandú 😀');\nSELECT 1 AS à;\n", 'utf8')
    ])
    const path = write('raw.sql', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]))
    const deps = testDeps()
    const { result, session } = await run(deps, { path })
    expect(result.errors).toEqual([])
    const insert = session.raw.find((s) => s.startsWith('INSERT'))!
    expect(Buffer.from(insert, 'latin1')).toEqual(
      bytes.subarray(bytes.indexOf('INSERT'), bytes.indexOf(';\nSELECT'))
    )
    // the NBSP byte of a UTF-8 character at the end of a statement is kept
    const tail = session.raw.find((s) => s.startsWith('SELECT'))!
    expect(Buffer.from(tail, 'latin1').toString('utf8')).toBe('SELECT 1 AS à')
    expect(result.created.tables).toBe(1)
  })

  it('falls back to UTF-8 text on sessions without executeRaw', async () => {
    const deps = testDeps()
    configure(deps, (s) => {
      s.executeRaw = undefined
    })
    const { result, session } = await run(deps, { path: fixture('two-databases.sql') })
    expect(result.errors).toEqual([])
    expect(session.raw).toEqual([])
    expect(session.executed).toContain('USE `destino`')
  })

  it('cancels mid-file: throws, stops executing and releases the session', async () => {
    const deps = testDeps()
    const controller = new AbortController()
    configure(deps, (s) => {
      s.onExecute = (sql) => {
        if (sql.includes('CREATE TABLE `pedidos`')) controller.abort()
      }
    })
    await expect(run(deps, {}, controller.signal)).rejects.toThrow(SQL_IMPORT_CANCELLED)
    const session = deps.sessions.sessions[0]
    expect(session.released).toBe(true)
    expect(session.executed.some((s) => s.includes('INSERT INTO `pedidos`'))).toBe(false)
  })

  it('takes the safety copy before dropping the replaced database', async () => {
    const deps = testDeps()
    configure(deps, (s) => s.schemas.add('destino'))
    const { result } = await run(deps, { replaceSchema: true })
    expect(deps.backupCalls).toEqual([
      { connectionId: 'conn-1', schema: 'destino', includeData: true, label: 'previo-importacion' }
    ])
    expect(result.safetyBackupPath).toBe('/tmp/destino-previo.nb3')
    const backupAt = deps.timeline.indexOf('backup:destino')
    const dropAt = deps.timeline.indexOf('DROP DATABASE IF EXISTS `destino`')
    expect(backupAt).toBeGreaterThanOrEqual(0)
    expect(dropAt).toBeGreaterThan(backupAt)
    expect(deps.timeline[dropAt + 1]).toBe(
      'CREATE DATABASE `destino` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci'
    )
  })

  it('touches nothing when the safety copy fails', async () => {
    const deps = testDeps()
    configure(deps, (s) => s.schemas.add('destino'))
    deps.backups.create = async () => {
      throw new Error('disco lleno')
    }
    await expect(run(deps, { replaceSchema: true })).rejects.toThrow(
      /copia previa.*no se ha tocado nada/
    )
    expect(deps.timeline.some((s) => s.startsWith('DROP'))).toBe(false)
  })

  it('skips the safety copy for a database that does not exist yet', async () => {
    const deps = testDeps()
    await run(deps, { replaceSchema: true })
    expect(deps.backupCalls).toEqual([])
  })

  it('refuses production without confirmation, system schemas and bad options', async () => {
    const prod = testDeps({ environment: 'production' })
    await expect(run(prod, {})).rejects.toThrow(IMPORT_PRODUCTION_MESSAGE)
    expect(prod.sessions.sessions).toHaveLength(0)
    await expect(run(prod, { confirmProduction: true })).resolves.toBeTruthy()
    const deps = testDeps()
    await expect(run(deps, { targetSchema: 'mysql' })).rejects.toThrow(/sistema/)
    await expect(run(deps, { targetSchema: '' })).rejects.toThrow(/esquema de destino/)
    await expect(run(deps, { mode: 'asFile', replaceSchema: true })).rejects.toThrow(/Reemplazar/)
    await expect(run(deps, { connectionId: 'nope' })).rejects.toThrow(/ya no existe/)
    await expect(run(deps, { path: join(dir, 'missing.sql') })).rejects.toThrow(/No se encontró/)
  })

  it('refuses engines without backups', async () => {
    const deps = testDeps({ engine: 'postgresql' })
    await expect(run(deps, {})).rejects.toThrow()
  })

  it('retries a 5.7 sql_mode with NO_AUTO_CREATE_USER without it', async () => {
    const path = write(
      'mode.sql',
      "/*!50003 SET sql_mode = 'STRICT_TRANS_TABLES,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION' */ ;\nSELECT 1;\n"
    )
    const deps = testDeps()
    configure(deps, (s) => {
      s.fail = (sql) =>
        sql.includes('NO_AUTO_CREATE_USER')
          ? Object.assign(new Error("Variable 'sql_mode' can't be set"), { errno: 1231 })
          : null
    })
    const { result, session } = await run(deps, { path })
    expect(result.errors).toEqual([])
    expect(session.executed).toContain(
      "/*!50003 SET sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION' */"
    )
  })

  it('imports the other tool styles without errors', async () => {
    for (const name of [
      'phpmyadmin.sql',
      'heidisql.sql',
      'adminer.sql',
      'dbeaver-style.sql',
      'workbench-style.sql',
      'tableplus-style.sql',
      'mysqldump-databases.sql'
    ]) {
      const deps = testDeps()
      const { result } = await run(deps, { path: fixture(name) })
      expect(result.errors, name).toEqual([])
      expect(result.created.tables, name).toBeGreaterThan(0)
    }
  })
})
