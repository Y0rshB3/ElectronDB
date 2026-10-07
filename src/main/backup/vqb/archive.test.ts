import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VqbFormatError, VqbIntegrityError, VqbPasswordError } from './errors'
import { MANIFEST_PATH } from './format'
import { VqbReader } from './reader'
import type { VqbValue } from './values'
import { VqbWriter, type VqbManifestInput } from './writer'
import { ZipReader, ZipWriter } from './zip'

const CHEAP = { N: 1024, r: 8, p: 1 }

const MANIFEST: VqbManifestInput = {
  app: { name: 'Vortaq', version: 'test' },
  engine: { id: 'mysql', flavor: 'mysql', serverVersion: '8.4.0' },
  source: { connectionName: 'Local', database: 'shop', charset: 'utf8mb4', collation: null },
  options: { includeData: true, structureOnly: false, partial: false }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vqb-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function writeSample(
  path: string,
  options: { password?: string; chunkBytes?: number; rows?: number } = {}
): Promise<void> {
  const writer = await VqbWriter.create(path, {
    manifest: MANIFEST,
    password: options.password,
    scrypt: CHEAP,
    chunkBytes: options.chunkBytes
  })
  const table = writer.beginObject('table', 'secret_customers')
  table.setColumns(
    [
      { name: 'id', type: 'bigint unsigned' },
      { name: 'name', type: 'varchar(20)' },
      { name: 'price', type: 'decimal(10,2)' },
      { name: 'blob', type: 'blob' },
      { name: 'at', type: 'datetime(3)' },
      { name: 'doc', type: 'json' }
    ],
    ['int', 'text', 'decimal', 'binary', 'datetime', 'json']
  )
  for (let i = 1; i <= (options.rows ?? 3); i++)
    await table.addRow([
      i === 3 ? '18446744073709551615' : String(i),
      i === 2 ? null : `n${i}`,
      `${i}.50`,
      Buffer.from([i, 0, 255]),
      `2026-10-07 10:00:0${i % 10}.123`,
      `{"i": ${i}}`
    ])
  await table.finish({
    ddl: 'CREATE TABLE `secret_customers` (id bigint unsigned)',
    meta: { autoIncrement: '4' }
  })
  const view = writer.beginObject('view', 'v_secret')
  await view.finish({ ddl: 'CREATE VIEW `v_secret` AS SELECT 1' })
  await writer.finish()
}

async function allRows(reader: VqbReader): Promise<VqbValue[][]> {
  const manifest = await reader.manifest()
  const meta = await reader.objectMeta(manifest.objects[0].id)
  const out: VqbValue[][] = []
  await reader.rows(meta, (row) => {
    out.push(row)
  })
  return out
}

describe('.vqb archive', () => {
  it('round trips objects, typed rows and metadata', async () => {
    const path = join(dir, 'a.vqb')
    await writeSample(path)
    expect(existsSync(`${path}.partial`)).toBe(false)
    const reader = await VqbReader.open(path)
    try {
      const manifest = await reader.manifest()
      expect(manifest.formatVersion).toBe(1)
      expect(manifest.encryption).toBeNull()
      expect(manifest.objects.map((o) => [o.id, o.type, o.name, o.rows])).toEqual([
        ['000001', 'table', 'secret_customers', 3],
        ['000002', 'view', 'v_secret', null]
      ])
      const meta = await reader.objectMeta('000001')
      expect(meta.autoIncrement).toBe('4')
      expect(meta.columns?.map((c) => c.name)).toEqual(['id', 'name', 'price', 'blob', 'at', 'doc'])
      expect(await reader.ddl(meta)).toContain('CREATE TABLE')
      const rows = await allRows(reader)
      expect(rows[0]).toEqual([
        1,
        'n1',
        { $dec: '1.50' },
        { $bin: Buffer.from([1, 0, 255]).toString('base64') },
        { $dt: '2026-10-07 10:00:01.123' },
        { $json: '{"i": 1}' }
      ])
      expect(rows[1][1]).toBeNull()
      expect(rows[2][0]).toEqual({ $bigint: '18446744073709551615' })
      expect(await reader.verify()).toEqual({ objects: 2, rows: 3, files: 6 })
    } finally {
      await reader.close()
    }
  })

  it('splits data into several files by uncompressed size', async () => {
    const path = join(dir, 'chunks.vqb')
    await writeSample(path, { chunkBytes: 200, rows: 25 })
    const reader = await VqbReader.open(path)
    try {
      const meta = await reader.objectMeta('000001')
      expect(meta.data!.length).toBeGreaterThan(3)
      expect(meta.data!.reduce((s, d) => s + d.rows, 0)).toBe(25)
      expect(meta.data![0].path).toBe('objects/000001/data-000001.jsonl.gz')
      expect((await allRows(reader)).map((r) => r[0])).toEqual(
        Array.from({ length: 25 }, (_, i) =>
          i === 2 ? { $bigint: '18446744073709551615' } : i + 1
        )
      )
    } finally {
      await reader.close()
    }
  })

  it('is a plain ZIP: every entry readable, manifest last, header first', async () => {
    const path = join(dir, 'zip.vqb')
    await writeSample(path)
    const zip = await ZipReader.open(path)
    try {
      expect(zip.entries[0].name).toBe('header.json')
      expect(zip.entries.at(-1)!.name).toBe(MANIFEST_PATH)
      expect(zip.entries.map((e) => e.name)).toContain('objects/000001/data-000001.jsonl.gz')
      const header = JSON.parse((await zip.read('header.json')).toString())
      expect(header).toEqual({ format: 'vortaq-backup', formatVersion: 1, encrypted: false })
    } finally {
      await zip.close()
    }
  })

  describe('encrypted', () => {
    it('round trips with the password and hides the manifest', async () => {
      const path = join(dir, 'enc.vqb')
      await writeSample(path, { password: 'correct horse', rows: 5 })
      const raw = readFileSync(path)
      // Names and values never appear in clear: only header.json is plaintext.
      expect(raw.includes(Buffer.from('secret_customers'))).toBe(false)
      expect(raw.includes(Buffer.from('Local'))).toBe(false)
      expect(raw.includes(Buffer.from('shop'))).toBe(false)
      const zip = await ZipReader.open(path)
      const header = JSON.parse((await zip.read('header.json')).toString())
      await zip.close()
      expect(header.encrypted).toBe(true)
      expect(header.encryption.alg).toBe('AES-256-GCM')
      expect(header.encryption.kdf).toMatchObject({ name: 'scrypt', N: 1024, r: 8, p: 1 })

      const locked = await VqbReader.open(path)
      try {
        expect(locked.encrypted).toBe(true)
        await expect(locked.manifest()).rejects.toBeInstanceOf(VqbPasswordError)
        await expect(locked.unlock('wrong')).rejects.toThrow('Contraseña incorrecta')
        await locked.unlock('correct horse')
        expect((await locked.manifest()).objects[0].name).toBe('secret_customers')
        expect((await allRows(locked)).length).toBe(5)
        expect((await locked.verify()).rows).toBe(5)
      } finally {
        await locked.close()
      }
    })

    it('reports a wrong password before reading anything else', async () => {
      const path = join(dir, 'wrong.vqb')
      await writeSample(path, { password: 'one' })
      await expect(VqbReader.open(path, 'two')).rejects.toMatchObject({
        code: 'VQB_WRONG_PASSWORD'
      })
    })

    it('normalises the password to NFC', async () => {
      const path = join(dir, 'nfc.vqb')
      await writeSample(path, { password: 'contraseña' })
      const reader = await VqbReader.open(path, 'contraseña')
      await reader.close()
    })

    it('detects a tampered chunk as an integrity error', async () => {
      const path = join(dir, 'tamper.vqb')
      await writeSample(path, { password: 'pw', rows: 50 })
      const zip = await ZipReader.open(path)
      const target = zip.entry('objects/000001/data-000001.jsonl.gz')!
      await zip.close()
      const raw = readFileSync(path)
      // Flip one ciphertext byte after the local header, name and VQE1 header.
      const nameLength = raw.readUInt16LE(target.headerOffset + 26)
      const at = target.headerOffset + 30 + nameLength + 20
      raw[at] ^= 0x01
      // Keep the ZIP CRC consistent so only the cryptographic check can notice.
      const { crc32 } = await import('node:zlib')
      const body = raw.subarray(
        target.headerOffset + 30 + nameLength,
        target.headerOffset + 30 + nameLength + target.size
      )
      const crc = crc32(body) >>> 0
      raw.writeUInt32LE(crc, target.headerOffset + 14)
      const cdAt = raw.lastIndexOf(Buffer.from('objects/000001/data-000001.jsonl.gz')) - 46
      raw.writeUInt32LE(crc, cdAt + 16)
      writeFileSync(path, raw)
      const reader = await VqbReader.open(path, 'pw')
      try {
        await expect(reader.verify()).rejects.toBeInstanceOf(VqbIntegrityError)
      } finally {
        await reader.close()
      }
    })
  })

  it('refuses a truncated file', async () => {
    const path = join(dir, 'trunc.vqb')
    await writeSample(path)
    const raw = readFileSync(path)
    writeFileSync(path, raw.subarray(0, raw.length - 40))
    await expect(VqbReader.open(path)).rejects.toBeInstanceOf(VqbFormatError)
  })

  it('refuses a file whose data no longer matches its checksum', async () => {
    const path = join(dir, 'sha.vqb')
    await writeSample(path)
    const zip = await ZipReader.open(path)
    const target = zip.entry('objects/000001/ddl.sql')!
    await zip.close()
    const raw = readFileSync(path)
    const nameLength = raw.readUInt16LE(target.headerOffset + 26)
    const at = target.headerOffset + 30 + nameLength
    raw[at] = raw[at] === 0x43 ? 0x44 : 0x43
    const { crc32 } = await import('node:zlib')
    const crc = crc32(raw.subarray(at, at + target.size)) >>> 0
    raw.writeUInt32LE(crc, target.headerOffset + 14)
    const cdAt = raw.lastIndexOf(Buffer.from('objects/000001/ddl.sql')) - 46
    raw.writeUInt32LE(crc, cdAt + 16)
    writeFileSync(path, raw)
    const reader = await VqbReader.open(path)
    try {
      await expect(reader.verify()).rejects.toBeInstanceOf(VqbIntegrityError)
    } finally {
      await reader.close()
    }
  })

  it('reads ZIP64 end records and offsets', async () => {
    const path = join(dir, 'z64.zip')
    const zip = await ZipWriter.create(path, new Date(), { forceZip64: true })
    await zip.add('a.txt', Buffer.from('alpha'))
    await zip.add('b/c.txt', Buffer.from('beta'))
    await zip.finish()
    const reader = await ZipReader.open(path)
    try {
      expect(reader.entries.map((e) => e.name)).toEqual(['a.txt', 'b/c.txt'])
      expect((await reader.read('b/c.txt')).toString()).toBe('beta')
    } finally {
      await reader.close()
    }
  })

  it('refuses files that are not .vqb and newer format versions', async () => {
    const notZip = join(dir, 'x.vqb')
    writeFileSync(notZip, 'hello world, not a zip at all')
    await expect(VqbReader.open(notZip)).rejects.toBeInstanceOf(VqbFormatError)

    const newer = join(dir, 'newer.vqb')
    const zip = await ZipWriter.create(newer)
    await zip.add(
      'header.json',
      Buffer.from('{"format":"vortaq-backup","formatVersion":2,"encrypted":false}')
    )
    await zip.finish()
    await expect(VqbReader.open(newer)).rejects.toThrow('versión 2')
  })

  it('aborts without leaving files behind', async () => {
    const path = join(dir, 'abort.vqb')
    const writer = await VqbWriter.create(path, { manifest: MANIFEST })
    writer.beginObject('view', 'v')
    await writer.abort()
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.partial`)).toBe(false)
  })
})
