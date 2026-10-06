import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { JOB_LOG_MAX_LINES } from '@shared/jobLog'
import { flush, installBridge, type MockBridge } from '@renderer/__tests__/shellTestUtils'
import { useJobLogsStore } from './jobLogs'

describe('job logs store', () => {
  let bridge: MockBridge
  let fileText: string

  beforeEach(() => {
    setActivePinia(createPinia())
    fileText = ''
    bridge = installBridge({ 'jobs:runLog': () => fileText })
  })

  it('appends live batches and merges the persisted file without duplicates', async () => {
    const logs = useJobLogsStore()
    logs.listen()
    bridge.emit('event:jobLog', { runId: 'r1', seq: 0, lines: ['a', 'b'] })
    expect(logs.get('r1')).toMatchObject({ lines: ['a', 'b'], complete: true })
    // Repeated/overlapping batches are ignored line by line.
    bridge.emit('event:jobLog', { runId: 'r1', seq: 1, lines: ['b', 'c'] })
    expect(logs.get('r1')?.lines).toEqual(['a', 'b', 'c'])

    fileText = 'a\nb\nc\n'
    await logs.load('r1')
    bridge.emit('event:jobLog', { runId: 'r1', seq: 3, lines: ['d'] })
    expect(logs.get('r1')?.lines).toEqual(['a', 'b', 'c', 'd'])
  })

  it('fills the beginning from the file when the panel opens mid-run', async () => {
    const logs = useJobLogsStore()
    logs.listen()
    bridge.emit('event:jobLog', { runId: 'r2', seq: 3, lines: ['l3', 'l4'] })
    expect(logs.get('r2')).toMatchObject({ offset: 3, complete: false })
    fileText = 'l0\nl1\nl2\nl3\n'
    await logs.ensure('r2')
    expect(logs.get('r2')).toMatchObject({
      lines: ['l0', 'l1', 'l2', 'l3', 'l4'],
      offset: 0,
      complete: true
    })
    // A complete buffer is not read again.
    const reads = bridge.invoke.mock.calls.length
    await logs.ensure('r2')
    expect(bridge.invoke.mock.calls.length).toBe(reads)
  })

  it(`keeps at most ${JOB_LOG_MAX_LINES} lines per run`, () => {
    const logs = useJobLogsStore()
    logs.listen()
    const lines = Array.from({ length: JOB_LOG_MAX_LINES + 5 }, (_, i) => `line ${i}`)
    bridge.emit('event:jobLog', { runId: 'r3', seq: 0, lines })
    const buf = logs.get('r3')!
    expect(buf.lines).toHaveLength(JOB_LOG_MAX_LINES)
    expect(buf.offset).toBe(5)
    expect(buf.lines[0]).toBe('line 5')
  })

  it('reports runs without a log file', async () => {
    const logs = useJobLogsStore()
    fileText = 'Sin registro'
    await logs.ensure('r4')
    await flush()
    expect(logs.get('r4')).toMatchObject({ lines: [], missing: true })
  })
})
