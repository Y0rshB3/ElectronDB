import { execFile } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import type { KeychainRecoveryResult } from '@shared/types'
import type { AppContext } from '../context'
import { getLogger } from '../log'
import { Blowfish } from './blowfish'

const log = getLogger('navicat.keychain')

export const NAVICAT_KEYCHAIN_SERVICE = 'com.navicat.NavicatForMySQL'

/** Navicat >= 12 scheme: AES-128-CBC with fixed key/IV, PKCS7 padding, hex output. */
const AES_KEY = Buffer.from('libcckeylibcckey', 'latin1')
const AES_IV = Buffer.from('libcciv libcciv ', 'latin1')

/** Navicat 11 scheme: Blowfish with SHA1('3DC5CA39') key and a CBC-like custom chaining. */
const BF_KEY = createHash('sha1').update('3DC5CA39').digest()
const BF_IV = Buffer.from('d9c7c3c8870d64bd', 'hex')

export interface ExecResult {
  stdout: string
}
export type ExecFn = (command: string, args: string[]) => Promise<ExecResult>

export interface KeychainDeps {
  platform: NodeJS.Platform
  exec: ExecFn
}

const defaultExec: ExecFn = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 }, (err, stdout) => {
      if (err) reject(err)
      else resolve({ stdout })
    })
  })

const defaultDeps: KeychainDeps = { platform: process.platform, exec: defaultExec }

/* ---------- decoding ---------- */

const isHex = (s: string): boolean => s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s)

const utf8Strict = new TextDecoder('utf-8', { fatal: true })

/** Non-empty text without control characters (tabs/newlines excluded) or U+FFFD. */
export function isPrintable(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return text.length > 0 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f�]/.test(text)
}

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

/** Navicat >= 12: hex(AES-128-CBC(key, iv, PKCS7)). Null when it does not decrypt cleanly. */
export function decryptNavicat12(hex: string): string | null {
  if (!isHex(hex)) return null
  try {
    const decipher = createDecipheriv('aes-128-cbc', AES_KEY, AES_IV)
    const plain = Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()])
    return asPrintable(plain)
  } catch {
    return null
  }
}

/** Inverse of {@link decryptNavicat12}; used to build test vectors. */
export function encryptNavicat12(plain: string): string {
  const cipher = createCipheriv('aes-128-cbc', AES_KEY, AES_IV)
  return Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()])
    .toString('hex')
    .toUpperCase()
}

/**
 * Navicat 11: Blowfish-ECB blocks chained as
 *   plain[i] = decrypt(cipher[i]) XOR cv;  cv = cv XOR cipher[i]
 * and a trailing partial block XORed with encrypt(cv).
 */
export function decryptNavicat11(hex: string): string | null {
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

/** Inverse of {@link decryptNavicat11}; used to build test vectors. */
export function encryptNavicat11(plain: string): string {
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

/** Tries every known scheme; returns the first printable plaintext, or the raw value when already printable. */
export function decodeNavicatSecret(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  return decryptNavicat12(value) ?? decryptNavicat11(value) ?? (isPrintable(value) ? value : null)
}

/* ---------- keychain listing ---------- */

/** Extracts the `acct` of every `security dump-keychain` item whose `svce` matches. */
export function parseDumpAccounts(dump: string, service = NAVICAT_KEYCHAIN_SERVICE): string[] {
  const accounts = new Set<string>()
  for (const block of dump.split(/^keychain: /m)) {
    const svce = /"svce"<blob>="((?:[^"\\]|\\.)*)"/.exec(block)
    if (!svce || unescapeBlob(svce[1]) !== service) continue
    const acct = /"acct"<blob>="((?:[^"\\]|\\.)*)"/.exec(block)
    if (acct) accounts.add(unescapeBlob(acct[1]))
  }
  return [...accounts]
}

function unescapeBlob(value: string): string {
  return value.replace(/\\(.)/g, '$1')
}

/* ---------- mapping secrets to connections ---------- */

export interface SecretMatch {
  connectionName: string
  password: string
}

/**
 * Interprets a decoded secret. A JSON object whose keys are Navicat
 * connection names (at any nesting level up to 4) maps to those connections;
 * values may themselves be encoded with a Navicat scheme. Anything else
 * yields no match.
 */
export function matchSecretToConnections(
  decoded: string,
  connectionNames: Set<string>
): SecretMatch[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    return []
  }
  const found: SecretMatch[] = []
  const walk = (node: unknown, depth: number): void => {
    if (depth > 4 || typeof node !== 'object' || node === null || Array.isArray(node)) return
    for (const [key, value] of Object.entries(node)) {
      if (connectionNames.has(key) && typeof value === 'string') {
        const password = decodeNavicatSecret(value) ?? value
        if (password) found.push({ connectionName: key, password })
      } else if (typeof value === 'object') {
        walk(value, depth + 1)
      }
    }
  }
  walk(parsed, 0)
  return found
}

/* ---------- entry point ---------- */

export type KeychainContext = Pick<AppContext, 'connections' | 'credentials'>

/**
 * Best-effort recovery of Navicat passwords from the macOS Keychain. Never
 * throws and never returns or logs secrets. macOS prompts once per item.
 */
export async function recoverNavicatPasswords(
  ctx: KeychainContext,
  deps: KeychainDeps = defaultDeps
): Promise<KeychainRecoveryResult> {
  const result: KeychainRecoveryResult = { attempted: 0, recovered: [], warnings: [] }
  try {
    return await recoverInto(result, ctx, deps)
  } catch (err) {
    // Last-resort guard: recovery is best effort and must never reject.
    log.warn(`keychain recovery aborted: ${describe(err)}`)
    result.warnings.push(`La recuperación desde el llavero se interrumpió (${describe(err)})`)
    return result
  }
}

async function recoverInto(
  result: KeychainRecoveryResult,
  ctx: KeychainContext,
  deps: KeychainDeps
): Promise<KeychainRecoveryResult> {
  if (deps.platform !== 'darwin') {
    result.warnings.push('La recuperación desde el llavero solo está disponible en macOS')
    return result
  }

  let accounts: string[]
  try {
    const { stdout } = await deps.exec('security', ['dump-keychain'])
    accounts = parseDumpAccounts(stdout)
  } catch (err) {
    log.warn(`keychain listing failed: ${describe(err)}`)
    result.warnings.push(`No se pudo listar el llavero (${describe(err)})`)
    return result
  }
  if (accounts.length === 0) {
    result.warnings.push(`No hay elementos del servicio ${NAVICAT_KEYCHAIN_SERVICE} en el llavero`)
    return result
  }

  const imported = ctx.connections.list().filter((c) => c.source?.app === 'navicat')
  const byNavicatName = new Map(imported.map((c) => [c.source?.name ?? c.name, c]))
  const names = new Set(byNavicatName.keys())

  for (const account of accounts) {
    result.attempted++
    let raw: string
    try {
      const { stdout } = await deps.exec('security', [
        'find-generic-password',
        '-s',
        NAVICAT_KEYCHAIN_SERVICE,
        '-a',
        account,
        '-w'
      ])
      raw = stdout.replace(/\r?\n$/, '')
    } catch (err) {
      result.warnings.push(
        `Acceso denegado o fallido para el elemento ${account} (${describe(err)})`
      )
      continue
    }
    const decoded = decodeNavicatSecret(raw)
    if (decoded === null) {
      result.warnings.push(
        `El elemento ${account} no se pudo descifrar con los esquemas conocidos de Navicat`
      )
      continue
    }
    const matches = matchSecretToConnections(decoded, names)
    if (matches.length === 0) {
      result.recovered.push({ account, connectionName: null })
      continue
    }
    for (const match of matches) {
      const connection = byNavicatName.get(match.connectionName)
      if (!connection) continue
      try {
        ctx.credentials.set('mysql', connection.id, match.password)
        result.recovered.push({ account, connectionName: match.connectionName })
      } catch (err) {
        result.warnings.push(
          `No se pudo guardar la contraseña de "${match.connectionName}" (${describe(err)})`
        )
      }
    }
  }
  log.info(
    `keychain recovery: attempted=${result.attempted} recovered=${result.recovered.length} warnings=${result.warnings.length}`
  )
  return result
}

/** `security` exit codes worth translating (see `man security`, errSec* values truncated to 8 bits). */
const SECURITY_EXIT_MESSAGES: Record<number, string> = {
  36: 'llavero bloqueado o interacción no permitida',
  44: 'elemento no encontrado en el llavero',
  51: 'autenticación del llavero fallida',
  128: 'el usuario canceló o denegó el acceso'
}

/** Short, secret-free description of an exec failure (never includes stdout). */
function describe(err: unknown): string {
  const e = (err && typeof err === 'object' ? err : {}) as {
    code?: unknown
    killed?: unknown
    signal?: unknown
  }
  if (e.code === 'ENOENT') return 'comando security no encontrado'
  if (e.killed === true || e.signal === 'SIGTERM') return 'tiempo de espera agotado'
  if (typeof e.code === 'number' && SECURITY_EXIT_MESSAGES[e.code])
    return SECURITY_EXIT_MESSAGES[e.code]
  const message = err instanceof Error ? err.message : String(err)
  return message.split('\n')[0].slice(0, 200)
}
