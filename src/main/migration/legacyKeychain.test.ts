import { describe, expect, it } from 'vitest'
import {
  LEGACY_SAFE_STORAGE_SERVICES,
  readGenericPassword,
  readLegacySafeStoragePassword,
  type KeychainExecFn
} from './legacyKeychain'

const exitError = (code: number | string): Error =>
  Object.assign(new Error('security failed'), { code })

describe('legacy keychain read', () => {
  it('runs security find-generic-password -w, on the given keychain file', async () => {
    const calls: string[][] = []
    const exec: KeychainExecFn = async (file, args) => {
      calls.push([file, ...args])
      return { stdout: 'b64password==\n' }
    }
    const result = await readGenericPassword('Navidog Safe Storage', {
      keychain: '/tmp/x.keychain-db',
      exec
    })
    expect(result).toEqual({ ok: true, password: 'b64password==' })
    expect(calls).toEqual([
      [
        'security',
        'find-generic-password',
        '-s',
        'Navidog Safe Storage',
        '-w',
        '/tmp/x.keychain-db'
      ]
    ])
  })

  it('classifies not found, denial and other failures', async () => {
    const run = (err: Error) => readGenericPassword('s', { exec: async () => Promise.reject(err) })
    expect(await run(exitError(44))).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await run(exitError(128))).toMatchObject({ ok: false, reason: 'denied' })
    expect(await run(exitError(51))).toMatchObject({ ok: false, reason: 'denied' })
    expect(await run(Object.assign(new Error('t'), { killed: true }))).toMatchObject({
      ok: false,
      reason: 'denied'
    })
    expect(await run(exitError('ENOENT'))).toMatchObject({ ok: false, reason: 'failed' })
    // Other failures name the exit code only, never execFile's message (command line, paths).
    const other = Object.assign(new Error('Command failed: security … /Users/x/k.keychain-db'), {
      code: 152
    })
    expect(await run(other)).toEqual({
      ok: false,
      reason: 'failed',
      detail: 'el comando security terminó con el código 152'
    })
  })

  it('tries each legacy service name until one exists, and stops at a denial', async () => {
    const seen: string[] = []
    const notFoundThenOk: KeychainExecFn = async (_f, args) => {
      seen.push(args[2])
      if (args[2] === LEGACY_SAFE_STORAGE_SERVICES[0]) throw exitError(44)
      return { stdout: 'pw\n' }
    }
    expect(await readLegacySafeStoragePassword({ exec: notFoundThenOk })).toEqual({
      ok: true,
      password: 'pw'
    })
    expect(seen).toEqual(LEGACY_SAFE_STORAGE_SERVICES)

    seen.length = 0
    const denied: KeychainExecFn = async (_f, args) => {
      seen.push(args[2])
      throw exitError(128)
    }
    expect(await readLegacySafeStoragePassword({ exec: denied })).toMatchObject({
      reason: 'denied'
    })
    expect(seen).toEqual([LEGACY_SAFE_STORAGE_SERVICES[0]])
  })
})
