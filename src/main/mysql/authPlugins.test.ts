import { pbkdf2Sync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import {
  PARSEC_MAX_ITERATION_FACTOR,
  ed25519Response,
  mariaDbAuthPlugins,
  parseParsecSalt,
  parsecResponse
} from './authPlugins'

const bytes = (n: number, seed = 1): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff)

describe('client_ed25519', () => {
  it('equals RFC 8032 signing when the password is a 32-byte seed', () => {
    // MariaDB hashes the password where RFC 8032 hashes the seed: same bytes, same signature.
    const password = 'abcdefghijklmnopqrstuvwxyz012345'
    const scramble = bytes(32)
    const expected = ed25519.sign(scramble, new TextEncoder().encode(password))
    expect(ed25519Response(password, scramble)).toEqual(expected)
  })

  it('signs with any password length and verifies with the derived public key', () => {
    const scramble = bytes(32, 7)
    for (const password of ['', 'x', 'contraseña larga con ñ y espacios '.repeat(4)]) {
      const sig = ed25519Response(password, scramble)
      expect(sig).toHaveLength(64)
      // Deterministic, and different from another password's.
      expect(ed25519Response(password, scramble)).toEqual(sig)
      expect(ed25519Response(password + '!', scramble)).not.toEqual(sig)
    }
  })

  it('uses only the first 32 bytes of the scramble (mysql2 may pass a trailing NUL)', () => {
    const scramble = bytes(32)
    const padded = new Uint8Array([...scramble, 0])
    expect(ed25519Response('p', padded)).toEqual(ed25519Response('p', scramble))
    expect(() => ed25519Response('p', bytes(20))).toThrow()
  })
})

describe('parsec', () => {
  const salt = bytes(18, 3)
  const saltPacket = (factor: number): Uint8Array => new Uint8Array([0x50, factor, ...salt])

  it('derives the seed with PBKDF2-SHA512 and signs server || client scramble', () => {
    const server = bytes(32, 5)
    const client = bytes(32, 9)
    const password = 'parsec ñ'
    const out = parsecResponse(password, server, saltPacket(1), client)
    expect(out).toHaveLength(96)
    expect(out.subarray(0, 32)).toEqual(client)
    const seed = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 2048, 32, 'sha512')
    const publicKey = ed25519.getPublicKey(seed)
    expect(
      ed25519.verify(out.subarray(32), new Uint8Array([...server, ...client]), publicKey)
    ).toBe(true)
  })

  it('refuses a malformed salt packet and an excessive iteration factor', () => {
    expect(() => parseParsecSalt(new Uint8Array([0x51, 0, 1, 2]))).toThrow(/parsec no válido/)
    expect(() => parseParsecSalt(new Uint8Array([0x50, 0]))).toThrow(/parsec no válido/)
    expect(() => parseParsecSalt(saltPacket(PARSEC_MAX_ITERATION_FACTOR + 1))).toThrow(/máximo/)
    expect(parseParsecSalt(saltPacket(0))).toEqual({ factor: 0, salt })
  })

  it('mysql2 adapter: asks for the salt first, then answers with 96 bytes', async () => {
    const plugin = mariaDbAuthPlugins().parsec({
      connection: { config: { password: 'secret' } }
    })
    const first = await plugin(Buffer.from(bytes(32)))
    expect(first).toHaveLength(0)
    const second = await plugin(Buffer.from(saltPacket(0)))
    expect(second).toHaveLength(96)
  })

  it('mysql2 adapter: client_ed25519 answers the scramble in one round', async () => {
    const plugin = mariaDbAuthPlugins().client_ed25519({
      connection: { config: {} },
      command: { password: 'p' }
    })
    expect(await plugin(Buffer.from(bytes(32)))).toEqual(
      Buffer.from(ed25519Response('p', bytes(32)))
    )
  })
})
