import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  detectRunMode,
  findCheckout,
  readBranch,
  sourceUpdateCommands,
  type RunModeFs
} from './runMode'

/** In-memory file system: `files` maps absolute paths to contents, `dirs` lists folders. */
function memFs(files: Record<string, string>, dirs: string[] = []): RunModeFs {
  const norm = (p: string) => resolve(p)
  const fileMap = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]))
  const dirSet = new Set(dirs.map(norm))
  return {
    exists: (p) => fileMap.has(norm(p)) || dirSet.has(norm(p)),
    isFile: (p) => fileMap.has(norm(p)),
    readText: (p) => {
      const v = fileMap.get(norm(p))
      if (v === undefined) throw new Error(`ENOENT ${p}`)
      return v
    }
  }
}

const ROOT = resolve('/work/ElectronDB')

describe('detectRunMode', () => {
  it('reports packaged builds without touching the file system', () => {
    const fs: RunModeFs = {
      exists: () => {
        throw new Error('no fs access expected')
      },
      isFile: () => false,
      readText: () => ''
    }
    expect(detectRunMode({ isPackaged: true, appPath: '/x', platform: 'darwin', fs })).toEqual({
      runMode: 'packaged'
    })
  })

  it('finds the checkout above the app path and its branch', () => {
    const fs = memFs({ [join(ROOT, '.git', 'HEAD')]: 'ref: refs/heads/main\n' }, [
      join(ROOT, '.git')
    ])
    const info = detectRunMode({
      isPackaged: false,
      appPath: join(ROOT, 'out', 'main'),
      platform: 'darwin',
      fs
    })
    expect(info.runMode).toBe('source')
    expect(info.source).toEqual({
      dir: ROOT,
      isGit: true,
      branch: 'main',
      commands: [`cd ${ROOT}`, 'git pull', 'npm install', 'npm run dev']
    })
  })

  it('follows the gitdir file of a worktree', () => {
    const gitdir = resolve('/work/main/.git/worktrees/dev')
    const fs = memFs({
      [join(ROOT, '.git')]: `gitdir: ${gitdir}\n`,
      [join(gitdir, 'HEAD')]: 'ref: refs/heads/feature/x\n'
    })
    expect(
      detectRunMode({ isPackaged: false, appPath: ROOT, platform: 'linux', fs }).source
    ).toMatchObject({
      dir: ROOT,
      branch: 'feature/x'
    })
  })

  it('handles a detached HEAD, a broken .git and a folder without git', () => {
    const detached = memFs({ [join(ROOT, '.git', 'HEAD')]: '1a2b3c4d\n' }, [join(ROOT, '.git')])
    expect(readBranch(ROOT, detached)).toBeNull()
    const broken = memFs({ [join(ROOT, '.git')]: 'garbage' })
    expect(readBranch(ROOT, broken)).toBeNull()
    const noHead = memFs({}, [join(ROOT, '.git')])
    expect(readBranch(ROOT, noHead)).toBeNull()

    const none = memFs({})
    expect(findCheckout(ROOT, none)).toBeNull()
    const info = detectRunMode({ isPackaged: false, appPath: ROOT, platform: 'darwin', fs: none })
    expect(info.source).toMatchObject({ dir: ROOT, isGit: false, branch: null })
    expect(info.source?.commands).not.toContain('git pull')
  })
})

describe('sourceUpdateCommands', () => {
  it('quotes folders with spaces for the shell of the OS', () => {
    expect(sourceUpdateCommands('/Users/me/My Apps/ElectronDB', 'darwin')[0]).toBe(
      "cd '/Users/me/My Apps/ElectronDB'"
    )
    expect(sourceUpdateCommands("/tmp/it's", 'linux')[0]).toBe(`cd '/tmp/it'\\''s'`)
    expect(sourceUpdateCommands('C:\\Users\\Me\\My Apps\\ElectronDB', 'win32')[0]).toBe(
      'cd "C:\\Users\\Me\\My Apps\\ElectronDB"'
    )
    expect(sourceUpdateCommands('C:\\src\\ElectronDB', 'win32')[0]).toBe('cd C:\\src\\ElectronDB')
  })
})
