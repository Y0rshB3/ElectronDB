import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DATA_CHUNK_LIMIT } from './format'
import { Nb3Reader } from './reader'
import { indexTar, readTarEntry } from './tar'
import { Nb3Writer } from './writer'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'electrondb-writer-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('Nb3Writer', () => {
  it('writes a ustar archive readable by tar with meta.json last and fixed attributes', async () => {
    const target = join(dir, 'a', '20260101000000.nb3')
    const w = await Nb3Writer.create(target, {
      schema: 'demo',
      comment: 'c',
      startTime: 1700000000
    })
    const t = w.beginObject('Table', 'items', 'AAAA')
    await t.addRow("(1, 'a')")
    await t.addRow("(2, 'b\\nc')")
    await t.finish({
      ddl: 'CREATE TABLE `items` (`id` int, `v` text)',
      fields: ['id', 'v'],
      autoIncrement: '3'
    })
    await w.beginObject('View', 'v', 'BBBB').finish({ ddl: 'CREATE VIEW `v` AS SELECT 1' })
    const result = await w.finish()

    expect(result).toMatchObject({ path: target, objects: 2, rows: 2 })
    expect(existsSync(`${target}.partial`)).toBe(false)
    expect(statSync(target).mode & 0o777).toBe(0o600)
    expect(statSync(target).size % 10240).toBe(0)

    const listing = execFileSync('tar', ['-tvf', target], { encoding: 'utf8' }).trim().split('\n')
    expect(listing.map((l) => l.split(/\s+/).pop())).toEqual([
      'AAAA.data.00000.sql.gz',
      'AAAA.meta.json.gz',
      'BBBB.meta.json.gz',
      'meta.json'
    ])
    // bsdtar (macOS): "-rw-r--r--  0 0      0      41 Jan  1  1970 name"
    // GNU tar (Linux): "-rw-r--r-- 0/0      41 1970-01-01 00:00 name"
    for (const line of listing) {
      expect(line).toMatch(/^-rw-r--r--\s+(0\s+0\s+0|0\/0)\s/)
    }

    const entries = await indexTar(target)
    const manifest = JSON.parse((await readTarEntry(target, entries[3])).toString('utf8'))
    expect(manifest).toMatchObject({
      MetaVersion: '30101',
      DatabaseType: 'MYSQL',
      Encryption: 'None',
      Schema: 'demo',
      Comment: 'c',
      StartTime: '1700000000'
    })
    expect(typeof manifest.EndTime).toBe('string')
    expect(manifest.Objects[0]).toMatchObject({
      UUID: 'AAAA',
      Type: 'Table',
      Name: 'items',
      Rows: '2'
    })
    expect(manifest.Objects[1]).toMatchObject({ Type: 'View', Rows: '' })
    // gzip header: magic, deflate, no flags, MTIME = 0
    const gz = await readTarEntry(target, entries[0])
    expect([...gz.subarray(0, 8)]).toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0])
    expect(gunzipSync(gz).toString('utf8')).toBe("(1, 'a')\x1e\n(2, 'b\\nc')")

    const reader = await Nb3Reader.open(target)
    const meta = await reader.objectMeta('AAAA')
    expect(meta).toMatchObject({
      AutoIncrement: '3',
      Fields: ['id', 'v'],
      IndexDDL: [],
      SubDDL: [],
      TriggerDDL: []
    })
    const rows: string[] = []
    await reader.rows(meta, (r) => {
      rows.push(r)
    })
    expect(rows).toEqual(["(1, 'a')", "(2, 'b\\nc')"])
  })

  it('cuts data chunks above 5 MB uncompressed on row boundaries', async () => {
    const target = join(dir, 'big.nb3')
    const w = await Nb3Writer.create(target, { schema: 'demo' })
    const t = w.beginObject('Table', 'big', 'CCCC')
    const payload = 'x'.repeat(100 * 1024)
    const total = 120 // ~12 MB
    for (let i = 0; i < total; i++) await t.addRow(`(${i}, '${payload}')`)
    const { chunks } = await t.finish({
      ddl: 'CREATE TABLE big (id int, v longtext)',
      fields: ['id', 'v']
    })
    await w.finish()
    expect(chunks).toBe(3)

    const entries = await indexTar(target)
    const dataEntries = entries.filter((e) => e.name.includes('.data.'))
    expect(dataEntries.map((e) => e.name)).toEqual([
      'CCCC.data.00000.sql.gz',
      'CCCC.data.00001.sql.gz',
      'CCCC.data.00002.sql.gz'
    ])
    for (const e of dataEntries) {
      const plain = gunzipSync(await readTarEntry(target, e))
      expect(plain.length).toBeLessThanOrEqual(DATA_CHUNK_LIMIT)
      expect(plain.subarray(0, 1).toString()).toBe('(')
      expect(plain.subarray(-1).toString()).toBe(')')
    }
    const reader = await Nb3Reader.open(target)
    const ids: number[] = []
    await reader.rows(await reader.objectMeta('CCCC'), (r) => {
      ids.push(Number(/^\((\d+),/.exec(r)![1]))
    })
    expect(ids).toEqual([...Array(total).keys()])
  })

  it('abort removes the partial file and leaves nothing behind', async () => {
    const sub = join(dir, 'aborted')
    const target = join(sub, 'x.nb3')
    const w = await Nb3Writer.create(target, { schema: 'demo' })
    const t = w.beginObject('Table', 't')
    await t.addRow('(1)')
    expect(existsSync(`${target}.partial`)).toBe(true)
    await w.abort()
    expect(readdirSync(sub)).toEqual([])
  })
})
