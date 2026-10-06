/**
 * Environment switches are named ELECTRONDB_<NAME>. The pre-rename spelling
 * NAVIDOG_<NAME> is still accepted as a fallback so old scripts keep working;
 * only the new names are documented.
 */
export const ENV_PREFIX = 'ELECTRONDB_'
export const LEGACY_ENV_PREFIX = 'NAVIDOG_'

/** Value of ELECTRONDB_<name>, else NAVIDOG_<name>, else undefined. */
export function envVar(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[ENV_PREFIX + name] ?? env[LEGACY_ENV_PREFIX + name]
}
