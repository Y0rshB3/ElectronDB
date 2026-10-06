import type { Environment } from './types'

/**
 * Which connection environments need the typed-name confirmation before any
 * write (Ajustes › Seguridad). Shared by main (enforcement) and renderer
 * (dialogs) so both sides agree. Keep free of Node/Electron/browser imports.
 *
 * 'production' is always part of the list: it cannot be turned off, whatever
 * a stored or hand-edited settings file says.
 */

/** Canonical order, as shown in Ajustes. */
export const ALL_ENVIRONMENTS: readonly Environment[] = ['production', 'staging', 'local', 'other']

/** Environments that can never be removed from the list. */
export const MANDATORY_TYPED_ENVIRONMENTS: readonly Environment[] = ['production']

export const DEFAULT_TYPED_CONFIRM_ENVIRONMENTS: readonly Environment[] =
  MANDATORY_TYPED_ENVIRONMENTS

const LABELS: Record<Environment, string> = {
  production: 'Producción',
  staging: 'Staging',
  local: 'Local',
  other: 'Otro'
}

export const isEnvironment = (value: unknown): value is Environment =>
  typeof value === 'string' && (ALL_ENVIRONMENTS as readonly string[]).includes(value)

/**
 * Valid, de-duplicated list in canonical order, always including production.
 * Anything that is not an array (missing key, old settings with only
 * `confirmProductionWrites`) gives the default.
 */
export function normalizeTypedConfirmEnvironments(value: unknown): Environment[] {
  const wanted = new Set<Environment>(MANDATORY_TYPED_ENVIRONMENTS)
  if (Array.isArray(value)) for (const v of value) if (isEnvironment(v)) wanted.add(v)
  return ALL_ENVIRONMENTS.filter((e) => wanted.has(e))
}

/** True when writes to a connection in `environment` need the typed name. */
export function requiresTypedConfirm(
  environment: Environment | null | undefined,
  list: readonly Environment[] | null | undefined
): boolean {
  if (!environment) return false
  if (MANDATORY_TYPED_ENVIRONMENTS.includes(environment)) return true
  return !!list?.includes(environment)
}

/** "Producción", "Staging", "Local", "Otro". */
export function environmentName(environment: Environment): string {
  return LABELS[environment] ?? environment
}

/** Inline qualifier for messages: "producción" or "entorno Staging". */
export function environmentPhrase(environment: Environment): string {
  return environment === 'production' ? 'producción' : `entorno ${environmentName(environment)}`
}
