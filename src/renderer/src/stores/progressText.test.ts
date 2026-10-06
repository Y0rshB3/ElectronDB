import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ProgressEvent } from '@shared/types'
import { installBridge } from '@renderer/__tests__/shellTestUtils'
import { useProgressStore } from './progress'
import { describeProgress, progressStatusText } from './progressText'

function event(overrides: Partial<ProgressEvent> = {}): ProgressEvent {
  return {
    operationId: 'run-1',
    kind: 'job',
    phase: 'rows',
    current: 0,
    total: 4,
    message: 'Respaldando tabla user: 123456 filas',
    done: false,
    ...overrides
  }
}

const jobDetail = {
  jobName: 'Backup Local',
  step: 3,
  steps: 15,
  stepLabel: 'accounts',
  objectType: 'Table',
  objectName: 'user',
  objectIndex: 12,
  objects: 85,
  objectsDone: 11,
  rows: 123456
}

describe('progress text', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('shows the step and the object inside it for automation runs', () => {
    const view = describeProgress(event({ detail: jobDetail }))
    expect(view.subtitle).toBe('Paso 3/15 · accounts')
    expect(view.message).toBe('Tabla user (12/85) · 123.456 filas')
    expect(view.counter).toBe('Paso 3/15 · 11/85 objetos')
    // Two steps done plus 11/85 of the third one.
    expect(view.percent).toBe(Math.round(((2 + 11 / 85) / 15) * 100))
    expect(view.subtitle).not.toBe('rows')
    expect(view.counter).not.toBe('0 / 4')
  })

  it('shows a starting step and SQL statements', () => {
    expect(
      describeProgress(event({ phase: 'step', detail: { step: 1, steps: 2, stepLabel: 'Purga' } }))
    ).toMatchObject({ subtitle: 'Paso 1/2 · Purga', message: 'Iniciando…', percent: 0 })
    expect(
      describeProgress(
        event({
          phase: 'object',
          detail: { step: 2, steps: 2, objectType: 'Statement', objectName: '1/3', objects: 3 }
        })
      )
    ).toMatchObject({ message: 'Sentencia 1/3', percent: 50 })
  })

  it('shows objects done / total objects for a single backup', () => {
    const view = describeProgress(
      event({
        kind: 'backup',
        phase: 'objectDone',
        detail: {
          objectType: 'View',
          objectName: 'v_x',
          objectIndex: 2,
          objects: 8,
          objectsDone: 2
        }
      })
    )
    expect(view).toMatchObject({
      subtitle: '2/8 objetos',
      message: 'Vista v_x (2/8)',
      percent: 25,
      counter: '2/8 objetos'
    })
  })

  it('moves the bar inside a large table using the estimated rows', () => {
    // Step 2/4, one 1M-row table (weight 1001) among 3 one-unit objects; 300.000 rows written.
    const detail = {
      step: 2,
      steps: 4,
      stepLabel: 'big',
      objectType: 'Table' as const,
      objectName: 'events',
      objectIndex: 2,
      objects: 4,
      objectsDone: 1,
      rows: 300_000,
      rowsEstimate: 1_000_000,
      workTotal: 1004,
      workDone: 1 + 1001 * 0.3
    }
    const early = describeProgress(event({ detail }))
    expect(early.message).toBe('Tabla events (2/4) · 300.000 de ~1.000.000 filas')
    const later = describeProgress(
      event({ detail: { ...detail, rows: 900_000, workDone: 1 + 1001 * 0.9 } })
    )
    // The bar advances while the same table is still being written (it was frozen before).
    expect(later.percent!).toBeGreaterThan(early.percent!)
    expect(early.percent).toBe(Math.round(((1 + (1 + 1001 * 0.3) / 1004) / 4) * 100))
    expect(later.percent).toBe(Math.round(((1 + (1 + 1001 * 0.9) / 1004) / 4) * 100))
    // Past the (approximate) estimate: plain counter, no "de ~".
    expect(
      describeProgress(event({ detail: { ...detail, rows: 1_200_000, workDone: 992 } })).message
    ).toBe('Tabla events (2/4) · 1.200.000 filas')
    // A single backup uses the same weighted fraction.
    expect(
      describeProgress(
        event({ kind: 'backup', detail: { ...detail, step: undefined, steps: undefined } })
      ).percent
    ).toBe(Math.round(((1 + 1001 * 0.3) / 1004) * 100))
  })

  it('keeps the plain text for events without detail and for finished ones', () => {
    expect(describeProgress(event({ kind: 'restore', phase: 'object', current: 1 }))).toMatchObject(
      {
        subtitle: 'Objetos',
        percent: 25,
        counter: '1 / 4'
      }
    )
    expect(
      describeProgress(event({ detail: jobDetail, done: true, message: 'Tarea finalizada' }))
    ).toMatchObject({ message: 'Tarea finalizada', percent: 100 })
  })

  it('builds the status bar text', () => {
    expect(progressStatusText(event({ detail: jobDetail }))).toBe(
      'Backup Local · Paso 3/15 · accounts · Tabla user (12/85) · 123.456 filas'
    )
    expect(progressStatusText(event({ message: 'Exportando', current: 1, total: 3 }))).toBe(
      'Exportando (1/3)'
    )
    installBridge()
    const progress = useProgressStore()
    progress.apply(event({ detail: jobDetail }))
    expect(progress.latestMessage).toContain('Paso 3/15 · accounts')
  })
})
