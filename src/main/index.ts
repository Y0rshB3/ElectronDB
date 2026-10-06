import { app, BrowserWindow, Menu } from 'electron'
import { applyProfilePath, configureFileLog, createContext, readEnvSwitches } from './bootstrap'
import { APP_NAME } from './brand'
import { getLogger } from './log'
import { registerAllHandlers } from './ipc/register'
import { buildAppMenuTemplate } from './menu'
import { createMainWindow, watchSmoke } from './window'
import { runProfileMigration, runSecretMigration } from './migration'
import {
  SCREENSHOT_QUERY,
  SCREENSHOT_WINDOW,
  screenshotDirFromEnv,
  watchScreenshots
} from './screenshots'

/**
 * CLI: `ElectronDB --run-job=<jobId>` executes one job headless and exits.
 * Used by launchd agents created by the scheduler.
 */
function parseRunJobArg(argv: string[]): string | null {
  for (const a of argv) {
    const m = /^--run-job=(.+)$/.exec(a)
    if (m) return m[1]
  }
  return null
}

const runJobId = parseRunJobArg(process.argv)
const switches = readEnvSwitches()
// The screenshot harness drives the UI, so it is only allowed on a scratch profile.
const screenshotDir = screenshotDirFromEnv()
if (screenshotDir && !switches.userDataPath) {
  console.error('ELECTRONDB_SCREENSHOTS requires ELECTRONDB_USER_DATA (a scratch profile).')
  process.exit(1)
}

app.setName(APP_NAME)
// Before 'ready': Chromium storage must also follow the alternative profile.
const userDataPath = applyProfilePath(switches)
configureFileLog(userDataPath)
// First start after the Navidog -> ElectronDB rename: copy the old profile
// (also before 'ready', so Chromium sees the copied Local Storage).
runProfileMigration({
  appData: app.getPath('appData'),
  userData: userDataPath,
  userDataOverride: switches.userDataPath,
  legacyUserDataOverride: switches.legacyUserDataPath
})

app.whenReady().then(async () => {
  const log = getLogger('main')
  const ctx = createContext({ headless: runJobId !== null })
  // Secrets copied from the old profile are re-encrypted before anything reads
  // them. Headless runs leave it to the next interactive start: macOS may ask
  // for keychain access and nobody would be there to answer.
  if (!runJobId) await runSecretMigration(ctx, { keychain: switches.legacyKeychain })
  registerAllHandlers(ctx)

  if (runJobId) {
    try {
      const { runJobHeadless } = await import('./automation/headless')
      const code = await runJobHeadless(ctx, runJobId)
      app.exit(code)
    } catch (err) {
      log.error('headless run failed', err)
      app.exit(1)
    }
    return
  }

  Menu.setApplicationMenu(
    Menu.buildFromTemplate(buildAppMenuTemplate({ appName: app.name, dev: !app.isPackaged }))
  )

  const { startBackgroundServices } = await import('./services')
  await startBackgroundServices(ctx)

  // Like Navicat: connections stay open until the user disconnects them or quits.
  // On quit, close every pool and SSH tunnel cleanly (bounded so quitting never hangs).
  const { getConnectionManager } = await import('./mysql/manager')
  let closingConnections = false
  app.on('before-quit', (event) => {
    if (closingConnections) return
    closingConnections = true
    event.preventDefault()
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000))
    Promise.race([getConnectionManager(ctx).closeAll(), timeout])
      .catch((err) => log.warn('closing connections on quit failed', err))
      .finally(() => app.quit())
  })

  const theme = (): 'dark' | 'light' => ctx.settings.get().theme
  const win = screenshotDir
    ? createMainWindow({
        ...SCREENSHOT_WINDOW,
        query: SCREENSHOT_QUERY,
        showInactive: true,
        theme: theme()
      })
    : createMainWindow({ theme: theme() })
  if (screenshotDir) watchScreenshots(win, screenshotDir)
  else if (switches.smoke) watchSmoke(win)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow({ theme: theme() })
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
