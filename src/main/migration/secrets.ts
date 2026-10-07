import type { ConnectionsRepo } from '../storage/repos'
import type { CredentialStore } from '../credentials/store'
import { plainCodec, type CodecName } from '../credentials/store'
import type { Logger } from '../log'
import { isPrintable } from '../navicat/keychain'
import { decryptMacOsCrypt, deriveMacOsCryptKey, hasMacOsCryptPrefix } from './osCrypt'
import type { KeychainReadResult } from './legacyKeychain'

/**
 * Re-encrypts the secrets copied from the profile of an earlier product name.
 *
 * safeStorage ties its key to the app name on macOS (keychain item
 * "<name> Safe Storage") and on Linux (keyring entry per application), so the
 * values written by "ElectronDB" (or "Navidog") are unreadable for "Vortaq":
 * - macOS: the old keychain password is read once (macOS asks for permission)
 *   and each 'v10' value is decrypted with node:crypto, then re-encrypted with
 *   the current safeStorage. An ElectronDB profile can still hold values from
 *   its own Navidog migration, so several old keys are tried, newest first,
 *   and an older one is only read when the newer ones do not decrypt a value.
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
  /** Name of an AI provider (`ai:<providerId>` keys), for the re-entry notice. */
  aiProviderName?: (id: string) => string | undefined
  platform: NodeJS.Platform
  /**
   * Readers of the legacy safeStorage passwords (macOS keychain), newest name
   * first. Each one is called at most once and only when the newer keys could
   * not decrypt a value; a denied read stops the chain (asking again would
   * repeat the prompt the user just refused).
   */
  legacyPasswords?: Array<() => Promise<KeychainReadResult>>
  /** Single-reader form of `legacyPasswords`. */
  legacyPassword?: () => Promise<KeychainReadResult>
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
  /** Item keys (`mysql:<id>`, `ai:<providerId>`...) dropped because they could not be decrypted. */
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

function label(
  key: string,
  deps: Pick<SecretMigrationDeps, 'connections' | 'aiProviderName'>
): string {
  const [kind, ...rest] = key.split(':')
  const id = rest.join(':')
  if (kind === 'ai') return `clave de IA «${deps.aiProviderName?.(id) ?? id}»`
  const name = deps.connections.get(id)?.name ?? id
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

  const readers = deps.legacyPasswords ?? (deps.legacyPassword ? [deps.legacyPassword] : [])
  const legacyKeys: Array<Buffer | null> = []
  let chainStopped = false
  /** Key `i` of the chain (read on first use), or null when it is unavailable. */
  const getLegacyKey = async (i: number): Promise<Buffer | null> => {
    if (i < legacyKeys.length) return legacyKeys[i]
    if (chainStopped) return null
    const read = await readers[i]()
    if (read.ok) {
      legacyKeys.push(deriveMacOsCryptKey(read.password))
    } else {
      legacyKeys.push(null)
      // 'not-found' is normal for an older name that was never installed, so
      // it never hides a more useful reason (denied, failed) already recorded.
      if (read.reason !== 'not-found' || result.legacyKeyReason === null) {
        result.legacyKeyProblem = read.detail
        result.legacyKeyReason = read.reason
      }
      if (read.reason === 'denied') chainStopped = true
      log?.warn(`legacy safeStorage key ${i + 1} unavailable (${read.reason}: ${read.detail})`)
    }
    return legacyKeys[i]
  }
  const decryptLegacy = async (raw: Buffer): Promise<string | null> => {
    for (let i = 0; i < readers.length; i++) {
      const k = await getLegacyKey(i)
      const plain = k ? decryptMacOsCrypt(raw, k) : null
      if (plain !== null) return plain
      if (chainStopped) break
    }
    return null
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
      if (platform === 'darwin' && hasMacOsCryptPrefix(raw)) plain = await decryptLegacy(raw)
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
    result.passwordsToReenter.push(label(key, deps))
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
