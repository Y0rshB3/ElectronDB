import { readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  NavicatCandidate,
  NavicatCandidateSource,
  NavicatCandidatesResult
} from '@shared/types'
import { parseConnPlist, readTextFile } from './connPlist'
import { detectNavicat } from './detect'
import { navicatPaths } from './paths'

/**
 * Automatic search for Navicat data folders (read-only, no network).
 *
 * macOS: the usual `Navicat CC` folder, the App Store sandbox
 * (`~/Library/Containers/*navicat*`) and the legacy `Navicat` folder of older
 * releases. Windows/Linux have no supported Navicat format today, so only a
 * `Navicat CC` folder copied from a Mac is looked for, at most two levels
 * below the home folder (never a full-disk scan).
 *
 * A folder only counts when its `Common/conn.plist` parses. Nothing is cached
 * and nothing is written into those folders.
 */

export interface CandidateRoot {
  root: string
  source: NavicatCandidateSource
}

export interface CandidateSearchOptions {
  home: string
  platform: NodeJS.Platform
  /** Test switch (scratch profile only): look only at these folders. */
  overrideRoots?: string[]
}

const PREMIUMSOFT = ['Library', 'Application Support', 'PremiumSoft CyberTech']
const COPIED_NAME = 'navicat cc'
/** Folders under the home that never hold a copied Navicat folder and can be huge. */
const SKIPPED_HOME_DIRS = new Set(['library', 'appdata', 'node_modules', 'applications', 'snap'])
/** Upper bound of home sub-folders inspected at depth 2. */
const MAX_HOME_DIRS = 200

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/** Every folder worth inspecting on `platform`, in a stable order. */
export async function candidateRoots(
  home: string,
  platform: NodeJS.Platform
): Promise<CandidateRoot[]> {
  if (!home) return []
  if (platform === 'darwin') {
    const support = join(home, ...PREMIUMSOFT)
    const roots: CandidateRoot[] = [{ root: join(support, 'Navicat CC'), source: 'default' }]
    const containers = join(home, 'Library', 'Containers')
    for (const name of (await listDirs(containers)).sort()) {
      if (!name.toLowerCase().includes('navicat')) continue
      roots.push({
        root: join(containers, name, 'Data', ...PREMIUMSOFT, 'Navicat CC'),
        source: 'appStore'
      })
    }
    roots.push({ root: join(support, 'Navicat'), source: 'legacy' })
    return roots
  }
  // Windows/Linux: a «Navicat CC» folder copied from a Mac, at depth 1 or 2.
  const roots: CandidateRoot[] = []
  const top = (await listDirs(home)).sort()
  for (const name of top) {
    if (name.toLowerCase() === COPIED_NAME) roots.push({ root: join(home, name), source: 'copied' })
  }
  const browsable = top
    .filter((n) => !n.startsWith('.') && !SKIPPED_HOME_DIRS.has(n.toLowerCase()))
    .filter((n) => n.toLowerCase() !== COPIED_NAME)
    .slice(0, MAX_HOME_DIRS)
  for (const name of browsable) {
    for (const child of (await listDirs(join(home, name))).sort()) {
      if (child.toLowerCase() === COPIED_NAME)
        roots.push({ root: join(home, name, child), source: 'copied' })
    }
  }
  return roots
}

/** The candidate when `root` holds a parsable Common/conn.plist, else null. */
export async function inspectCandidate(
  root: string,
  source: NavicatCandidateSource
): Promise<NavicatCandidate | null> {
  const connPlist = navicatPaths(root).connPlist
  let modifiedAt: string | null = null
  try {
    const info = await stat(connPlist)
    if (!info.isFile()) return null
    modifiedAt = info.mtime.toISOString()
    await parseConnPlist(await readTextFile(connPlist))
  } catch {
    return null
  }
  const detection = await detectNavicat(root)
  if (!detection.found) return null
  return {
    rootPath: root,
    source,
    connectionCount: detection.connectionCount,
    jobCount: detection.jobCount,
    backupCount: detection.backupCount,
    modifiedAt
  }
}

/** Most connections first, then the most recently changed conn.plist. */
export function rankCandidates(list: NavicatCandidate[]): NavicatCandidate[] {
  const time = (c: NavicatCandidate): number => (c.modifiedAt ? Date.parse(c.modifiedAt) : 0)
  return [...list].sort((a, b) => b.connectionCount - a.connectionCount || time(b) - time(a))
}

export async function findNavicatCandidates(
  options: CandidateSearchOptions
): Promise<NavicatCandidatesResult> {
  const supportedPlatform = options.platform === 'darwin'
  const roots: CandidateRoot[] = options.overrideRoots?.length
    ? options.overrideRoots.map((root) => ({ root, source: 'default' as const }))
    : await candidateRoots(options.home, options.platform)
  const seen = new Set<string>()
  const found: NavicatCandidate[] = []
  for (const { root, source } of roots) {
    let key = root
    try {
      key = await realpath(root)
    } catch {
      continue // missing folder
    }
    if (seen.has(key)) continue
    seen.add(key)
    const candidate = await inspectCandidate(root, source)
    if (candidate) found.push(candidate)
  }
  return { supportedPlatform, candidates: rankCandidates(found) }
}
