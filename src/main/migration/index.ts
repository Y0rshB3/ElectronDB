import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StartupNotice } from '@shared/types'
import type { AppContext } from '../context'
import { getLogger } from '../log'
import { readLegacySafeStoragePassword, type KeychainExecFn } from './legacyKeychain'
import {
  findLegacyProfile,
  migrateLegacyProfile,
  readMigrationMarker,
  writeMigrationMarker,
  type ProfileMigrationResult
} from './profile'
import { migrateLegacySecrets, reenterPasswordsMessage, type RawSecrets } from './secrets'

/**
 * Entry points of the Navidog -> ElectronDB migration, wired from index.ts:
 * the profile copy runs before app 'ready', the secret re-encryption right
 * after the context exists (safeStorage needs a ready app) and before any
 * window or scheduler can read a credential.
 */

export interface ProfileMigrationPlan {
  appData: string
  userData: string
  /** ELECTRONDB_USER_DATA: a scratch profile never imports the real legacy profile. */
  userDataOverride: string | null
  /** ELECTRONDB_LEGACY_USER_DATA (tests only): explicit legacy folder, migrated even into a scratch profile. */
  legacyUserDataOverride: string | null
  platform?: NodeJS.Platform
}

export function runProfileMigration(plan: ProfileMigrationPlan): ProfileMigrationResult {
  const log = getLogger('migration')
  let from: string | null
  if (plan.legacyUserDataOverride) from = plan.legacyUserDataOverride
  else if (plan.userDataOverride) return { status: 'skipped', reason: 'scratch profile' }
  else from = findLegacyProfile(plan.appData)
  if (!from) return { status: 'skipped', reason: 'no legacy profile' }
  try {
    const result = migrateLegacyProfile({
      from,
      to: plan.userData,
      platform: plan.platform,
      log
    })
    if (result.status === 'skipped') log.debug(`profile migration skipped: ${result.reason}`)
    return result
  } catch (err) {
    log.error('profile migration failed; starting with the current profile as is', err)
    return { status: 'skipped', reason: 'failed' }
  }
}

export interface SecretMigrationOptions {
  platform?: NodeJS.Platform
  /** Keychain file holding the legacy item (tests use a throwaway keychain). Default: search list. */
  keychain?: string | null
  exec?: KeychainExecFn
}

/**
 * Automatic passes of the secret migration while the legacy key cannot be read
 * for a reason that may go away (access denied, prompt not answered, locked
 * keychain, `security` error). After the last one the missing passwords are
 * given up and the user types them again.
 */
export const MAX_SECRET_ATTEMPTS = 3

/**
 * Values of the legacy profile's credentials.json that the current store
 * lacks, limited to connections that still exist. Empty when the legacy
 * folder or file is gone.
 */
export function legacySecretsToRetry(
  legacyProfile: string,
  ctx: Pick<AppContext, 'credentials' | 'connections'>
): RawSecrets {
  try {
    const doc = JSON.parse(readFileSync(join(legacyProfile, 'credentials.json'), 'utf8')) as {
      codec?: unknown
      items?: unknown
    }
    const items = doc.items && typeof doc.items === 'object' ? doc.items : {}
    const present = ctx.credentials.rawItems()
    const wanted: Record<string, string> = {}
    for (const [key, cipher] of Object.entries(items as Record<string, unknown>)) {
      const id = key.split(':').slice(1).join(':')
      if (typeof cipher === 'string' && !(key in present) && ctx.connections.get(id))
        wanted[key] = cipher
    }
    return { codec: doc.codec === 'plain' ? 'plain' : 'safeStorage', items: wanted }
  } catch {
    return { codec: 'safeStorage', items: {} }
  }
}

/**
 * Re-encrypts credentials copied by the profile migration. Never throws.
 *
 * The first pass works on the copied credentials.json. When the legacy key
 * could not be read for a transient reason the marker stays 'pending' and
 * the next interactive start retries (up to MAX_SECRET_ATTEMPTS passes),
 * reading the missing values again from the untouched legacy profile. The
 * same path recovers them later if the user sets "secrets" back to
 * "pending" in the marker (see README).
 */
export async function runSecretMigration(
  ctx: Pick<AppContext, 'userDataPath' | 'credentials' | 'connections'>,
  options: SecretMigrationOptions = {}
): Promise<void> {
  const log = getLogger('migration')
  const marker = readMigrationMarker(ctx.userDataPath)
  if (!marker || marker.secrets !== 'pending') return
  const platform = options.platform ?? process.platform
  const attempt = (marker.secretAttempts ?? 0) + 1
  try {
    const result = await migrateLegacySecrets({
      credentials: ctx.credentials,
      connections: ctx.connections,
      platform,
      retry: attempt > 1 ? legacySecretsToRetry(marker.from, ctx) : undefined,
      legacyPassword: () =>
        platform === 'darwin'
          ? readLegacySafeStoragePassword({ keychain: options.keychain, exec: options.exec })
          : Promise.resolve({
              ok: false,
              reason: 'not-found',
              detail: 'solo macOS guarda la clave en el llavero'
            }),
      log
    })
    const transient = result.legacyKeyReason === 'denied' || result.legacyKeyReason === 'failed'
    const retryLater = result.dropped.length > 0 && transient && attempt < MAX_SECRET_ATTEMPTS
    writeMigrationMarker(ctx.userDataPath, {
      ...marker,
      secrets: retryLater ? 'pending' : 'done',
      secretAttempts: attempt,
      legacyKeyProblem: result.legacyKeyProblem ?? undefined,
      passwordsToReenter: result.passwordsToReenter,
      noticeShown: result.passwordsToReenter.length === 0
    })
    if (retryLater)
      log.warn(
        `secret migration attempt ${attempt}/${MAX_SECRET_ATTEMPTS} could not read the legacy key; ` +
          `${result.dropped.length} value(s) will be retried on the next start`
      )
    else if (result.passwordsToReenter.length)
      log.warn(reenterPasswordsMessage(result.passwordsToReenter))
  } catch (err) {
    log.error('secret migration failed; it will be retried on the next start', err)
  }
}

export const REENTER_PASSWORDS_NOTICE = 'reenter-passwords'

/** Notices the renderer shows once after start (see app:startupNotices). */
export function startupNotices(userDataPath: string): StartupNotice[] {
  const marker = readMigrationMarker(userDataPath)
  const names = marker?.passwordsToReenter ?? []
  if (!marker || marker.noticeShown || names.length === 0) return []
  if (marker.secrets === 'pending') {
    const left = MAX_SECRET_ATTEMPTS - (marker.secretAttempts ?? 0)
    return [
      {
        id: REENTER_PASSWORDS_NOTICE,
        level: 'warning',
        title: 'Contraseñas de Navidog pendientes',
        message:
          `No se pudo leer la clave de Navidog en el llavero` +
          (marker.legacyKeyProblem ? ` (${marker.legacyKeyProblem})` : '') +
          `, así que estas contraseñas no están disponibles: ${names.join(', ')}. ` +
          `ElectronDB lo intentará de nuevo en el próximo arranque ` +
          `(${left === 1 ? 'queda 1 intento' : `quedan ${left} intentos`}): cuando macOS pregunte, elige «Permitir». ` +
          'Mientras tanto puedes escribirlas de nuevo editando cada conexión.'
      }
    ]
  }
  return [
    {
      id: REENTER_PASSWORDS_NOTICE,
      level: 'warning',
      title: 'Contraseñas que hay que volver a escribir',
      message:
        `${reenterPasswordsMessage(names)}. ` +
        'Se copiaron tus datos de Navidog a ElectronDB, pero estas contraseñas no se pudieron descifrar. ' +
        'Edita cada conexión y guarda la contraseña de nuevo.'
    }
  ]
}

export function dismissStartupNotice(userDataPath: string, id: string): void {
  if (id !== REENTER_PASSWORDS_NOTICE) return
  const marker = readMigrationMarker(userDataPath)
  if (marker && !marker.noticeShown)
    writeMigrationMarker(userDataPath, { ...marker, noticeShown: true })
}
