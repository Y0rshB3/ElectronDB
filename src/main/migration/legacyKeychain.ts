import { execFile } from 'node:child_process'
import { LEGACY_NAVIDOG, type LegacyApp } from '../brand'

/**
 * Keychain items that may hold the safeStorage password of an earlier product
 * name. Electron names the item "<app name> Safe Storage"; the lowercase
 * variant covers runs where the name came from package.json ("navidog")
 * instead of app.setName.
 */
export function legacySafeStorageServices(source: Pick<LegacyApp, 'name'>): string[] {
  return [`${source.name} Safe Storage`, `${source.name.toLowerCase()} Safe Storage`]
}

/** The Navidog items (the only legacy name before Vortaq). */
export const LEGACY_SAFE_STORAGE_SERVICES = legacySafeStorageServices(LEGACY_NAVIDOG)

export type KeychainExecFn = (file: string, args: string[]) => Promise<{ stdout: string }>

export type KeychainReadResult =
  | { ok: true; password: string }
  | { ok: false; reason: 'not-found' | 'denied' | 'failed'; detail: string }

/** Generous: macOS shows an "allow access" prompt the user has to answer. */
const PROMPT_TIMEOUT_MS = 180_000

export const defaultKeychainExec: KeychainExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: PROMPT_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err)
      else resolve({ stdout: String(stdout) })
    })
  })

/**
 * Reads one generic password with `security find-generic-password -w`. The
 * keychain file is the user's default search list unless `keychain` is given
 * (tests point it at a throwaway keychain). Never throws and never logs the
 * password.
 */
export async function readGenericPassword(
  service: string,
  options: { keychain?: string | null; exec?: KeychainExecFn } = {}
): Promise<KeychainReadResult> {
  const exec = options.exec ?? defaultKeychainExec
  const args = ['find-generic-password', '-s', service, '-w']
  if (options.keychain) args.push(options.keychain)
  try {
    const { stdout } = await exec('security', args)
    const password = stdout.replace(/\r?\n$/, '')
    if (!password) return { ok: false, reason: 'not-found', detail: 'contraseña vacía' }
    return { ok: true, password }
  } catch (err) {
    return classifySecurityError(err)
  }
}

function classifySecurityError(err: unknown): KeychainReadResult {
  const e = (err && typeof err === 'object' ? err : {}) as {
    code?: unknown
    killed?: unknown
    signal?: unknown
  }
  if (e.code === 44) return { ok: false, reason: 'not-found', detail: 'elemento no encontrado' }
  // 128: errSecUserCanceled; 51: errSecAuthFailed; 36: interaction not allowed / locked.
  if (e.code === 128 || e.code === 51 || e.code === 36)
    return { ok: false, reason: 'denied', detail: `acceso denegado (código ${e.code})` }
  if (e.killed === true || e.signal === 'SIGTERM')
    return { ok: false, reason: 'denied', detail: 'sin respuesta al aviso del llavero' }
  if (e.code === 'ENOENT')
    return { ok: false, reason: 'failed', detail: 'comando security no encontrado' }
  // Never the raw error: its message is execFile's "Command failed: security … <keychain path>",
  // which ends up in a user-facing notice.
  return {
    ok: false,
    reason: 'failed',
    detail:
      typeof e.code === 'number'
        ? `el comando security terminó con el código ${e.code}`
        : 'el comando security falló'
  }
}

/**
 * The safeStorage password of an earlier product name: tries each of its
 * service names (default: Navidog's) until one exists. Stops at the first denial (asking again would just repeat the
 * prompt the user already refused).
 */
export async function readLegacySafeStoragePassword(
  options: { keychain?: string | null; exec?: KeychainExecFn; services?: string[] } = {}
): Promise<KeychainReadResult> {
  let last: KeychainReadResult = { ok: false, reason: 'not-found', detail: 'sin servicios' }
  for (const service of options.services ?? LEGACY_SAFE_STORAGE_SERVICES) {
    last = await readGenericPassword(service, options)
    if (last.ok || last.reason !== 'not-found') return last
  }
  return last
}
