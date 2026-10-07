import { shell } from 'electron'
import type { AppContext } from '../context'
import {
  getUpdateInstaller,
  getUpdateService,
  isAllowedReleaseUrl,
  rememberProfileState,
  whatsNewFor
} from '../updates'
import { handle } from './typed'

export function registerUpdatesHandlers(ctx: AppContext): void {
  // Before any write of this start: a profile with data but no seen version was updated.
  rememberProfileState(ctx)
  handle('updates:check', (manual) => getUpdateService(ctx).check(manual === true))
  handle('updates:dismiss', (version) => getUpdateService(ctx).dismiss(version))
  handle('updates:snooze', () => getUpdateService(ctx).snooze())
  handle('updates:whatsNew', () => whatsNewFor(ctx))
  handle('updates:markSeen', (version) => getUpdateService(ctx).markSeen(version))
  handle('updates:installState', () => getUpdateInstaller(ctx).state())
  handle('updates:download', (version) => getUpdateInstaller(ctx).download(String(version)))
  handle('updates:cancelDownload', () => getUpdateInstaller(ctx).cancel())
  handle('updates:install', () => getUpdateInstaller(ctx).install())
  handle('app:openExternal', async (url) => {
    // Only this repository's release pages/downloads: the renderer never opens arbitrary URLs.
    if (!isAllowedReleaseUrl(url))
      throw new Error(
        'Solo se pueden abrir enlaces de las versiones publicadas de Vortaq en GitHub.'
      )
    await shell.openExternal(url)
  })
}
