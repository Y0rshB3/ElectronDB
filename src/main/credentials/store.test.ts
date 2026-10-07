import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialStore, DB_PASSWORD, SECRET_KINDS, plainCodec } from './store'

describe('CredentialStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-cred-'))
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

  it('deleteAll removes every secret kind of one connection and nothing else', () => {
    const store = new CredentialStore(dir, plainCodec, 'plain')
    expect([...SECRET_KINDS].sort()).toEqual(['mysql', 'ssh', 'sslKey'])
    for (const kind of SECRET_KINDS) {
      store.set(kind, 'c1', `${kind}-secret`)
      store.set(kind, 'c2', `${kind}-other`)
    }
    store.deleteAll('c1')
    for (const kind of SECRET_KINDS) {
      expect(store.has(kind, 'c1')).toBe(false)
      expect(store.get(kind, 'c2')).toBe(`${kind}-other`)
    }
    expect(Object.keys(store.rawItems()).some((k) => k.endsWith(':c1'))).toBe(false)
  })

  it('keeps the generic database password in the legacy mysql slot', () => {
    const store = new CredentialStore(dir, plainCodec, 'plain')
    store.set(DB_PASSWORD, 'c1', 'pw')
    expect(Object.keys(store.rawItems())).toEqual(['mysql:c1'])
  })
})
