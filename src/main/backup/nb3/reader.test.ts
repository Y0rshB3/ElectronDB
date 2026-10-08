import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Nb3Reader, iterateObjectRows, readManifest, readObjectMeta } from './reader'
import { encodeTarHeader, indexTar, tarBodyPadding, tarTrailer } from './tar'

const FIXTURE = resolve('tests/fixtures/navicat/backups/demo/20260317144801-fixture.nb3')
const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const EMPTY = '22222222-2222-4222-8222-222222222222'
const VIEW = '33333333-3333-4333-8333-333333333333'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'vortaq-reader-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function tamper(entrySuffix: string): Promise<string> {
  const copy = join(dir, `tampered-${entrySuffix.replace(/\W/g, '')}.nb3`)
  copyFileSync(FIXTURE, copy)
  const entry = (await indexTar(copy)).find((e) => e.name.endsWith(entrySuffix))!
  const bytes = readFileSync(copy)
  bytes[entry.offset + Math.floor(entry.size / 2)] ^= 0xff
  writeFileSync(copy, bytes)
  return copy
}

function buildTar(entries: [string, Buffer][]): Buffer {
  const parts: Buffer[] = []
  let size = 0
  for (const [name, body] of entries) {
    for (const p of [encodeTarHeader(name, body.length), body, tarBodyPadding(body.length)]) {
      parts.push(p)
      size += p.length
    }
  }
  parts.push(tarTrailer(size))
  return Buffer.concat(parts)
}

describe('nb3 reader on the Navicat fixture', () => {
  it('reads the manifest (last entry) with 3 objects', async () => {
    const entries = await indexTar(FIXTURE)
    expect(entries[entries.length - 1].name).toBe('meta.json')
    const meta = await readManifest(FIXTURE)
    expect(meta.schema).toBe('demo')
    expect(meta.encryption).toBe('None')
    expect(meta.comment).toBe('fixture')
    expect(meta.startTime).toBe(new Date(1773776881 * 1000).toISOString())
    expect(meta.objects.map((o) => [o.name, o.type, o.rows])).toEqual([
      ['account', 'Table', 3],
      ['empty_table', 'Table', 0],
      ['v_active', 'View', null]
    ])
  })

  it('streams exactly 3 account tuples with escapes intact', async () => {
    const meta = await readObjectMeta(FIXTURE, ACCOUNT)
    expect(meta.Fields).toEqual(['id', 'name', 'note', 'payload', 'score', 'created', 'active'])
    const rows: string[] = []
    const count = await iterateObjectRows(FIXTURE, meta, (r) => {
      rows.push(r)
    })
    expect(count).toBe(3)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toBe(
      "(1, 'Ana', 'O\\'Reilly', '{\\\"k\\\":\\\"v\\\"}', NULL, '2026-01-02 03:04:05', 1)"
    )
    expect(rows[1]).toContain("'Line1\\nLine2'")
    expect(rows[2]).toContain("'Cé'")
    expect(rows[2]).toContain("'back\\\\slash'")
  })

  it('empty_table yields 0 rows and v_active is a View with DDL', async () => {
    const reader = await Nb3Reader.open(FIXTURE)
    const empty = await reader.objectMeta(EMPTY)
    expect(empty.Data).toEqual([])
    expect(await reader.rows(empty, () => {})).toBe(0)
    const view = await reader.objectMeta(VIEW)
    expect(view.Type).toBe('View')
    expect(view.DDL).toMatch(/^CREATE .*VIEW `v_active`/)
  })

  it('fails with a Spanish checksum error on a tampered data chunk', async () => {
    const copy = await tamper('.data.00000.sql.gz')
    const meta = await readObjectMeta(copy, ACCOUNT)
    await expect(iterateObjectRows(copy, meta, () => {})).rejects.toThrow(/suma de verificación/)
  })

  it('fails with a Spanish checksum error on tampered object metadata', async () => {
    const copy = await tamper(`${ACCOUNT}.meta.json.gz`)
    await expect(readObjectMeta(copy, ACCOUNT)).rejects.toThrow(/suma de verificación/)
  })

  it('refuses encrypted backups', async () => {
    const manifest = {
      MetaVersion: '30101',
      Schema: 'x',
      Encryption: 'AES256',
      Objects: [
        {
          UUID: 'U1',
          Type: 'Table',
          Name: 't',
          Rows: '1',
          Metadata: { Filename: 'U1.meta.json.gz', Checksum: '' }
        }
      ]
    }
    const path = join(dir, 'encrypted.nb3')
    writeFileSync(
      path,
      buildTar([
        ['U1.meta.json.gz', Buffer.from('x')],
        ['meta.json', Buffer.from(JSON.stringify(manifest))]
      ])
    )
    expect((await readManifest(path)).encryption).toBe('AES256')
    await expect(readObjectMeta(path, 'U1')).rejects.toThrow('Copias cifradas no soportadas')
  })

  it('reports missing files and non-nb3 archives in Spanish', async () => {
    await expect(readManifest(join(dir, 'nope.nb3'))).rejects.toThrow(/No se encontró/)
    const path = join(dir, 'nometa.nb3')
    writeFileSync(path, buildTar([['other.txt', Buffer.from('hola')]]))
    await expect(readManifest(path)).rejects.toThrow(/falta meta.json/)
  })

  it('a visitor error propagates unchanged (not reported as corruption)', async () => {
    const meta = await readObjectMeta(FIXTURE, ACCOUNT)
    await expect(
      iterateObjectRows(FIXTURE, meta, () => {
        throw new Error('fallo del destino')
      })
    ).rejects.toThrow('fallo del destino')
  })

  it('stops when the signal is aborted', async () => {
    const meta = await readObjectMeta(FIXTURE, ACCOUNT)
    const controller = new AbortController()
    let seen = 0
    await expect(
      iterateObjectRows(
        FIXTURE,
        meta,
        () => {
          seen++
          controller.abort()
        },
        controller.signal
      )
    ).rejects.toThrow(/cancelada/)
    expect(seen).toBe(1)
  })
})
