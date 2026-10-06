import { getAutomationService } from './automation/index'
import type { AppContext } from './context'
import { getLogger } from './log'

/**
 * Long-lived background services (in-app scheduler, launchd sync...).
 * Feature modules append their start() here.
 */
export async function startBackgroundServices(ctx: AppContext): Promise<void> {
  const log = getLogger('services')
  const automation = getAutomationService(ctx)
  try {
    await automation.start()
  } catch (err) {
    log.error('automation service failed to start', err)
  }

  try {
    // Dynamic + guarded so unit tests can exercise this file without electron.
    const { app } = await import('electron')
    app.on('before-quit', () => {
      automation.stop().catch((err) => log.warn('automation service failed to stop', err))
    })
  } catch {
    /* not running inside electron */
  }
}
