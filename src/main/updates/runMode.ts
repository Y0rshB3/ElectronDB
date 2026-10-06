import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { SourceUpdateInfo, UpdateRunMode } from '@shared/types'

/**
 * Detects how this copy runs. Installer builds are `app.isPackaged`; anything
 * else runs from a folder (`npm run dev`, `npx electron .`). For a folder the
 * git checkout is found by looking for a `.git` entry in the app path or its
 * parents, and the branch is read from HEAD. Read-only: no git command runs.
 * File access is injected so it is unit tested without electron.
 */

export interface RunModeFs {
  exists(path: string): boolean
  isFile(path: string): boolean
  readText(path: string): string
}

export interface RunModeInfo {
  runMode: UpdateRunMode
  /** Only in source mode. */
  source?: SourceUpdateInfo
}

/** Folders checked upwards from the app path (enough for out/main inside a checkout). */
const MAX_PARENTS = 6

/** Folder holding `.git`, or null. */
export function findCheckout(appPath: string, fs: RunModeFs): string | null {
  let dir = resolve(appPath)
  for (let i = 0; i <= MAX_PARENTS; i++) {
    if (fs.exists(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Branch of the checkout from HEAD. `.git` may be a folder or, in a worktree
 * or submodule, a file with `gitdir: <path>`. Null when detached or unreadable.
 */
export function readBranch(checkout: string, fs: RunModeFs): string | null {
  try {
    let gitDir = join(checkout, '.git')
    if (fs.isFile(gitDir)) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readText(gitDir))
      if (!m) return null
      const target = m[1].trim()
      gitDir = isAbsolute(target) ? target : resolve(checkout, target)
    }
    const head = fs.readText(join(gitDir, 'HEAD')).trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return ref ? ref[1].trim() || null : null
  } catch {
    return null
  }
}

/** Quotes a path for a POSIX shell or PowerShell when it needs it. */
function quotePath(path: string, platform: string): string {
  if (/^[\w./:\\-]+$/.test(path)) return path
  return platform === 'win32' ? `"${path.replace(/"/g, '`"')}"` : `'${path.replace(/'/g, `'\\''`)}'`
}

/**
 * Commands that update a checkout: pull, install dependencies (harmless when
 * package-lock.json did not change), restart the dev app. Without git the pull
 * is left out: the UI tells the user to download the new code instead.
 */
export function sourceUpdateCommands(dir: string, platform: string, isGit = true): string[] {
  return [
    `cd ${quotePath(dir, platform)}`,
    ...(isGit ? ['git pull'] : []),
    'npm install',
    'npm run dev'
  ]
}

export function detectRunMode(options: {
  isPackaged: boolean
  appPath: string
  platform: string
  fs: RunModeFs
}): RunModeInfo {
  if (options.isPackaged) return { runMode: 'packaged' }
  const checkout = findCheckout(options.appPath, options.fs)
  const dir = checkout ?? resolve(options.appPath)
  return {
    runMode: 'source',
    source: {
      dir,
      isGit: checkout !== null,
      branch: checkout ? readBranch(checkout, options.fs) : null,
      commands: sourceUpdateCommands(dir, options.platform, checkout !== null)
    }
  }
}
