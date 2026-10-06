import type { ConnectionsRepo } from '../storage/repos'
import type { CredentialStore } from '../credentials/store'
import { plainCodec, type CodecName } from '../credentials/store'
import type { Logger } from '../log'
import { isPrintable } from '../navicat/keychain'
import { decryptMacOsCrypt, deriveMacOsCryptKey, hasMacOsCryptPrefix } from './osCrypt'
import type { KeychainReadResult } from './legacyKeychain'

/**
 * Re-encrypts the secrets copied from the pre-rename profile.
 *
 * safeStorage ties its key to the app name on macOS (keychain item
 * "<name> Safe Storage") and on Linux (keyring entry per application), so the
 * values written by "Navidog" are unreadable for "ElectronDB":
 * - macOS: the old keychain password is read once (macOS asks for permission)
 *   and each 'v10' value is decrypted with node:crypto, then re-encrypted with
 *   the current safeStorage.
 * - Windows: DPAPI protects a per-user key stored in "Local State", which the
 *   profile migration copies, so the current safeStorage decrypts the values
 *   itself; anything it cannot read is dropped.
 * - Linux: values the current safeStorage can still read (basic_text backend)
 *   stay; the rest (old keyring entry) are dropped.
 * Dropped values make the connection ask for its password again, and the
 * caller tells the user which ones. Nothing is lost for good: the legacy
 * profile keeps its credentials.json, and a retry (see `retry`) reads the
 * dropped values from there again.
 */

/** Encoded values of one credentials.json and the codec that wrote them. */
export interface RawSecrets {
  codec: CodecName
  items: Record<string, string>
}

export interface SecretMigrationDeps {
  credentials: Pick<
    CredentialStore,
    'codecName' | 'storedCodec' | 'rawItems' | 'replaceRaw' | 'encode' | 'decode'
  >
  connections: Pick<ConnectionsRepo, 'get'>
  platform: NodeJS.Platform
  /** The legacy safeStorage password (macOS keychain); called at most once and only when needed. */
  legacyPassword: () => Promise<KeychainReadResult>
  /**
   * Retry after an earlier pass: the current items were already migrated (or
   * typed again) and stay as they are; only these values, read again from the
   * legacy profile for keys the current store lacks, are recovered.
   */
  retry?: RawSecrets
  log?: Pick<Logger, 'info' | 'warn'>
}

export interface SecretMigrationResult {
  /** Values re-encrypted with the current codec. */
  migrated: number
  /** Values the current codec already reads; left untouched. */
  kept: number
  /** Item keys (`mysql:<id>`) dropped because they could not be decrypted. */
  dropped: string[]
  /** Human labels of the dropped items, e.g. «Producción» or «Producción (SSH)». */
  passwordsToReenter: string[]
  /** Why the old key was unavailable, when it was needed and missing. */
  legacyKeyProblem: string | null
  /** Category of that problem: only 'denied' and 'failed' are worth retrying. */
  legacyKeyReason: Extract<KeychainReadResult, { ok: false }>['reason'] | null
}

function readable(text: string | null): text is string {
  return text !== null && isPrintable(text)
}

function label(key: string, connections: SecretMigrationDeps['connections']): string {
  const [kind, ...rest] = key.split(':')
  const id = rest.join(':')
  const name = connections.get(id)?.name ?? id
  return kind === 'ssh' ? `${name} (SSH)` : name
}

export async function migrateLegacySecrets(
  deps: SecretMigrationDeps
): Promise<SecretMigrationResult> {
  const { credentials, platform, log } = deps
  const result: SecretMigrationResult = {
    migrated: 0,
    kept: 0,
    dropped: [],
    passwordsToReenter: [],
    legacyKeyProblem: null,
    legacyKeyReason: null
  }
  const current = credentials.codecName
  const next: Record<string, string> = {}
  let source: RawSecrets
  if (deps.retry) {
    for (const [key, cipher] of Object.entries(credentials.rawItems())) {
      next[key] = cipher
      result.kept++
    }
    source = deps.retry
  } else {
    source = { codec: credentials.storedCodec(), items: credentials.rawItems() }
  }

  let legacyKey: Buffer | null | undefined
  const getLegacyKey = async (): Promise<Buffer | null> => {
    if (legacyKey !== undefined) return legacyKey
    const read = await deps.legacyPassword()
    if (read.ok) {
      legacyKey = deriveMacOsCryptKey(read.password)
    } else {
      legacyKey = null
      result.legacyKeyProblem = read.detail
      result.legacyKeyReason = read.reason
      log?.warn(`legacy safeStorage key unavailable (${read.reason}: ${read.detail})`)
    }
    return legacyKey
  }

  for (const [key, cipher] of Object.entries(source.items)) {
    if (key in next) continue
    let plain: string | null = null

    if (source.codec === 'plain') {
      // Test/fallback profiles: base64 only, readable on any machine.
      try {
        plain = plainCodec.decrypt(cipher)
      } catch {
        plain = null
      }
      if (readable(plain) && current === 'plain') {
        next[key] = cipher
        result.kept++
        continue
      }
    } else {
      const raw = Buffer.from(cipher, 'base64')
      if (platform === 'darwin' && hasMacOsCryptPrefix(raw)) {
        const k = await getLegacyKey()
        if (k) plain = decryptMacOsCrypt(raw, k)
      }
      // Windows (copied Local State) and Linux basic_text: still readable as is.
      if (plain === null && current === 'safeStorage') {
        try {
          const own = credentials.decode(cipher)
          if (readable(own)) {
            next[key] = cipher
            result.kept++
            continue
          }
        } catch {
          /* encrypted under the old app name */
        }
      }
    }

    if (readable(plain)) {
      try {
        next[key] = credentials.encode(plain)
        result.migrated++
        continue
      } catch (err) {
        log?.warn(`could not re-encrypt ${key.split(':')[0]} secret`, err)
      }
    }
    result.dropped.push(key)
    result.passwordsToReenter.push(label(key, deps.connections))
  }

  credentials.replaceRaw(next)
  log?.info(
    `secret migration${deps.retry ? ' (retry)' : ''}: ${result.migrated} re-encrypted, ${result.kept} kept, ${result.dropped.length} dropped`
  )
  return result
}

/** Spanish notice listing the passwords the user has to type again. */
export function reenterPasswordsMessage(names: string[]): string {
  return `Vuelve a escribir la contraseña de: ${names.join(', ')}`
}
