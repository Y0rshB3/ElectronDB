import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import type { AppSettings } from '@shared/types'
import { windowChromeOptions, windowIconPath } from './windowOptions'

export interface MainWindowOptions {
  width?: number
  height?: number
  /** Extra query parameters for the renderer URL (screenshot harness only). */
  query?: Record<string, string>
  /** Show without stealing focus (screenshot harness). */
  showInactive?: boolean
  /** Colours of the Windows/Linux window-controls overlay (follows the app theme). */
  theme?: AppSettings['theme']
}

export function createMainWindow(options: MainWindowOptions = {}): BrowserWindow {
  const icon = windowIconPath({
    platform: process.platform,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath()
  })
  const win = new BrowserWindow({
    width: options.width ?? 1440,
    height: options.height ?? 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'ElectronDB',
    ...windowChromeOptions({ platform: process.platform, theme: options.theme ?? 'dark' }),
    ...(icon ? { icon } : {}),
    backgroundColor: '#090c13',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  win.on('ready-to-show', () => (options.showInactive ? win.showInactive() : win.show()))
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const query = options.query ?? {}
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }
  return win
}

/**
 * ELECTRONDB_SMOKE=1: records renderer console warnings/errors and load failures,
 * waits for the renderer to finish loading and mount, prints one
 * `[smoke] {json}` line to stdout and exits (0 = clean, 1 = problems).
 */
export function watchSmoke(win: BrowserWindow, settleMs = 4000): void {
  const problems: string[] = []
  const contents = win.webContents
  const short = (text: string): string => (text.length > 300 ? `${text.slice(0, 300)}…` : text)
  const finish = (result: Record<string, unknown>): void => {
    const ipc = (result.ipc ?? {}) as Record<string, string>
    for (const [channel, status] of Object.entries(ipc))
      if (status !== 'ok') problems.push(`ipc ${channel}: ${short(status)}`)
    const ok = problems.length === 0 && result.mounted === true && result.bridge === true
    console.log(`[smoke] ${JSON.stringify({ ok, ...result, problems })}`)
    app.exit(ok ? 0 : 1)
  }

  contents.on('console-message', (event) => {
    const { level, message } = event as unknown as { level: string; message: string }
    if (level === 'warning' || level === 'error')
      problems.push(`console.${level}: ${short(message)}`)
  })
  contents.on('preload-error', (_e, path, error) =>
    problems.push(`preload-error ${path}: ${short(error.message)}`)
  )
  contents.on('did-fail-load', (_e, code, description, url) =>
    problems.push(`did-fail-load ${code} ${description} ${url}`)
  )
  contents.on('render-process-gone', (_e, details) =>
    problems.push(`render-process-gone ${details.reason}`)
  )
  contents.once('did-finish-load', () => {
    setTimeout(() => {
      contents
        .executeJavaScript(
          `(async () => {
            const ipc = {}
            for (const channel of ['app:info', 'app:startupNotices', 'settings:get', 'connections:list', 'jobs:list', 'jobs:runs', 'updates:check', 'ai:providers']) {
              try { await window.electronDB.invoke(channel); ipc[channel] = 'ok' } catch (e) { ipc[channel] = String(e && e.message) }
            }
            return { mounted: (document.querySelector('#app')?.children.length ?? 0) > 0, bridge: typeof window.electronDB?.invoke === 'function', title: document.title, ipc }
          })()`
        )
        .then((info: Record<string, unknown>) => finish(info))
        .catch((err: Error) => {
          problems.push(`executeJavaScript: ${short(err.message)}`)
          finish({ mounted: false, bridge: false })
        })
    }, settleMs)
  })
  // Never hang a CI/smoke run.
  setTimeout(() => {
    problems.push('timeout: the renderer did not finish loading')
    finish({ mounted: false, bridge: false })
  }, 60_000).unref()
}
