import { shell } from 'electron'
import type { AppContext } from '../context'
import { getUpdateService, isAllowedReleaseUrl } from '../updates'
import { handle } from './typed'

export function registerUpdatesHandlers(ctx: AppContext): void {
  handle('updates:check', (manual) => getUpdateService(ctx).check(manual === true))
  handle('updates:dismiss', (version) => getUpdateService(ctx).dismiss(version))
  handle('app:openExternal', async (url) => {
    // Only this repository's release pages/downloads: the renderer never opens arbitrary URLs.
    if (!isAllowedReleaseUrl(url))
      throw new Error(
        'Solo se pueden abrir enlaces de las versiones publicadas de ElectronDB en GitHub.'
      )
    await shell.openExternal(url)
  })
}
