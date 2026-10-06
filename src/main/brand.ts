/**
 * Product identity. The app was called "Navidog" before it became ElectronDB;
 * the LEGACY_* values exist only to find and migrate data written under the
 * old name (profile folder, keychain item, launchd labels, env switches).
 */
export const APP_NAME = 'ElectronDB'
export const LOG_FILE_NAME = 'electrondb.log'

export const LEGACY_APP_NAME = 'Navidog'

/** GitHub repository whose Releases are checked for new versions (src/main/updates). */
export const UPDATE_REPO = { owner: 'Y0rshB3', name: 'ElectronDB' } as const
