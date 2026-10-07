import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { classifyStatement, statementHead } from './classify'
import { inspectSqlDump, NO_DATABASE_WARNING } from './inspect'

const FIXTURES = join(__dirname, '../../../../tests/fixtures/importers/sql')
const fixture = (name: string): string => join(FIXTURES, name)

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'vortaq-sqlinspect-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('inspectSqlDump', () => {
  it('reads a mysqldump file', async () => {
    const r = await inspectSqlDump(fixture('mysqldump-8.sql'))
    expect(r).toMatchObject({
      fileName: 'mysqldump-8.sql',
      gzip: false,
      tool: 'mysqldump',
      databases: [],
      hasCreateDatabase: false,
      hasUse: false,
      usesDelimiter: true,
      hasDefiners: true,
      counts: { tables: 2, views: 1, routines: 2, triggers: 1, events: 1, inserts: 2, databases: 0 }
    })
    expect(r.warnings).toEqual([NO_DATABASE_WARNING])
  })

  it('finds the databases of a --databases dump (5.7 placeholder table not counted)', async () => {
    const r = await inspectSqlDump(fixture('mysqldump-databases.sql'))
    expect(r.databases).toEqual(['tienda_demo'])
    expect(r.hasCreateDatabase).toBe(true)
    expect(r.hasUse).toBe(true)
    expect(r.counts).toMatchObject({ tables: 1, views: 1 })
    expect(r.warnings).toEqual([])
  })

  it('warns about several databases', async () => {
    const r = await inspectSqlDump(fixture('two-databases.sql'))
    expect(r.databases).toEqual(['ventas', 'crm'])
    expect(r.warnings[0]).toMatch(/2 bases de datos \(ventas, crm\)/)
  })

  it.each([
    ['phpmyadmin.sql', 'phpMyAdmin', { tables: 2, routines: 1, inserts: 2 }],
    ['heidisql.sql', 'HeidiSQL', { tables: 1, routines: 1, triggers: 1, databases: 1 }],
    ['adminer.sql', 'Adminer', { tables: 1, triggers: 1 }],
    ['dbeaver-style.sql', 'DBeaver', { tables: 1, inserts: 1 }],
    ['workbench-style.sql', 'MySQL Workbench', { tables: 1, databases: 1 }],
    ['tableplus-style.sql', 'TablePlus', { tables: 1 }]
  ])('recognises %s', async (name, tool, counts) => {
    const r = await inspectSqlDump(fixture(name))
    expect(r.tool).toBe(tool)
    expect(r.counts).toMatchObject(counts)
  })

  it('reads gzip files, warns about empty and non-UTF-8 files', async () => {
    const gz = join(dir, 'x.sql.gz')
    writeFileSync(gz, gzipSync(readFileSync(fixture('heidisql.sql'))))
    const r = await inspectSqlDump(gz)
    expect(r).toMatchObject({ gzip: true, tool: 'HeidiSQL', databases: ['inventario'] })

    const empty = join(dir, 'empty.sql')
    writeFileSync(empty, '')
    expect((await inspectSqlDump(empty)).warnings).toEqual(['El archivo está vacío.'])

    const latin1 = join(dir, 'latin1.sql')
    writeFileSync(latin1, Buffer.from("USE `x`;\nINSERT INTO t VALUES ('ca\xf1a');\n", 'latin1'))
    expect((await inspectSqlDump(latin1)).warnings.join(' ')).toMatch(/UTF-8/)
  })

  it('only looks at the start of a very long line', async () => {
    const path = join(dir, 'long.sql')
    const tuples = Array.from({ length: 20_000 }, (_, i) => `(${i},'\nUSE fake;')`).join(',')
    writeFileSync(
      path,
      `CREATE TABLE t (id int);\nINSERT INTO t VALUES ${tuples};\nUSE \`real\`;\n`
    )
    const r = await inspectSqlDump(path)
    expect(r.counts.inserts).toBe(1)
    expect(r.databases).toContain('real')
  })

  it('gives actionable errors for missing paths and folders', async () => {
    await expect(inspectSqlDump(join(dir, 'nope.sql'))).rejects.toThrow(/No se encontró/)
    await expect(inspectSqlDump(dir)).rejects.toThrow(/no es un archivo/)
  })
})

describe('classifyStatement', () => {
  it.each([
    ['/*!50003 CREATE*/ /*!50017 DEFINER=`a`@`%`*/ /*!50003 TRIGGER `t` BEFORE', 'Trigger', 't'],
    [
      '/*!50001 CREATE ALGORITHM=UNDEFINED */\n/*!50013 DEFINER=`a`@`%` SQL SECURITY DEFINER */\n/*!50001 VIEW `v` AS select 1 */',
      'View',
      'v'
    ],
    ["CREATE DEFINER='a'@'localhost' PROCEDURE `p`()", 'Procedure', 'p'],
    ['CREATE FUNCTION f() RETURNS INT', 'Function', 'f'],
    ['/*!50106 CREATE*/ /*!50117 DEFINER=`a`@`%`*/ /*!50106 EVENT `e` ON SCHEDULE', 'Event', 'e'],
    ['CREATE TABLE IF NOT EXISTS `escuela`.`alumnos` (', 'Table', 'alumnos'],
    ['CREATE DATABASE /*!32312 IF NOT EXISTS*/ `d` /*!40100 DEFAULT', 'Database', 'd'],
    ['CREATE SCHEMA IF NOT EXISTS `s` DEFAULT CHARACTER SET utf8mb4', 'Database', 's'],
    ['-- comment\n--\nCREATE OR REPLACE VIEW w AS SELECT 1', 'View', 'w']
  ])('%s', (sql, object, name) => {
    expect(classifyStatement(sql)).toEqual({ kind: 'create', object, name })
  })

  it('recognises USE, ALTER DATABASE and writes', () => {
    expect(classifyStatement('USE `a``b`')).toEqual({ kind: 'use', name: 'a`b' })
    expect(classifyStatement('/*!40000 USE db */')).toEqual({ kind: 'use', name: 'db' })
    expect(classifyStatement('ALTER DATABASE `db` CHARACTER SET utf8mb4')).toEqual({
      kind: 'alterDatabase',
      name: 'db'
    })
    expect(classifyStatement('-- x\nINSERT INTO t VALUES (1)')).toEqual({ kind: 'write' })
    expect(classifyStatement('SELECT 1')).toEqual({ kind: 'other' })
    expect(statementHead('/* a */ /*!40101 SET x */')).toBe('SET x')
  })
})
