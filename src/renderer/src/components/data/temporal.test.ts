import { describe, expect, it } from 'vitest'
import {
  daysInMonth,
  monthGrid,
  normalizeTemporal,
  nowParts,
  parseTemporal,
  temporalSpec,
  weekday,
  type TemporalSpec
} from './temporal'

const DATE: TemporalSpec = { kind: 'date', fsp: 0 }
const DATETIME: TemporalSpec = { kind: 'datetime', fsp: 0 }
const DATETIME3: TemporalSpec = { kind: 'datetime', fsp: 3 }
const TIME: TemporalSpec = { kind: 'time', fsp: 0 }
const YEAR: TemporalSpec = { kind: 'year', fsp: 0 }

const norm = (text: string, spec: TemporalSpec) => {
  const r = normalizeTemporal(text, spec)
  return r.ok ? r.text : `ERR ${r.error}`
}

describe('temporalSpec', () => {
  it('maps result and declared types, with fsp from the declaration', () => {
    expect(temporalSpec('DATE')).toEqual({ kind: 'date', fsp: 0 })
    expect(temporalSpec('DATETIME', 'datetime(3)')).toEqual({ kind: 'datetime', fsp: 3 })
    expect(temporalSpec('TIMESTAMP', 'timestamp(6)')).toEqual({ kind: 'datetime', fsp: 6 })
    expect(temporalSpec('TIME', 'time(2)')).toEqual({ kind: 'time', fsp: 2 })
    expect(temporalSpec('YEAR')).toEqual({ kind: 'year', fsp: 0 })
    expect(temporalSpec('VARCHAR')).toBeNull()
    expect(temporalSpec(null, 'datetime')).toEqual({ kind: 'datetime', fsp: 0 })
  })
})

describe('round trip of MySQL literals per type', () => {
  it('DATE', () => {
    expect(norm('2026-09-30', DATE)).toBe('2026-09-30')
    expect(norm('2026-9-3', DATE)).toBe('2026-09-03')
    expect(norm('2024-02-29', DATE)).toBe('2024-02-29')
    expect(norm('2023-02-29', DATE)).toMatch(/^ERR El día/)
    expect(norm('2026-13-01', DATE)).toMatch(/^ERR El mes/)
    expect(norm('2026-09-30 10:00:00', DATE)).toMatch(/^ERR/)
    expect(norm('30/09/2026', DATE)).toMatch(/^ERR Usa el formato/)
  })

  it('DATETIME / TIMESTAMP, with and without fractional seconds', () => {
    expect(norm('2026-09-30 23:45:00', DATETIME)).toBe('2026-09-30 23:45:00')
    expect(norm('2026-09-30T23:45', DATETIME)).toBe('2026-09-30 23:45:00')
    expect(norm('2026-09-30', DATETIME)).toBe('2026-09-30 00:00:00')
    expect(norm('2026-09-30 23:45:00.5', DATETIME3)).toBe('2026-09-30 23:45:00.500')
    expect(norm('2026-09-30 23:45:00.123456', DATETIME3)).toBe('2026-09-30 23:45:00.123')
    // A fraction sent by the server is kept even when the declared fsp is unknown.
    expect(norm('2026-09-30 23:45:00.250', DATETIME)).toBe('2026-09-30 23:45:00.250')
    expect(norm('2026-09-30 24:00:00', DATETIME)).toMatch(/^ERR Las horas/)
    expect(norm('2026-09-30 -01:00:00', DATETIME)).toMatch(/^ERR/)
  })

  it('TIME beyond 24h and negative, like MySQL', () => {
    expect(norm('12:05:09', TIME)).toBe('12:05:09')
    expect(norm('838:59:59', TIME)).toBe('838:59:59')
    expect(norm('-25:00:00', TIME)).toBe('-25:00:00')
    expect(norm('9:5', TIME)).toBe('09:05:00')
    expect(norm('-00:00:00', TIME)).toBe('00:00:00')
    expect(norm('839:00:00', TIME)).toMatch(/^ERR/)
    expect(norm('10:60:00', TIME)).toMatch(/^ERR Los minutos/)
  })

  it('YEAR', () => {
    expect(norm('2026', YEAR)).toBe('2026')
    expect(norm('0000', YEAR)).toBe('0000')
    expect(norm('1900', YEAR)).toMatch(/^ERR/)
  })

  it('keeps zero dates displayable and editable', () => {
    expect(norm('0000-00-00', DATE)).toBe('0000-00-00')
    expect(norm('0000-00-00 00:00:00', DATETIME)).toBe('0000-00-00 00:00:00')
    expect(norm('0000-00-00 10:00:00', DATETIME)).toMatch(/^ERR Una fecha cero/)
    expect(parseTemporal('0000-00-00 00:00:00', 'datetime')).toMatchObject({
      ok: true,
      value: { zero: true, date: null }
    })
  })
})

describe('no timezone shift', () => {
  it('values near midnight and on DST change days come back unchanged', () => {
    // 2026-03-29 02:30 does not exist in Europe/Madrid and 2026-10-25 02:30 happens twice;
    // the literal is text, so both are kept exactly.
    for (const v of [
      '2026-03-29 02:30:00',
      '2026-10-25 02:30:00',
      '2026-12-31 23:59:59',
      '2027-01-01 00:00:00'
    ])
      expect(norm(v, DATETIME)).toBe(v)
  })

  it('"Ahora" takes the local wall clock fields, not UTC', () => {
    const clock = new Date(2026, 9, 25, 2, 30, 15, 7) // local time constructor
    expect(nowParts(clock)).toEqual({
      date: { year: 2026, month: 10, day: 25 },
      time: { negative: false, hours: 2, minutes: 30, seconds: 15, fraction: '007000' }
    })
  })
})

describe('calendar helpers', () => {
  it('computes weekdays and month grids starting on Monday', () => {
    expect(weekday(2026, 10, 6)).toBe(1) // Tuesday
    expect(weekday(2024, 2, 29)).toBe(3) // Thursday
    expect(daysInMonth(2100, 2)).toBe(28)
    expect(daysInMonth(2000, 2)).toBe(29)
    const grid = monthGrid(2026, 9)
    expect(grid[0]).toEqual([null, 1, 2, 3, 4, 5, 6])
    expect(grid.flat().filter(Boolean)).toHaveLength(30)
  })
})
