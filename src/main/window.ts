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
    title: 'Vortaq',
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
 * Renderer-side SQLite check of the smoke run, through the real IPC bridge and
 * the SQLite utility process: create a file in the (scratch) profile, open a
 * connection, run a script, cancel a runaway CTE (must end within a second,
 * killing and reopening the worker) and read again.
 */
const SQLITE_SMOKE = `async () => {
  const out = {}
  try {
    const invoke = window.vortaq.invoke
    const info = await invoke('app:info')
    const sep = info.platform === 'win32' ? '\\\\' : '/'
    const file = info.userDataPath + sep + 'smoke-' + Date.now() + '.db'
    out.version = (await invoke('sqlite:createFile', file)).sqliteVersion
    const conn = await invoke('connections:save', {
      name: 'Smoke SQLite', color: null, environment: 'local', host: '', port: 0, username: '',
      authMode: 'none', savePassword: false, customDatabases: [], initialQueries: '',
      ssh: { enabled: false, host: '', port: 22, username: '', authType: 'password', savePassword: false },
      ssl: { enabled: false, verifyServer: false }, backupDir: '', extraBackupDirs: [],
      engine: 'sqlite',
      sqlite: { filePath: file, readOnly: false, foreignKeys: true, attached: [], busyTimeoutMs: 5000 }
    })
    await invoke('connections:open', conn.id)
    const first = await invoke('db:execute', conn.id, 'CREATE TABLE t (x); INSERT INTO t VALUES (1), (2); SELECT count(*) FROM t', { sessionKey: 'smoke' })
    out.count = first[2] && first[2].resultSet ? first[2].resultSet.rows[0][0] : null
    const running = invoke('db:execute', conn.id, 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c', { sessionKey: 'smoke', executionId: 'smoke-cancel' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const started = performance.now()
    out.cancelled = await invoke('db:cancel', conn.id, 'smoke-cancel')
    const cancelled = await running
    out.cancelMs = Math.round(performance.now() - started)
    out.cancelError = cancelled[0] ? cancelled[0].error : null
    const again = await invoke('db:execute', conn.id, 'SELECT count(*) FROM t', { sessionKey: 'smoke' })
    out.afterCancel = again[0] && again[0].resultSet ? again[0].resultSet.rows[0][0] : null
    await invoke('connections:close', conn.id)
    await invoke('connections:delete', conn.id)
    out.ok = out.count === 2 && out.cancelled === true && out.cancelMs < 1000 && out.afterCancel === 2
  } catch (e) {
    out.error = String(e && e.message)
    out.ok = false
  }
  return out
}`

/**
 * VORTAQ_SMOKE=1: records renderer console warnings/errors and load failures,
 * waits for the renderer to finish loading and mount, runs the SQLite check
 * (SQLITE_SMOKE), prints one
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
    const sqlite = result.sqlite as { ok?: boolean } | undefined
    if (sqlite && sqlite.ok !== true) problems.push(`sqlite: ${short(JSON.stringify(sqlite))}`)
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
              try { await window.vortaq.invoke(channel); ipc[channel] = 'ok' } catch (e) { ipc[channel] = String(e && e.message) }
            }
            return { mounted: (document.querySelector('#app')?.children.length ?? 0) > 0, bridge: typeof window.vortaq?.invoke === 'function', title: document.title, ipc, sqlite: await (${SQLITE_SMOKE})() }
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
