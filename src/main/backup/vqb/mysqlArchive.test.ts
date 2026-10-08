import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VqbMysqlArchive } from './mysqlArchive'
import { VqbWriter } from './writer'

const END = '2106-02-07 06:28:15.999999'

describe('MariaDB objects in a MySQL .vqb', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vqb-maria-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function write(): Promise<string> {
    const target = join(dir, 'x.vqb')
    const writer = await VqbWriter.create(target, {
      manifest: {
        app: { name: 'Vortaq', version: 'test' },
        engine: { id: 'mysql', flavor: 'mariadb', serverVersion: '11.8.9-MariaDB' },
        source: { database: 'db', timeZone: '+00:00' },
        options: { includeData: true, structureOnly: false, partial: false }
      }
    })
    await writer.beginObject('sequence', 's').finish({
      ddl: 'CREATE SEQUENCE `s` start with 1',
      meta: { sequences: [{ schema: '', name: 's', lastValue: '510', isCalled: false }] }
    })
    const table = writer.beginObject('table', 'h')
    table.setColumns(
      [
        { name: 'id', type: 'int(11)' },
        { name: 'row_start', type: 'timestamp(6)' },
        { name: 'row_end', type: 'timestamp(6)' }
      ],
      ['int', 'datetime', 'datetime']
    )
    await table.addRow([1, '2026-01-01 00:00:00.000000', '2026-01-02 00:00:00.000000'])
    await table.addRow([1, '2026-01-02 00:00:00.000000', END])
    await table.addRow([2, '2026-01-01 00:00:00.000000', '2026-01-03 00:00:00.000000'])
    await table.finish({
      ddl: 'CREATE TABLE `h` (`id` int) WITH SYSTEM VERSIONING',
      meta: { systemVersioning: { start: 'row_start', end: 'row_end', currentEnd: END } }
    })
    await writer.finish()
    return target
  }

  it('gives every row version, or only the current rows without the period columns', async () => {
    const archive = await VqbMysqlArchive.open(await write())
    try {
      const manifest = await archive.manifest()
      const seq = await archive.objectMeta(manifest.Objects[0].UUID)
      expect(archive.sequenceState(seq)).toMatchObject({ lastValue: '510', isCalled: false })
      const meta = await archive.objectMeta(manifest.Objects[1].UUID)
      expect(archive.versioning(meta)).toEqual({
        start: 'row_start',
        end: 'row_end',
        currentEnd: END
      })
      expect(archive.sequenceState(meta)).toBeNull()
      const all: string[] = []
      expect(await archive.rows(meta, (t) => void all.push(t))).toBe(3)
      expect(all[1]).toBe(`(1, '2026-01-02 00:00:00.000000', '${END}')`)
      const current: string[] = []
      expect(
        await archive.rows(meta, (t) => void current.push(t), undefined, { currentOnly: true })
      ).toBe(1)
      expect(current).toEqual(['(1)'])
    } finally {
      await archive.close()
    }
  })
})
