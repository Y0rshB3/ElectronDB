import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { isPrintable } from '../../text'
import { Blowfish } from './blowfish'

/**
 * Password fields of Navicat connection export files (.ncx).
 *
 * Used only for .ncx files the user exports with Export Password: Navicat
 * then writes each password encrypted with a fixed scheme so the file can be
 * imported elsewhere. Nothing here reads Navicat's own storage, the keychain
 * or any other application data; the input is always a file the user chose.
 *
 * Two schemes exist: the current one (AES-128-CBC, PKCS7 padding, hex text)
 * and an older one (Blowfish blocks with a CBC-like chaining). Both use fixed
 * keys, so they only obfuscate: treat an exported .ncx with passwords as a
 * secret file.
 */

const AES_KEY = Buffer.from('libcckeylibcckey', 'latin1')
const AES_IV = Buffer.from('libcciv libcciv ', 'latin1')

const BF_KEY = createHash('sha1').update('3DC5CA39').digest()
const BF_IV = Buffer.from('d9c7c3c8870d64bd', 'hex')

const isHex = (s: string): boolean => s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s)

const utf8Strict = new TextDecoder('utf-8', { fatal: true })

function asPrintable(bytes: Uint8Array): string | null {
  try {
    const text = utf8Strict.decode(bytes)
    return isPrintable(text) ? text : null
  } catch {
    return null
  }
}

function xor(a: Uint8Array, b: Uint8Array): Buffer {
  const out = Buffer.alloc(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i]
  return out
}

/** Current scheme: hex(AES-128-CBC(key, iv, PKCS7)). Null when it does not decrypt cleanly. */
export function decryptNcxAes(hex: string): string | null {
  if (!isHex(hex)) return null
  try {
    const decipher = createDecipheriv('aes-128-cbc', AES_KEY, AES_IV)
    const plain = Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()])
    return asPrintable(plain)
  } catch {
    return null
  }
}

/** Inverse of {@link decryptNcxAes}; used to build test vectors. */
export function encryptNcxAes(plain: string): string {
  const cipher = createCipheriv('aes-128-cbc', AES_KEY, AES_IV)
  return Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()])
    .toString('hex')
    .toUpperCase()
}

/**
 * Older scheme: Blowfish-ECB blocks chained as
 *   plain[i] = decrypt(cipher[i]) XOR cv;  cv = cv XOR cipher[i]
 * and a trailing partial block XORed with encrypt(cv).
 */
export function decryptNcxBlowfish(hex: string): string | null {
  if (!isHex(hex)) return null
  try {
    const data = Buffer.from(hex, 'hex')
    const bf = new Blowfish(BF_KEY)
    const blocks = Math.floor(data.length / 8)
    const parts: Buffer[] = []
    let cv: Buffer = BF_IV
    for (let i = 0; i < blocks; i++) {
      const block = data.subarray(i * 8, i * 8 + 8)
      parts.push(xor(bf.decryptBlock(block), cv))
      cv = xor(cv, block)
    }
    const rest = data.length % 8
    if (rest > 0) parts.push(xor(data.subarray(blocks * 8), bf.encryptBlock(cv).subarray(0, rest)))
    return asPrintable(Buffer.concat(parts))
  } catch {
    return null
  }
}

/** Inverse of {@link decryptNcxBlowfish}; used to build test vectors. */
export function encryptNcxBlowfish(plain: string): string {
  const data = Buffer.from(plain, 'utf8')
  const bf = new Blowfish(BF_KEY)
  const blocks = Math.floor(data.length / 8)
  const parts: Buffer[] = []
  let cv: Buffer = BF_IV
  for (let i = 0; i < blocks; i++) {
    const encrypted = bf.encryptBlock(xor(data.subarray(i * 8, i * 8 + 8), cv))
    parts.push(encrypted)
    cv = xor(cv, encrypted)
  }
  const rest = data.length % 8
  if (rest > 0) parts.push(xor(data.subarray(blocks * 8), bf.encryptBlock(cv).subarray(0, rest)))
  return Buffer.concat(parts).toString('hex').toUpperCase()
}

/**
 * Password of one .ncx `Password` attribute: tries the current scheme, then
 * the older one. Null for an empty value or one neither scheme decrypts to
 * printable text.
 */
export function decodeNcxPassword(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  return decryptNcxAes(value) ?? decryptNcxBlowfish(value)
}
