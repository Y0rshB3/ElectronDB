/**
 * MariaDB authentication plugins for mysql2 (`authPlugins` pool option):
 *
 * - `client_ed25519` (server plugin `ed25519`): the server sends a 32-byte
 *   scramble; the client answers with an Ed25519 signature of it whose
 *   secret is derived from the password the way MariaDB does it: the
 *   SHA-512 of the password *bytes* (any length) plays the role of the
 *   hashed seed of RFC 8032.
 * - `parsec` (MariaDB 11.6+): the server sends a 32-byte scramble; the client
 *   asks for the salt with an empty packet, the server answers `P`, an
 *   iteration factor and the salt; the client derives a 32-byte Ed25519 seed
 *   with PBKDF2-HMAC-SHA512 (1024 << factor iterations), picks its own
 *   32-byte scramble and sends it followed by the signature of
 *   server scramble || client scramble.
 *
 * Pure functions plus the small mysql2 adapter; nothing here logs, and the
 * password never leaves these functions except as a signature.
 */
import { randomBytes } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { sha512 } from '@noble/hashes/sha2.js'

const SCRAMBLE_LENGTH = 32
/** Highest parsec iteration factor accepted (1024 << 8 = 262,144 rounds). */
export const PARSEC_MAX_ITERATION_FACTOR = 8

const encoder = new TextEncoder()

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** Little-endian bytes as a bigint (RFC 8032 integers). */
function leBytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i])
  return n
}

function bigIntToLeBytes(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length)
  let v = n
  for (let i = 0; i < length; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/**
 * Signature MariaDB's `ed25519` plugin expects for `scramble`: RFC 8032
 * signing where the 64-byte expanded key is SHA-512(password) instead of
 * SHA-512(32-byte seed).
 */
export function ed25519Response(password: string, scramble: Uint8Array): Uint8Array {
  if (scramble.length < SCRAMBLE_LENGTH) throw new Error('scramble too short')
  const message = scramble.subarray(0, SCRAMBLE_LENGTH)
  const { Point } = ed25519
  const Fn = Point.Fn
  const h = sha512(encoder.encode(password))
  const head = h.slice(0, 32)
  head[0] &= 248
  head[31] &= 63
  head[31] |= 64
  // The base point has order L, so the clamped scalar can be reduced mod L.
  const s = Fn.create(leBytesToBigInt(head))
  const publicKey = Point.BASE.multiply(s).toBytes()
  // r = 0 (probability ~2^-252) cannot be multiplied by noble; 1 keeps R and S consistent.
  const r = Fn.create(leBytesToBigInt(sha512(concat(h.subarray(32), message)))) || 1n
  const R = Point.BASE.multiply(r).toBytes()
  const k = Fn.create(leBytesToBigInt(sha512(concat(R, publicKey, message))))
  const S = Fn.create(k * s + r)
  return concat(R, bigIntToLeBytes(S, 32))
}

/** Salt packet of the parsec handshake: `P`, iteration factor, salt. */
export function parseParsecSalt(packet: Uint8Array): { factor: number; salt: Uint8Array } {
  if (packet.length < 3 || packet[0] !== 0x50 /* 'P' */) {
    throw new Error('El servidor envió un paquete parsec no válido.')
  }
  const factor = packet[1]
  if (factor > PARSEC_MAX_ITERATION_FACTOR) {
    throw new Error(
      `El servidor pide ${factor} como factor de iteraciones parsec (máximo ${PARSEC_MAX_ITERATION_FACTOR}).`
    )
  }
  return { factor, salt: packet.slice(2) }
}

/** Client scramble + signature for parsec (96 bytes). */
export function parsecResponse(
  password: string,
  serverScramble: Uint8Array,
  saltPacket: Uint8Array,
  clientScramble: Uint8Array = randomBytes(SCRAMBLE_LENGTH)
): Uint8Array {
  if (serverScramble.length < SCRAMBLE_LENGTH) throw new Error('scramble too short')
  const { factor, salt } = parseParsecSalt(saltPacket)
  const seed = pbkdf2(sha512, encoder.encode(password), salt, {
    c: 1024 << factor,
    dkLen: 32
  })
  const message = concat(serverScramble.subarray(0, SCRAMBLE_LENGTH), clientScramble)
  return concat(clientScramble, ed25519.sign(message, seed))
}

/* ---------- mysql2 adapters ---------- */

/** What mysql2 passes to a plugin (its typings call `command` a string; at runtime it is the command). */
interface PluginEnv {
  connection: { config: { password?: string } }
  command?: unknown
}
type PluginStep = (data: Buffer) => Buffer | Promise<Buffer>
type AuthPlugin = (env: PluginEnv) => PluginStep

/** The password of a changeUser command, else the connection's ('' when there is none). */
function passwordOf(env: PluginEnv): string {
  const command = env.command as { password?: unknown } | undefined
  if (command && typeof command === 'object' && typeof command.password === 'string')
    return command.password
  return env.connection.config.password ?? ''
}

const clientEd25519: AuthPlugin = (env) => (data) =>
  Buffer.from(ed25519Response(passwordOf(env), new Uint8Array(data)))

const parsec: AuthPlugin = (env) => {
  let serverScramble: Uint8Array | null = null
  return (data) => {
    if (!serverScramble) {
      // First round: keep the scramble, ask for the salt with an empty packet.
      if (data.length < SCRAMBLE_LENGTH) throw new Error('El servidor envió un reto parsec corto.')
      serverScramble = new Uint8Array(data.subarray(0, SCRAMBLE_LENGTH))
      return Buffer.alloc(0)
    }
    return Buffer.from(parsecResponse(passwordOf(env), serverScramble, new Uint8Array(data)))
  }
}

/**
 * `authPlugins` for mysql2: MariaDB's ed25519 and parsec. Offered to every
 * MySQL-family connection; a MySQL server never asks for them.
 */
export function mariaDbAuthPlugins(): Record<string, AuthPlugin> {
  return { client_ed25519: clientEd25519, parsec }
}
