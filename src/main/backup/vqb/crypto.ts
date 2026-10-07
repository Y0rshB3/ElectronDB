import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions
} from 'node:crypto'
import { VqbFormatError, VqbIntegrityError, VqbPasswordError } from './errors'

/**
 * .vqb encryption (docs/vqb-format.md, "Encryption").
 *
 * Key: scrypt(NFC(password), salt, N, r, p) → 64 bytes; the first 32 are the
 * AES-256-GCM key, the last 32 only produce `keyCheck` = HMAC-SHA256(checkKey,
 * "vqb-key-check-v1"), stored in the plaintext header so a wrong password is
 * reported before anything is decrypted (and told apart from tampering).
 *
 * Each archive entry is encrypted on its own ("VQE1" stream):
 *
 *   magic "VQE1" | chunkSize uint32 BE | noncePrefix 8 bytes
 *   chunk*: ciphertext (chunkSize bytes, the last one shorter) + 16-byte tag
 *
 * nonce = noncePrefix ‖ chunk index (uint32 BE); AAD = the 16 header bytes ‖
 * UTF-8 entry path ‖ 0x00 ‖ final flag (1 on the last chunk, 0 otherwise). The
 * path binds a stream to its entry (no swapping), the index fixes the order
 * and the final flag makes a truncated stream fail. An empty plaintext is one
 * empty final chunk (just its tag).
 */

export const ENC_MAGIC = Buffer.from('VQE1', 'ascii')
export const ENC_HEADER_BYTES = 16
export const TAG_BYTES = 16
export const DEFAULT_CHUNK_SIZE = 64 * 1024
const MIN_CHUNK_SIZE = 1024
const MAX_CHUNK_SIZE = 16 * 1024 * 1024
export const KEY_CHECK_INFO = 'vqb-key-check-v1'

export interface ScryptParams {
  N: number
  r: number
  p: number
}

/** Defaults: 128 MiB of memory (128·N·r), ~0.3–0.6 s on a laptop. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 }

/** What a reader accepts from a file (bounds keep a hostile header from exhausting memory). */
const SCRYPT_LIMITS = { minLogN: 10, maxLogN: 20, maxR: 32, maxP: 16 }

export interface KdfDescriptor extends ScryptParams {
  name: 'scrypt'
  /** base64, 16 bytes or more. */
  salt: string
  keyLength: 64
}

export interface ArchiveKeys {
  key: Buffer
  keyCheck: string
}

function scrypt(password: Buffer, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * params.N * params.r + 32 * 1024 * 1024
  }
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, 64, options, (err, key) => (err ? reject(err) : resolve(key)))
  )
}

export function validateKdf(kdf: unknown): KdfDescriptor {
  const k = kdf as Partial<KdfDescriptor> | null
  const bad = (): never => {
    throw new VqbFormatError('La cabecera de cifrado de la copia no es válida.')
  }
  if (!k || typeof k !== 'object' || k.name !== 'scrypt') bad()
  const { N, r, p, salt, keyLength } = k as KdfDescriptor
  const logN = Math.log2(N)
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(logN) ||
    logN < SCRYPT_LIMITS.minLogN ||
    logN > SCRYPT_LIMITS.maxLogN ||
    !Number.isInteger(r) ||
    r < 1 ||
    r > SCRYPT_LIMITS.maxR ||
    !Number.isInteger(p) ||
    p < 1 ||
    p > SCRYPT_LIMITS.maxP ||
    keyLength !== 64 ||
    typeof salt !== 'string' ||
    Buffer.from(salt, 'base64').length < 16
  )
    bad()
  return k as KdfDescriptor
}

const passwordBytes = (password: string): Buffer => Buffer.from(password.normalize('NFC'), 'utf8')

const checkOf = (checkKey: Buffer): string =>
  createHmac('sha256', checkKey).update(KEY_CHECK_INFO).digest('base64')

/** New random salt + derived keys for an archive being written. */
export async function newArchiveKeys(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT
): Promise<{ kdf: KdfDescriptor; keys: ArchiveKeys }> {
  if (!password) throw new Error('La contraseña de la copia no puede estar vacía.')
  const salt = randomBytes(16)
  const raw = await scrypt(passwordBytes(password), salt, params)
  return {
    kdf: { name: 'scrypt', ...params, salt: salt.toString('base64'), keyLength: 64 },
    keys: { key: raw.subarray(0, 32), keyCheck: checkOf(raw.subarray(32)) }
  }
}

/** Derives the key of an archive and checks it against `keyCheck` (wrong password → VqbPasswordError). */
export async function unlockArchive(
  password: string | null | undefined,
  kdf: KdfDescriptor,
  keyCheck: string
): Promise<Buffer> {
  if (!password) throw new VqbPasswordError('required')
  const raw = await scrypt(passwordBytes(password), Buffer.from(kdf.salt, 'base64'), kdf)
  const expected = Buffer.from(keyCheck, 'base64')
  const actual = Buffer.from(checkOf(raw.subarray(32)), 'base64')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new VqbPasswordError('wrong')
  return raw.subarray(0, 32)
}

const aadOf = (header: Buffer, path: string, final: boolean): Buffer =>
  Buffer.concat([header, Buffer.from(path, 'utf8'), Buffer.from([0, final ? 1 : 0])])

const nonceOf = (prefix: Buffer, index: number): Buffer => {
  const nonce = Buffer.alloc(12)
  prefix.copy(nonce, 0, 0, 8)
  nonce.writeUInt32BE(index, 8)
  return nonce
}

/** Encrypts one entry body (see the module comment). */
export function encryptEntry(
  plain: Buffer,
  key: Buffer,
  path: string,
  chunkSize = DEFAULT_CHUNK_SIZE
): Buffer {
  const header = Buffer.alloc(ENC_HEADER_BYTES)
  ENC_MAGIC.copy(header, 0)
  header.writeUInt32BE(chunkSize, 4)
  randomBytes(8).copy(header, 8)
  const prefix = header.subarray(8, 16)
  const parts: Buffer[] = [header]
  const chunks = Math.max(1, Math.ceil(plain.length / chunkSize))
  if (chunks > 0xffffffff) throw new Error('Entrada demasiado grande para cifrar')
  for (let i = 0; i < chunks; i++) {
    const slice = plain.subarray(i * chunkSize, Math.min(plain.length, (i + 1) * chunkSize))
    const cipher = createCipheriv('aes-256-gcm', key, nonceOf(prefix, i))
    cipher.setAAD(aadOf(header, path, i === chunks - 1))
    parts.push(cipher.update(slice), cipher.final(), cipher.getAuthTag())
  }
  return Buffer.concat(parts)
}

/**
 * Decrypts one entry body. Any failed tag (tampering, truncation, a stream
 * moved to another path) throws VqbIntegrityError naming `path`.
 */
export function decryptEntry(data: Buffer, key: Buffer, path: string): Buffer {
  if (data.length < ENC_HEADER_BYTES + TAG_BYTES || !data.subarray(0, 4).equals(ENC_MAGIC))
    throw new VqbIntegrityError(path)
  const header = data.subarray(0, ENC_HEADER_BYTES)
  const chunkSize = header.readUInt32BE(4)
  if (chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) throw new VqbIntegrityError(path)
  const prefix = header.subarray(8, 16)
  const body = data.subarray(ENC_HEADER_BYTES)
  const full = chunkSize + TAG_BYTES
  // Every chunk but the last is exactly `full` bytes; the last holds 0..chunkSize bytes.
  const chunks = Math.max(1, Math.ceil(body.length / full))
  const out: Buffer[] = []
  try {
    for (let i = 0; i < chunks; i++) {
      const piece = body.subarray(i * full, Math.min(body.length, (i + 1) * full))
      if (piece.length < TAG_BYTES) throw new VqbIntegrityError(path)
      const decipher = createDecipheriv('aes-256-gcm', key, nonceOf(prefix, i))
      decipher.setAAD(aadOf(header, path, i === chunks - 1))
      decipher.setAuthTag(piece.subarray(piece.length - TAG_BYTES))
      out.push(decipher.update(piece.subarray(0, piece.length - TAG_BYTES)), decipher.final())
    }
  } catch (err) {
    if (err instanceof VqbIntegrityError) throw err
    throw new VqbIntegrityError(path)
  }
  return Buffer.concat(out)
}
