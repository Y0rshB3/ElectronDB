import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { JobRun, ProgressEvent } from '@shared/types'
import { installBridge, type MockBridge } from '@renderer/__tests__/shellTestUtils'
import { jobOutcome, useProgressStore } from './progress'
import { describeProgress } from './progressText'

function jobEvent(overrides: Partial<ProgressEvent> = {}): ProgressEvent {
  return {
    operationId: 'run-1',
    kind: 'job',
    phase: 'Datos',
    current: 1,
    total: 3,
    message: 'Exportando users',
    done: false,
    ...overrides
  }
}

function run(status: JobRun['status']): JobRun {
  return {
    id: 'run-1',
    jobId: 'job-1',
    jobName: 'Copia nocturna',
    status,
    trigger: 'manual',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: status === 'running' ? null : '2026-01-01T00:01:00.000Z',
    tasks: [],
    logPath: '/tmp/run.log'
  }
}

describe('progress store', () => {
  let bridge: MockBridge

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    bridge = installBridge({ 'jobs:cancel': undefined, 'backups:cancel': undefined })
  })

  afterEach(() => vi.useRealTimers())

  it('cancels job operations through jobs:cancel with the run id', async () => {
    const progress = useProgressStore()
    progress.apply(jobEvent())
    await progress.cancel('run-1')
    expect(bridge.invoke).toHaveBeenCalledWith('jobs:cancel', 'run-1')
    expect(bridge.invoke).not.toHaveBeenCalledWith('backups:cancel', expect.anything())
  })

  it('finishes a job entry when event:jobRun reports a final status', () => {
    const progress = useProgressStore()
    const off = progress.listen()
    bridge.emit('event:progress', jobEvent())
    expect(progress.active).toHaveLength(1)
    expect(progress.latestMessage).toContain('Exportando users')

    bridge.emit('event:jobRun', run('running'))
    expect(progress.active).toHaveLength(1)

    bridge.emit('event:jobRun', run('cancelled'))
    expect(progress.active).toHaveLength(0)
    expect(progress.latestMessage).toBe('')
    expect(progress.operations['run-1'].done).toBe(true)
    expect(progress.operations['run-1'].message).toContain('Tarea cancelada')

    vi.advanceTimersByTime(5000)
    expect(progress.operations['run-1']).toBeUndefined()
    off()
  })

  it('marks failed runs as errors and ignores late progress events', () => {
    const progress = useProgressStore()
    progress.listen()
    bridge.emit('event:progress', jobEvent())
    bridge.emit('event:jobRun', run('failed'))
    expect(progress.operations['run-1'].error).toBeTruthy()

    bridge.emit('event:progress', jobEvent({ current: 2 }))
    expect(progress.active).toHaveLength(0)
  })

  it('reports a continueOnError run with some failed steps as finished with errors, not failed', () => {
    const progress = useProgressStore()
    progress.listen()
    bridge.emit('event:progress', jobEvent({ detail: { jobName: 'Backup con errores' } }))
    const task = (status: JobRun['status']) => ({
      taskId: status,
      referenceName: status,
      status,
      startedAt: null,
      finishedAt: null,
      message: null,
      outputPath: null
    })
    bridge.emit('event:jobRun', {
      ...run('failed'),
      tasks: [task('success'), task('success'), task('failed'), task('success')]
    })
    const op = progress.operations['run-1']
    expect(op).toMatchObject({ done: true, phase: 'partial', tone: 'warning' })
    expect(op.error).toBeUndefined()
    expect(op.message).toBe('1 de 4 pasos con error · 3 correctos')
    expect(describeProgress(op)).toMatchObject({
      subtitle: 'Finalizado con errores',
      message: '1 de 4 pasos con error · 3 correctos',
      percent: 100
    })
    // It leaves on its own, sooner than a hard failure.
    vi.advanceTimersByTime(8000)
    expect(progress.operations['run-1']).toBeUndefined()
  })

  it('keeps a red failure when no step succeeded, with the step counts', () => {
    const failed = {
      ...run('failed'),
      tasks: [
        {
          taskId: 't',
          referenceName: 't',
          status: 'failed' as const,
          startedAt: null,
          finishedAt: null,
          message: 'x',
          outputPath: null
        }
      ]
    }
    expect(jobOutcome(failed)).toEqual({
      phase: 'failed',
      message: 'La tarea ha fallado · 1 de 1 paso con error',
      error: 'La tarea ha fallado · 1 de 1 paso con error'
    })
    expect(jobOutcome({ ...failed, status: 'success', tasks: [] }).message).toBe('Tarea finalizada')
  })
})
