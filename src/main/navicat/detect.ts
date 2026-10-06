import { existsSync } from 'node:fs'
import type { NavicatDetection } from '@shared/types'
import { countNb3Files, resolveBackupSourceDir } from './backupsScan'
import { parseConnPlist, readTextFile } from './connPlist'
import { connectionSettingsDir, listJobFiles, navicatPaths } from './paths'

const emptyDetection = (root: string): NavicatDetection => ({
  found: false,
  rootPath: root,
  connPlistPath: null,
  prefPlistPath: null,
  profilesDir: null,
  connectionCount: 0,
  jobCount: 0,
  backupCount: 0
})

/**
 * Inspects a Navicat root without throwing. `found` is true when the root
 * holds a `Common/conn.plist`; counts fall back to zero on unreadable input.
 */
export async function detectNavicat(root: string): Promise<NavicatDetection> {
  const paths = navicatPaths(root)
  if (!root || !existsSync(root) || !existsSync(paths.connPlist)) return emptyDetection(root)

  const detection: NavicatDetection = {
    ...emptyDetection(root),
    found: true,
    connPlistPath: paths.connPlist,
    prefPlistPath: existsSync(paths.prefPlist) ? paths.prefPlist : null,
    profilesDir: existsSync(paths.profilesDir) ? paths.profilesDir : null
  }

  try {
    const connections = await parseConnPlist(await readTextFile(paths.connPlist))
    detection.connectionCount = connections.length
    for (const conn of connections) {
      const dir = await resolveBackupSourceDir(
        conn.savePath,
        connectionSettingsDir(paths, conn.name)
      )
      if (dir) detection.backupCount += await countNb3Files(dir)
    }
  } catch {
    /* unreadable conn.plist: keep zero counts, the preview call reports the real error */
  }
  detection.jobCount = (await listJobFiles(paths)).length
  return detection
}
