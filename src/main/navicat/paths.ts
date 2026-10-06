import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Well-known locations inside a Navicat CC root directory. */
export interface NavicatPaths {
  root: string
  connPlist: string
  prefPlist: string
  profilesDir: string
  schedulePlist: string
  /** Common/Settings/0/0/MySQL — one folder per connection (default savepath). */
  settingsDir: string
}

export const JOB_FILE_EXTENSION = '.nbatmysql'

export function navicatPaths(root: string): NavicatPaths {
  return {
    root,
    connPlist: join(root, 'Common', 'conn.plist'),
    prefPlist: join(root, 'Common', 'pref.plist'),
    profilesDir: join(root, 'Navicat for MySQL', 'Profiles'),
    schedulePlist: join(root, 'Navicat for MySQL', 'schedule.plist'),
    settingsDir: join(root, 'Common', 'Settings', '0', '0', 'MySQL')
  }
}

/** Default per-connection savepath (`Common/Settings/0/0/MySQL/<conn>`). */
export function connectionSettingsDir(paths: NavicatPaths, connectionName: string): string {
  return join(paths.settingsDir, connectionName)
}

/** Lists `*.nbatmysql` file names in the profiles dir; empty when missing. */
export async function listJobFiles(paths: NavicatPaths): Promise<string[]> {
  try {
    const entries = await readdir(paths.profilesDir, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(JOB_FILE_EXTENSION))
      .map((e) => e.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) // code-point order: locale independent
  } catch {
    return []
  }
}
