import type { MenuItemConstructorOptions } from 'electron'

/**
 * Application menu template. Electron's default macOS menu binds Cmd+W to
 * "Close Window" and Cmd+R to "Reload", which would close or reload the
 * whole window (losing unsaved tabs) before the renderer sees the keys. The
 * renderer owns Cmd+W (close tab, with its dirty guard) and Cmd+R (run query),
 * so this menu keeps the standard roles but moves those accelerators.
 * Pure function (no electron runtime import) so it can be unit tested.
 */
export function buildAppMenuTemplate(options: {
  appName: string
  dev: boolean
}): MenuItemConstructorOptions[] {
  const view: MenuItemConstructorOptions[] = [
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' }
  ]
  if (options.dev) {
    view.push(
      { type: 'separator' },
      { role: 'reload', accelerator: 'Shift+CmdOrCtrl+Alt+R' },
      { role: 'toggleDevTools', accelerator: 'Alt+CmdOrCtrl+I' }
    )
  }
  return [
    {
      label: options.appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edición',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' }
      ]
    },
    { label: 'Ver', submenu: view },
    {
      label: 'Ventana',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        // Cmd+W belongs to the renderer (close the active tab).
        { role: 'close', accelerator: 'Shift+CmdOrCtrl+W' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ]
}

/** Accelerators that must never be bound by the app menu (owned by the renderer). */
export const RENDERER_ACCELERATORS = ['CmdOrCtrl+W', 'CmdOrCtrl+R', 'Cmd+W', 'Cmd+R'] as const
