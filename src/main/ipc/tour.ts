import { app } from 'electron'
import type { AppContext } from '../context'
import { envVar } from '../env'
import { profileHadData, TourStateService } from '../storage/tourState'
import { handle } from './typed'

/** Handlers for the tour:* channels (welcome tour state in <userData>/tour.json). */
export function registerTourHandlers(ctx: AppContext): void {
  // Snapshot before any write of this start: an existing profile is an upgrade, not a first run.
  const service = new TourStateService({
    dir: ctx.userDataPath,
    currentVersion: app.getVersion(),
    profileHadData: profileHadData(ctx.userDataPath),
    suppressWelcome: envVar('SMOKE') === '1'
  })
  handle('tour:state', () => service.state())
  handle('tour:markWelcomeDone', () => service.markWelcomeDone())
}
