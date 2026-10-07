/**
 * Product identity. The app was called "Navidog" and then "ElectronDB" before
 * it became Vortaq; the LEGACY_* values exist only to find and migrate data
 * written under those names (profile folders, keychain items, launchd labels,
 * env switches). Newest first: an ElectronDB profile wins over a Navidog one.
 */
export const APP_NAME = 'Vortaq'
export const LOG_FILE_NAME = 'vortaq.log'

export interface LegacyApp {
  /** app.getName() of that release: profile folder and "<name> Safe Storage" keychain item. */
  name: string
  /** Label prefix of its launchd agents. */
  launchAgentPrefix: string
}

export const LEGACY_ELECTRONDB: LegacyApp = {
  name: 'ElectronDB',
  launchAgentPrefix: 'dev.y0rshb3.electrondb.job.'
}
export const LEGACY_NAVIDOG: LegacyApp = {
  name: 'Navidog',
  launchAgentPrefix: 'dev.y0rshb3.navidog.job.'
}
/** Earlier product names, newest first. */
export const LEGACY_APPS: readonly LegacyApp[] = [LEGACY_ELECTRONDB, LEGACY_NAVIDOG]

/**
 * GitHub repository whose Releases are checked for new versions
 * (src/main/updates) and that electron-builder's `publish` points at. It keeps
 * the ElectronDB name until the repository itself is renamed; GitHub
 * redirects the old name afterwards, so installed copies keep finding updates.
 */
export const UPDATE_REPO = { owner: 'Y0rshB3', name: 'ElectronDB' } as const
