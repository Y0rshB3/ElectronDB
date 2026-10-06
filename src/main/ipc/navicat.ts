import type { AppContext } from '../context'
import { readNavicatJobs } from '../navicat/batchJobs'
import { readNavicatConnections } from '../navicat/connPlist'
import { detectNavicat } from '../navicat/detect'
import { importFromNavicat } from '../navicat/importer'
import { recoverNavicatPasswords } from '../navicat/keychain'
import { getLogger } from '../log'
import { handle } from './typed'

const log = getLogger('ipc.navicat')

/** Handlers for the navicat:* channels. */
export function registerNavicatHandlers(ctx: AppContext): void {
  const resolveRoot = (rootPath?: string | null): string =>
    rootPath?.trim() || ctx.settings.get().navicatRootPath.trim()
  // The default is empty outside macOS: never read relative to the working directory.
  const requireRoot = (rootPath?: string | null): string => {
    const root = resolveRoot(rootPath)
    if (!root)
      throw new Error(
        'Indica la carpeta «Navicat CC» de Navicat para macOS. En Windows o Linux, cópiala desde un Mac y escribe su ruta.'
      )
    return root
  }

  handle('navicat:detect', (rootPath) => detectNavicat(resolveRoot(rootPath)))
  handle('navicat:previewConnections', async (rootPath) => {
    const entries = await readNavicatConnections(requireRoot(rootPath), ctx.connections.list())
    return entries.map((e) => e.preview)
  })
  handle('navicat:previewJobs', async (rootPath) => {
    const warnings: string[] = []
    const previews = await readNavicatJobs(requireRoot(rootPath), ctx.jobs.list(), warnings)
    // the preview contract has no warnings field: skipped files are only logged (names only)
    for (const w of warnings) log.warn(w)
    return previews
  })
  handle('navicat:import', (request, rootPath) =>
    importFromNavicat(ctx, request, requireRoot(rootPath))
  )
  handle('navicat:recoverPasswords', () => recoverNavicatPasswords(ctx))
}
