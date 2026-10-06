import { createCipheriv, pbkdf2Sync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  decryptMacOsCrypt,
  deriveMacOsCryptKey,
  encryptMacOsCrypt,
  hasMacOsCryptPrefix
} from './osCrypt'

/** Independent re-implementation of Chromium's macOS os_crypt, to build vectors. */
function chromiumEncrypt(plain: string, keychainPassword: string): Buffer {
  const key = pbkdf2Sync(keychainPassword, 'saltysalt', 1003, 16, 'sha1')
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.from('                ', 'latin1'))
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain, 'utf8'), cipher.final()])
}

describe('macOS os_crypt', () => {
  const password = 'Zm9vYmFyYmF6cXV4MTIzNA=='

  it('derives the PBKDF2-HMAC-SHA1 key (saltysalt, 1003 iterations, 16 bytes)', () => {
    const key = deriveMacOsCryptKey(password)
    expect(key).toHaveLength(16)
    expect(key.equals(pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1'))).toBe(true)
  })

  it('decrypts values produced by the Chromium scheme', () => {
    const key = deriveMacOsCryptKey(password)
    for (const plain of ['s3cret', 'contraseña con ñ y espacios', 'x'.repeat(64), 'a\tb'])
      expect(decryptMacOsCrypt(chromiumEncrypt(plain, password), key)).toBe(plain)
  })

  it('round-trips with its own encrypt', () => {
    const key = deriveMacOsCryptKey(password)
    const data = encryptMacOsCrypt('hunter2', key)
    expect(hasMacOsCryptPrefix(data)).toBe(true)
    expect(data.equals(chromiumEncrypt('hunter2', password))).toBe(true)
    expect(decryptMacOsCrypt(data, key)).toBe('hunter2')
  })

  it('returns null for a wrong key, a missing prefix or garbage', () => {
    const data = chromiumEncrypt('s3cret', password)
    expect(decryptMacOsCrypt(data, deriveMacOsCryptKey('another password'))).toBeNull()
    expect(decryptMacOsCrypt(data.subarray(3), deriveMacOsCryptKey(password))).toBeNull()
    expect(decryptMacOsCrypt(Buffer.from('v10short'), deriveMacOsCryptKey(password))).toBeNull()
    expect(hasMacOsCryptPrefix(Buffer.from('v11abc'))).toBe(false)
  })
})
