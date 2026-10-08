import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteCore, SqliteCoreError, bindable, normalizeValue, toWorkerError } from './core'
import type { OpenRequest } from './protocol'

let dir: string
const open = (over: Partial<OpenRequest> = {}): OpenRequest => ({
  filePath: join(dir, 'app.db'),
  readOnly: false,
  foreignKeys: false,
  busyTimeoutMs: 1000,
  attached: [],
  initialStatements: [],
  queryOnly: false,
  ...over
})

function makeDb(name: string, sql = 'CREATE TABLE t (id INTEGER PRIMARY KEY, v)'): string {
  const core = new SqliteCore()
  const path = join(dir, name)
  core.open(open({ filePath: path, create: true }))
  core.query(sql)
  core.close()
  return path
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vortaq-sqlite-core-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('SqliteCore: opening never creates a file (invariant 8)', () => {
  it('refuses a missing file and leaves nothing behind', () => {
    const core = new SqliteCore()
    expect(() => core.open(open({ filePath: join(dir, 'typo.db') }))).toThrow(
      'Archivo no encontrado: typo.db'
    )
    expect(readdirSync(dir)).toEqual([])
  })

  it('refuses relative and foreign-OS paths without touching the cwd', () => {
    const core = new SqliteCore()
    const before = readdirSync(process.cwd())
    expect(() => core.open(open({ filePath: 'relative.db' }))).toThrow(SqliteCoreError)
    if (process.platform !== 'win32')
      expect(() => core.open(open({ filePath: 'C:\\Users\\x\\typo.db' }))).toThrow(
        'no válido en este equipo'
      )
    expect(readdirSync(process.cwd())).toEqual(before)
  })

  it('refuses a missing attachment and a folder', () => {
    const main = makeDb('main.db')
    const core = new SqliteCore()
    expect(() =>
      core.open(
        open({ filePath: main, attached: [{ alias: 'aux', filePath: join(dir, 'no.db') }] })
      )
    ).toThrow('Base de datos adjunta «aux» no encontrado')
    expect(existsSync(join(dir, 'no.db'))).toBe(false)
    expect(() => core.open(open({ filePath: dir }))).toThrow('no es un archivo')
  })

  it('creates only on request, never over an existing file, and writes the header', () => {
    const path = makeDb('new.db')
    expect(existsSync(path)).toBe(true)
    const core = new SqliteCore()
    expect(() => core.open(open({ filePath: path, create: true }))).toThrow('Ya existe un archivo')
    const fresh = new SqliteCore()
    fresh.open(open({ filePath: join(dir, 'empty.db'), create: true }))
    fresh.close()
    expect(existsSync(join(dir, 'empty.db'))).toBe(true)
  })

  it('denies ATTACH of a missing or relative path from SQL, allows existing files and :memory:', () => {
    const main = makeDb('m.db')
    const other = makeDb('other.db')
    const core = new SqliteCore()
    core.open(open({ filePath: main }))
    expect(() => core.runStatement(`ATTACH '${join(dir, 'ghost.db')}' AS g`, 10)).toThrow(
      'ATTACH rechazado'
    )
    expect(() => core.runStatement(`ATTACH 'rel.db' AS r`, 10)).toThrow('ATTACH rechazado')
    expect(() => core.runStatement(`ATTACH ('${dir}/' || 'x.db') AS e`, 10)).toThrow(
      'ATTACH rechazado'
    )
    expect(existsSync(join(dir, 'ghost.db'))).toBe(false)
    core.runStatement(`ATTACH '${other}' AS o`, 10)
    core.runStatement(`ATTACH ':memory:' AS mem`, 10)
    const names = core.query('SELECT name FROM pragma_database_list').rows.map((r) => r.name)
    expect(names).toEqual(['main', 'o', 'mem'])
    core.close()
  })
})

describe('SqliteCore: modes and options', () => {
  it('opens read-only, and falls back to read-only for an unwritable file', () => {
    const path = makeDb('ro.db')
    const core = new SqliteCore()
    expect(core.open(open({ filePath: path, readOnly: true }))).toMatchObject({ readOnly: true })
    expect(() => core.runStatement('INSERT INTO t (v) VALUES (1)', 1)).toThrow(/readonly/)
    core.close()
  })

  it('applies foreign_keys, busy timeout, query_only, attachments and initial statements', () => {
    const main = makeDb('fk.db')
    const aux = makeDb('aux.db')
    const core = new SqliteCore()
    core.open(
      open({
        filePath: main,
        foreignKeys: true,
        busyTimeoutMs: 1234,
        queryOnly: true,
        attached: [{ alias: 'aux one', filePath: aux }],
        initialStatements: ['PRAGMA cache_size = -4000']
      })
    )
    const row = core.query(
      'SELECT (SELECT foreign_keys FROM pragma_foreign_keys) AS fk, (SELECT timeout FROM pragma_busy_timeout) AS bt, (SELECT query_only FROM pragma_query_only) AS qo, (SELECT cache_size FROM pragma_cache_size) AS cs'
    ).rows[0]
    expect(row).toEqual({ fk: 1, bt: 1234, qo: 1, cs: -4000 })
    expect(() => core.runStatement('INSERT INTO t (v) VALUES (1)', 1)).toThrow(
      /readonly|query_only/i
    )
    expect(core.query('SELECT count(*) AS n FROM "aux one".t').rows[0].n).toBe(0)
    core.close()
  })

  it('reports a failing initial statement and closes', () => {
    const main = makeDb('init.db')
    const core = new SqliteCore()
    expect(() => core.open(open({ filePath: main, initialStatements: ['SELEC 1'] }))).toThrow(
      'Una consulta inicial de la conexión ha fallado'
    )
    expect(core.inTransaction).toBe(false)
  })
})

describe('SqliteCore: statements and values', () => {
  it('keeps storage classes, big integers and blobs exactly', () => {
    const core = new SqliteCore()
    core.open(open({ filePath: makeDb('v.db') }))
    const r = core.runStatement(
      "SELECT 9007199254740993 AS big, 42 AS i, 1.0 AS r, 'x' AS t, x'00ff' AS b, NULL AS n",
      10
    )
    expect(r.rows).toEqual([['9007199254740993', 42, 1, 'x', '0x00FF', null]])
    expect(r.storage).toEqual([['integer', 'integer', 'real', 'text', 'blob', 'null']])
    core.close()
  })

  it('caps rows (truncated) and stops a runaway CTE early', () => {
    const core = new SqliteCore()
    core.open(open({ filePath: makeDb('cap.db') }))
    const r = core.runStatement(
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c',
      5
    )
    expect(r.rows).toHaveLength(5)
    expect(r.truncated).toBe(true)
    core.close()
  })

  it('reports changes, last rowid, column metadata and the transaction state', () => {
    const core = new SqliteCore()
    core.open(open({ filePath: makeDb('m.db') }))
    expect(core.runStatement('BEGIN', 1).inTransaction).toBe(true)
    const ins = core.runStatement("INSERT INTO t (v) VALUES ('a'), ('b')", 1)
    expect(ins).toMatchObject({ changes: 2, lastInsertRowid: 2, rows: null })
    const sel = core.runStatement('SELECT t.id AS k, v, 1 + 1 AS e FROM t', 10)
    expect(sel.columns).toEqual([
      { name: 'k', column: 'id', table: 't', database: 'main', type: 'INTEGER' },
      { name: 'v', column: 'v', table: 't', database: 'main', type: null },
      { name: 'e', column: null, table: null, database: null, type: null }
    ])
    expect(core.runStatement('ROLLBACK', 1).inTransaction).toBe(false)
    core.close()
  })

  it('binds typed parameters ($int, $blob) and VACUUM INTO refuses existing targets', () => {
    const core = new SqliteCore()
    core.open(open({ filePath: makeDb('b.db') }))
    core.query('INSERT INTO t (v) VALUES (?), (?), (?)', [
      { $int: '9007199254740993' },
      { $blob: '0x0102' },
      'txt'
    ])
    const rows = core.query('SELECT typeof(v) AS ty, v FROM t ORDER BY id').rows
    expect(rows).toEqual([
      { ty: 'integer', v: '9007199254740993' },
      { ty: 'blob', v: '0x0102' },
      { ty: 'text', v: 'txt' }
    ])
    const target = join(dir, 'copy.db')
    expect(core.vacuumInto(target).sizeBytes).toBeGreaterThan(0)
    expect(() => core.vacuumInto(target)).toThrow('Ya existe')
    core.close()
  })

  it('serialises errors with SQLite codes; Vortaq errors are trusted', () => {
    const core = new SqliteCore()
    core.open(open({ filePath: makeDb('e.db', 'CREATE TABLE u (a UNIQUE)') }))
    core.query('INSERT INTO u VALUES (1)')
    let caught: unknown
    try {
      core.query('INSERT INTO u VALUES (1)')
    } catch (err) {
      caught = err
    }
    expect(toWorkerError(caught)).toMatchObject({ errcode: 2067, trusted: false })
    expect(toWorkerError(new SqliteCoreError('x', 'E_X'))).toMatchObject({ trusted: true })
    core.close()
  })

  it('normalises single values', () => {
    expect(normalizeValue(5n)).toEqual([5, 'integer'])
    expect(normalizeValue(2.5)).toEqual([2.5, 'real'])
    expect(normalizeValue(new Uint8Array([1, 171]))).toEqual(['0x01AB', 'blob'])
    expect(bindable(true)).toBe(1)
    expect(bindable(undefined)).toBe(null)
  })
})

describe('SqliteCore: file names with URI characters', () => {
  it('opens paths with spaces, # and ?', () => {
    const odd = join(dir, 'a b#?c.db')
    writeFileSync(odd, '')
    const core = new SqliteCore()
    core.open(open({ filePath: odd }))
    core.query('CREATE TABLE z (a)')
    core.close()
    expect(readdirSync(dir).sort()).toEqual(['a b#?c.db'])
  })
})
