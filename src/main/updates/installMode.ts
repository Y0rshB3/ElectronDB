import type { UpdateInstallMode } from '@shared/types'

/**
 * Decides how this copy installs a new version (see UpdateInstallMode).
 * Pure (no electron) so it is unit tested; index.ts passes app.isPackaged and process.env.
 *
 * Never 'auto' or 'mac-dmg' for a copy that runs from a folder (`npm run dev`, `electron .`)
 * or with a scratch profile (ELECTRONDB_USER_DATA: smoke tests, screenshots, manual test runs):
 * those must never download or replace an installed app.
 */
export function detectInstallMode(options: {
  isPackaged: boolean
  platform: string
  env: Record<string, string | undefined>
  isolatedProfile: boolean
}): UpdateInstallMode {
  if (!options.isPackaged) return 'source'
  if (options.isolatedProfile) return 'manual'
  switch (options.platform) {
    case 'darwin':
      return 'mac-dmg'
    case 'win32':
      // The portable .exe (electron-builder sets this variable) cannot be updated in place.
      return options.env.PORTABLE_EXECUTABLE_FILE ? 'manual' : 'auto'
    case 'linux':
      // Only an AppImage can replace itself; a .deb is updated through apt/dpkg by the user.
      return options.env.APPIMAGE ? 'auto' : 'manual'
    default:
      return 'manual'
  }
}
