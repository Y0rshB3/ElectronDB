import { describe, expect, it } from 'vitest'
import { IPC_EVENT_CHANNELS, IPC_INVOKE_CHANNELS } from './ipc'

describe('ipc channel registry', () => {
  it('has unique invoke channel names with a namespace prefix', () => {
    const set = new Set(IPC_INVOKE_CHANNELS)
    expect(set.size).toBe(IPC_INVOKE_CHANNELS.length)
    for (const c of IPC_INVOKE_CHANNELS) expect(c).toMatch(/^[a-z]+:[A-Za-z]+$/)
  })

  it('keeps event channels under the event: namespace', () => {
    for (const c of IPC_EVENT_CHANNELS) expect(c.startsWith('event:')).toBe(true)
  })
})
