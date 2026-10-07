/**
 * Environment switches are named VORTAQ_<NAME>. The spellings of the earlier
 * product names (ELECTRONDB_<NAME>, then NAVIDOG_<NAME>) are still accepted
 * as fallbacks so old scripts keep working; only the new names are documented.
 */
export const ENV_PREFIX = 'VORTAQ_'
export const LEGACY_ENV_PREFIXES = ['ELECTRONDB_', 'NAVIDOG_'] as const

/** Value of VORTAQ_<name>, else ELECTRONDB_<name>, else NAVIDOG_<name>, else undefined. */
export function envVar(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const prefix of [ENV_PREFIX, ...LEGACY_ENV_PREFIXES]) {
    const value = env[prefix + name]
    if (value !== undefined) return value
  }
  return undefined
}
