import { describe, expect, it } from 'vitest'
import {
  clock,
  describeObjectCounts,
  formatCount,
  formatElapsed,
  formatSize,
  INTERRUPTED_MESSAGE,
  objectLine,
  parseLogLine,
  parseRunLog,
  resultLine,
  SKIPPED_MESSAGE,
  splitLogText,
  stampLine,
  stepHeading,
  structureOnlySummary,
  summaryLines
} from './jobLog'

describe('job log formatting', () => {
  it('formats numbers, sizes, durations and clock times in Spanish', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(1234)).toBe('1.234')
    expect(formatCount(1_000_000)).toBe('1.000.000')
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1536)).toBe('1,5 KB')
    expect(formatSize(45.2 * 1024 * 1024)).toBe('45,2 MB')
    expect(formatSize(300 * 1024 * 1024)).toBe('300 MB')
    expect(formatElapsed(850)).toBe('850 ms')
    expect(formatElapsed(12_345)).toBe('12,3 s')
    expect(formatElapsed(125_000)).toBe('2 min 05 s')
    expect(formatElapsed(3_720_000)).toBe('1 h 02 min')
    expect(clock(new Date(2026, 0, 1, 7, 5, 9))).toBe('07:05:09')
    expect(stampLine(new Date(2026, 0, 1, 17, 38, 14), 'a\nb')).toBe('[17:38:14] a b')
  })

  it('aligns object lines and keeps errors on one line', () => {
    const table = objectLine({ type: 'Table', name: 'user', count: 1234, status: 'ok' })
    const view = objectLine({ type: 'View', name: 'v_people', count: null, status: 'ok' })
    const failed = objectLine({
      type: 'Table',
      name: 'orders',
      count: null,
      status: 'error',
      error: 'Lost\nconnection'
    })
    expect(table).toMatch(/^ {2}Tabla user \.+ +1\.234 filas {2}OK$/)
    expect(view).toMatch(/^ {2}Vista v_people \.+ +OK$/)
    expect(table.length).toBe(view.length)
    expect(failed).toMatch(/ERROR: Lost connection$/)
    expect(failed.indexOf('ERROR')).toBe(table.indexOf('OK'))
    // Very long names still get separating dots.
    expect(objectLine({ type: 'Table', name: 'x'.repeat(80), count: 1, status: 'ok' })).toMatch(
      /x \.\.\. +1 fila {2}OK$/
    )
  })

  it('describes object counts and headings', () => {
    expect(describeObjectCounts(['Table', 'Table', 'View', 'Event'])).toBe(
      '4 objetos (2 tablas, 1 vista, 1 evento)'
    )
    expect(describeObjectCounts([])).toBe('0 objetos')
    expect(
      stepHeading(3, 15, {
        type: 'backupschema',
        schema: 'accounts',
        connectionName: 'Local',
        referenceName: 'x'
      })
    ).toBe('Paso 3/15 · Base de datos accounts (Local)')
    expect(resultLine('ERROR', ['multi\nline', '', '1,0 s'])).toBe(
      '  Resultado: ERROR · multi line · 1,0 s'
    )
  })
})

describe('job log summary', () => {
  const step = (
    index: number,
    status: 'success' | 'failed' | 'cancelled',
    message: string | null
  ) => ({
    index,
    label: `Base de datos db${index} (Local)`,
    status,
    message
  })

  it('all steps OK', () => {
    expect(
      summaryLines({
        status: 'success',
        durationMs: 4200,
        steps: [step(1, 'success', null), step(2, 'success', null)]
      })
    ).toEqual([
      'Resumen',
      '  Pasos: 2 · Correctos: 2 · Con error: 0 · Cancelados: 0 · Omitidos: 0',
      '  Duración total: 4,2 s',
      'Finalizado correctamente: 2 de 2 pasos OK.'
    ])
  })

  it('some steps failed (continueOnError) and skipped ones', () => {
    const lines = summaryLines({
      status: 'failed',
      durationMs: 61_000,
      steps: [
        step(1, 'success', null),
        step(2, 'failed', "Unknown database 'db2'"),
        step(3, 'cancelled', SKIPPED_MESSAGE)
      ]
    })
    expect(lines).toEqual([
      'Resumen',
      '  Pasos: 3 · Correctos: 1 · Con error: 1 · Cancelados: 0 · Omitidos: 1',
      "  ERROR · Paso 2/3 · Base de datos db2 (Local): Unknown database 'db2'",
      '  Duración total: 1 min 01 s',
      'Finalizado con errores: 1 de 3 pasos con error.'
    ])
  })

  it('cancelled run', () => {
    const lines = summaryLines({
      status: 'cancelled',
      durationMs: 900,
      steps: [step(1, 'success', null), step(2, 'cancelled', 'Ejecución cancelada.')]
    })
    expect(lines[1]).toBe('  Pasos: 2 · Correctos: 1 · Con error: 0 · Cancelados: 1 · Omitidos: 0')
    expect(lines.at(-1)).toBe('Ejecución cancelada: 1 de 2 pasos completados.')
  })

  it('interrupted run (the app died mid-run) ends with its own red final line', () => {
    const lines = summaryLines({
      status: 'failed',
      durationMs: 5000,
      interrupted: true,
      steps: [step(1, 'success', null), step(2, 'failed', INTERRUPTED_MESSAGE)]
    })
    expect(lines.at(-1)).toBe('Ejecución interrumpida: 1 de 2 pasos completados.')
    const parsed = parseRunLog(lines.map((l) => `[10:00:00] ${l}`))
    expect(parsed.at(-1)).toMatchObject({ kind: 'final', tone: 'error', inSummary: true })
  })
})

describe('job log parser', () => {
  const log = [
    '[17:38:10] Inicio de «Diario» · 05/10/2026 · manual · 2 pasos',
    '[17:38:10] Paso 1/2 · Base de datos accounts (Local)',
    '[17:38:11]   Encontrados 2 objetos (2 tablas)',
    `[17:38:12] ${objectLine({ type: 'Table', name: 'user', count: 12, status: 'ok' })}`,
    `[17:38:13] ${objectLine({ type: 'Table', name: 'bad', count: null, status: 'error', error: 'boom' })}`,
    '[17:38:13]   Resultado: ERROR · boom · 3,0 s',
    '[17:38:14] Resumen',
    '[17:38:14]   Pasos: 2 · Correctos: 1 · Con error: 1 · Cancelados: 0 · Omitidos: 0',
    '[17:38:14]   ERROR · Paso 1/2 · Base de datos accounts (Local): boom',
    '[17:38:14] Finalizado con errores: 1 de 2 pasos con error.',
    ''
  ]

  it('classifies headings, object statuses, results and the summary', () => {
    const parsed = parseRunLog(log)
    expect(parsed).toHaveLength(10)
    expect(parsed.map((p) => p.kind)).toEqual([
      'title',
      'heading',
      'line',
      'line',
      'line',
      'result',
      'summary',
      'summary',
      'summary',
      'final'
    ])
    expect(parsed[0].time).toBe('17:38:10')
    expect(parsed[3]).toMatchObject({ token: 'OK', tone: 'ok', rest: '' })
    expect(parsed[3].text).toMatch(/^ {2}Tabla user \.+ +12 filas {2}$/)
    expect(parsed[4]).toMatchObject({ token: 'ERROR', tone: 'error', rest: ': boom' })
    expect(parsed[5]).toMatchObject({ text: '  Resultado: ', token: 'ERROR', tone: 'error' })
    expect(parsed[8]).toMatchObject({ token: 'ERROR', tone: 'error', inSummary: true })
    expect(parsed[9]).toMatchObject({ kind: 'final', tone: 'error', inSummary: true })
    expect(parsed.slice(0, 6).every((p) => !p.inSummary)).toBe(true)
  })

  it('handles legacy ISO lines and plain text', () => {
    const legacy = parseLogLine('2026-10-05T15:38:10.000Z task "x" failed: disk full')
    expect(legacy.time).toMatch(/^\d{2}:38:10$/)
    expect(legacy.tone).toBe('error')
    expect(
      parseLogLine('2026-10-05T15:38:10.000Z run r finished with status success')
    ).toMatchObject({ kind: 'final', tone: 'ok' })
    expect(parseLogLine('Sin registro')).toMatchObject({ time: null, text: 'Sin registro' })
    expect(splitLogText('a\nb\n')).toEqual(['a', 'b'])
  })

  it('names «Solo estructura» restores in the heading, the result and the summary', () => {
    expect(structureOnlySummary(7)).toBe('Solo estructura: 7 objetos, 0 filas')
    expect(structureOnlySummary(1)).toBe('Solo estructura: 1 objeto, 0 filas')
    const step = {
      type: 'restoreschema',
      schema: 'auth',
      connectionName: 'Local',
      referenceName: '',
      sourceSchema: 'auth',
      sourceConnectionName: 'Staging',
      structureOnly: true
    }
    expect(stepHeading(1, 1, step)).toBe(
      'Paso 1/1 · Base de datos auth: Staging -> Local (solo estructura)'
    )
    const lines = summaryLines({
      status: 'success',
      durationMs: 10,
      steps: [
        {
          index: 1,
          label: 'Base de datos auth',
          status: 'success',
          message: null,
          note: structureOnlySummary(3)
        }
      ]
    })
    expect(lines).toContain('  Paso 1/1 · Base de datos auth: Solo estructura: 3 objetos, 0 filas')
  })
})
