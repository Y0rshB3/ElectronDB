import { createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { isPrintable } from '../text'

/**
 * Chromium os_crypt on macOS, which is what Electron's safeStorage uses there:
 * the password stored in the login keychain item "<app name> Safe Storage" is
 * stretched with PBKDF2-HMAC-SHA1 ('saltysalt', 1003 iterations, 16 bytes) into
 * an AES-128-CBC key; the IV is 16 spaces and ciphertexts start with 'v10'.
 * Verified against Electron 44 (`--use-mock-keychain`, password "mock_password").
 */
export const MAC_OS_CRYPT = {
  prefix: 'v10',
  salt: 'saltysalt',
  iterations: 1003,
  keyLength: 16,
  iv: Buffer.alloc(16, 0x20)
} as const

/** AES key derived from the keychain password. */
export function deriveMacOsCryptKey(password: string): Buffer {
  return pbkdf2Sync(
    password,
    MAC_OS_CRYPT.salt,
    MAC_OS_CRYPT.iterations,
    MAC_OS_CRYPT.keyLength,
    'sha1'
  )
}

/** True when the bytes carry the macOS os_crypt 'v10' prefix. */
export function hasMacOsCryptPrefix(data: Uint8Array): boolean {
  return Buffer.from(data.subarray(0, 3)).toString('latin1') === MAC_OS_CRYPT.prefix
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true })

/**
 * Decrypts one 'v10' value. Returns null when the prefix, the padding or the
 * text does not check out (wrong key, other format); never throws.
 */
export function decryptMacOsCrypt(data: Uint8Array, key: Buffer): string | null {
  if (!hasMacOsCryptPrefix(data)) return null
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, MAC_OS_CRYPT.iv)
    const plain = Buffer.concat([
      decipher.update(Buffer.from(data.subarray(MAC_OS_CRYPT.prefix.length))),
      decipher.final()
    ])
    const text = utf8Strict.decode(plain)
    return isPrintable(text) ? text : null
  } catch {
    return null
  }
}

/** Inverse of {@link decryptMacOsCrypt} (what safeStorage.encryptString produces on macOS). */
export function encryptMacOsCrypt(plain: string, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-cbc', key, MAC_OS_CRYPT.iv)
  return Buffer.concat([
    Buffer.from(MAC_OS_CRYPT.prefix, 'latin1'),
    cipher.update(Buffer.from(plain, 'utf8')),
    cipher.final()
  ])
}
