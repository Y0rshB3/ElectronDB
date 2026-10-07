import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SQL_IMPORT_CANCELLED } from '@shared/importers'
import type { ProgressEvent } from '@shared/types'
import { importSqlFolder, previewSqlFolder, schemaFromFileName } from './folder'
import { testDeps } from './testing'

const FIXTURES = join(__dirname, '../../../../tests/fixtures/importers/sql')

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'vortaq-sqlfolder-'))
  copyFileSync(join(FIXTURES, 'adminer.sql'), join(dir, 'notas.sql'))
  writeFileSync(
    join(dir, 'Tareas.SQL.GZ'),
    gzipSync('CREATE TABLE t (id INT);\nINSERT INTO t VALUES (1),(2);\n')
  )
  writeFileSync(join(dir, 'leeme.txt'), 'no')
  writeFileSync(join(dir, '.oculto.sql'), 'SELECT 1;')
  mkdirSync(join(dir, 'sub.sql'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('previewSqlFolder', () => {
  it('lists .sql and .sql.gz files with a database per file', async () => {
    const p = await previewSqlFolder(dir)
    expect(p.items.map((i) => [i.fileName, i.schema])).toEqual([
      ['notas.sql', 'notas'],
      ['Tareas.SQL.GZ', 'Tareas']
    ])
    expect(p.warnings).toEqual(['Se ignora leeme.txt: no es .sql ni .sql.gz'])
    expect(schemaFromFileName(' a b .sql.gz')).toBe('a b')
  })

  it('fails with an actionable message for empty or missing folders', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'vortaq-sqlfolder-empty-'))
    await expect(previewSqlFolder(empty)).rejects.toThrow(/no contiene archivos .sql/)
    rmSync(empty, { recursive: true })
    await expect(previewSqlFolder(join(dir, 'nope'))).rejects.toThrow(/No se encontró/)
  })
})

describe('importSqlFolder', () => {
  const request = (overrides = {}) => ({
    dir,
    connectionId: 'conn-1',
    items: [
      { path: join(dir, 'notas.sql'), schema: 'notas_local' },
      { path: join(dir, 'Tareas.SQL.GZ'), schema: 'tareas_local' }
    ],
    replaceSchema: false,
    safetyBackup: true,
    continueOnError: false,
    ...overrides
  })

  it('imports each file into its database with cumulative byte progress', async () => {
    const deps = testDeps()
    const events: Omit<ProgressEvent, 'operationId' | 'kind'>[] = []
    const r = await importSqlFolder(deps, request(), (e) => events.push(e))
    expect(r.items.map((i) => [i.schema, i.error, i.result?.errors.length])).toEqual([
      ['notas_local', null, 0],
      ['tareas_local', null, 0]
    ])
    expect(r.items[1].result!.rowsAffected).toBe(2)
    expect(deps.sessions.sessions.map((s) => s.executed[0])).toEqual([
      'CREATE DATABASE IF NOT EXISTS `notas_local`',
      'CREATE DATABASE IF NOT EXISTS `tareas_local`'
    ])
    const files = events.filter((e) => e.phase === 'file').map((e) => e.message)
    expect(files).toEqual([
      'Archivo 1/2: notas.sql → notas_local',
      'Archivo 2/2: Tareas.SQL.GZ → tareas_local'
    ])
    expect(events.find((e) => e.phase === 'object')?.message).toBe(
      'notas_local · Tabla notas creada'
    )
    const total = events[0].total!
    expect(events.every((e) => e.total === total)).toBe(true)
    const currents = events.map((e) => e.current)
    expect(currents).toEqual([...currents].sort((a, b) => a - b))
    expect(currents.at(-1)).toBe(total)
  })

  it('stops after a failing file unless continueOnError', async () => {
    const deps = testDeps()
    const prev = deps.sessions.setup
    deps.sessions.setup = (s) => {
      prev(s)
      s.fail = (sql) => (sql.startsWith('CREATE TABLE `notas`') ? new Error('falla') : null)
    }
    const r = await importSqlFolder(deps, request())
    expect(r.items[0].result!.errors).toHaveLength(1)
    expect(r.items[1]).toMatchObject({ result: null, error: 'Omitido tras el error anterior' })
    const r2 = await importSqlFolder(deps, request({ continueOnError: true }))
    expect(r2.items[1].result!.errors).toEqual([])
  })

  it('validates the items', async () => {
    const deps = testDeps()
    await expect(
      importSqlFolder(deps, request({ items: [{ path: join(dir, 'notas.sql'), schema: ' ' }] }))
    ).rejects.toThrow(/Indica la base de datos/)
    await expect(
      importSqlFolder(
        deps,
        request({
          items: [
            { path: join(dir, 'notas.sql'), schema: 'A' },
            { path: join(dir, 'Tareas.SQL.GZ'), schema: 'a' }
          ]
        })
      )
    ).rejects.toThrow(/más de un archivo/)
    await expect(
      importSqlFolder(deps, request({ items: [{ path: join(dir, 'notas.sql'), schema: 'sys' }] }))
    ).rejects.toThrow(/sistema/)
    await expect(
      importSqlFolder(
        deps,
        request({ items: [{ path: join(FIXTURES, 'adminer.sql'), schema: 'x' }] })
      )
    ).rejects.toThrow(/carpeta elegida/)
    expect(deps.sessions.sessions).toHaveLength(0)
  })

  it('throws on cancel', async () => {
    const deps = testDeps()
    const controller = new AbortController()
    controller.abort()
    await expect(importSqlFolder(deps, request(), () => {}, controller.signal)).rejects.toThrow(
      SQL_IMPORT_CANCELLED
    )
  })
})
