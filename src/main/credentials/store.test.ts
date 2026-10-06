import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialStore, plainCodec } from './store'

describe('CredentialStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'electrondb-cred-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('round-trips secrets through the codec and never stores plaintext', () => {
    const store = new CredentialStore(dir, plainCodec, 'plain')
    store.set('mysql', 'c1', 's3cret')
    expect(store.has('mysql', 'c1')).toBe(true)
    expect(store.get('mysql', 'c1')).toBe('s3cret')
    expect(readFileSync(join(dir, 'credentials.json'), 'utf8')).not.toContain('s3cret')
    store.set('mysql', 'c1', null)
    expect(store.has('mysql', 'c1')).toBe(false)
    expect(store.get('mysql', 'c1')).toBeNull()
  })
})
