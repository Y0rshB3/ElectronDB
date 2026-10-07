import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateHeader, validateManifest, validateObjectMeta } from './format'
import { checkValue } from './values'

/**
 * The examples of docs/vqb-format.md (the public specification) must parse
 * with the reader's own validation: fenced blocks tagged `json vqb-header`,
 * `json vqb-manifest`, `json vqb-meta` and `jsonl vqb-rows`.
 */

const SPEC = readFileSync(resolve('docs/vqb-format.md'), 'utf8')

function blocks(tag: string): string[] {
  const out: string[] = []
  const re = new RegExp('```(?:json|jsonl) ' + tag + '\\n([\\s\\S]*?)```', 'g')
  for (let m = re.exec(SPEC); m; m = re.exec(SPEC)) out.push(m[1])
  return out
}

describe('docs/vqb-format.md examples', () => {
  it('has examples of every kind', () => {
    expect(blocks('vqb-header')).toHaveLength(2)
    expect(blocks('vqb-manifest')).toHaveLength(1)
    expect(blocks('vqb-meta')).toHaveLength(1)
    expect(blocks('vqb-rows').length).toBeGreaterThanOrEqual(2)
  })

  it('headers validate (plain and encrypted)', () => {
    const [plain, encrypted] = blocks('vqb-header').map((b) => validateHeader(JSON.parse(b)))
    expect(plain.encrypted).toBe(false)
    expect(encrypted.encryption).toMatchObject({ alg: 'AES-256-GCM', chunkSize: 65536 })
    expect(encrypted.encryption!.kdf).toMatchObject({ name: 'scrypt', N: 131072, r: 8, p: 1 })
  })

  it('the manifest and the object meta validate and agree', () => {
    const manifest = validateManifest(JSON.parse(blocks('vqb-manifest')[0]))
    const meta = validateObjectMeta(JSON.parse(blocks('vqb-meta')[0]), manifest.objects[0])
    expect(meta.rows).toBe(manifest.objects[0].rows)
    expect(manifest.objects[0].files.map((f) => f.path)).toEqual(
      expect.arrayContaining([meta.ddl, ...meta.data!.map((d) => d.path)])
    )
    const [first] = blocks('vqb-rows')
    const rows = first
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as unknown[])
    expect(rows).toHaveLength(meta.rows!)
    for (const row of rows) {
      expect(row).toHaveLength(meta.columns!.length)
      row.forEach((v) => checkValue(v))
    }
  })

  it('every example value is a valid tagged value', () => {
    for (const block of blocks('vqb-rows'))
      for (const line of block.trim().split('\n'))
        for (const v of JSON.parse(line) as unknown[]) expect(() => checkValue(v)).not.toThrow()
  })
})
