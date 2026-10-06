import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'node:path'
import { LOG_FILE_NAME } from '../brand'
import type { AppContext } from '../context'
import { dismissStartupNotice, startupNotices } from '../migration'
import { dismissRaisedNotice, raisedNotices } from '../notices'
import { titleBarOverlayFor, usesTitleBarOverlay } from '../windowOptions'
import { handle } from './typed'

export function registerAppHandlers(ctx: AppContext): void {
  handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? 'n/a',
    node: process.versions.node,
    platform: process.platform,
    userDataPath: ctx.userDataPath,
    logPath: join(ctx.logDir, LOG_FILE_NAME)
  }))
  handle('app:openPath', async (path) => {
    const err = await shell.openPath(path)
    if (err) throw new Error(err)
  })
  handle('app:showInFolder', (path) => shell.showItemInFolder(path))
  handle('app:pickDirectory', async (title) => {
    const res = await dialog.showOpenDialog({
      title,
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  handle('app:pickFile', async (title, filters) => {
    const res = await dialog.showOpenDialog({ title, properties: ['openFile'], filters })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  handle('app:startupNotices', () => [
    ...startupNotices(ctx.userDataPath),
    ...raisedNotices(ctx.userDataPath)
  ])
  handle('app:dismissStartupNotice', (id) => {
    dismissStartupNotice(ctx.userDataPath, id)
    dismissRaisedNotice(ctx.userDataPath, id)
  })
  handle('settings:get', () => ctx.settings.get())
  handle('settings:update', (patch) => {
    const settings = ctx.settings.update(patch)
    // Windows/Linux: keep the native window controls in the theme's colours.
    if (patch?.theme && usesTitleBarOverlay(process.platform)) {
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          win.setTitleBarOverlay(titleBarOverlayFor(settings.theme))
        } catch {
          /* window without an overlay: nothing to recolour */
        }
      }
    }
    return settings
  })
}
