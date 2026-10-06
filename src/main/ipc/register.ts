import type { AppContext } from '../context'
import { registerAiHandlers } from './ai'
import { registerAppHandlers } from './app'
import { registerBackupsHandlers } from './backups'
import { registerConnectionsHandlers } from './connections'
import { registerDbHandlers } from './db'
import { registerFiltersHandlers } from './filters'
import { registerJobsHandlers } from './jobs'
import { registerNavicatHandlers } from './navicat'
import { registerUpdatesHandlers } from './updates'

/**
 * Each feature module owns src/main/ipc/<area>.ts and exports
 * register<Area>Handlers(ctx). Keep this list in sync with IpcInvokeMap.
 */
export function registerAllHandlers(ctx: AppContext): void {
  registerAppHandlers(ctx)
  registerConnectionsHandlers(ctx)
  registerDbHandlers(ctx)
  registerFiltersHandlers(ctx)
  registerBackupsHandlers(ctx)
  registerJobsHandlers(ctx)
  registerNavicatHandlers(ctx)
  registerUpdatesHandlers(ctx)
  registerAiHandlers(ctx)
}
