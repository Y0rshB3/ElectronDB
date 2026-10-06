import { describe, expect, it } from 'vitest'
import {
  CronError,
  cronToCalendarIntervals,
  describeNext,
  MAX_CALENDAR_INTERVALS,
  validateCron
} from './cron'

describe('cronToCalendarIntervals', () => {
  it('expands steps, ranges and omits wildcard fields', () => {
    const intervals = cronToCalendarIntervals('*/15 9-17 * * 1-5')
    // 4 minutes x 9 hours x 5 weekdays
    expect(intervals).toHaveLength(4 * 9 * 5)
    expect(intervals[0]).toEqual({ Minute: 0, Hour: 9, Weekday: 1 })
    expect(intervals.at(-1)).toEqual({ Minute: 45, Hour: 17, Weekday: 5 })
    const minutes = new Set(intervals.map((i) => i.Minute))
    expect([...minutes].sort((a, b) => a! - b!)).toEqual([0, 15, 30, 45])
    const hours = new Set(intervals.map((i) => i.Hour))
    expect(hours.size).toBe(9)
    expect(intervals.every((i) => i.Day === undefined && i.Month === undefined)).toBe(true)
  })

  it('handles single values, comma lists and names', () => {
    expect(cronToCalendarIntervals('30 2 * * *')).toEqual([{ Minute: 30, Hour: 2 }])
    expect(cronToCalendarIntervals('0 0 1,15 * *')).toEqual([
      { Minute: 0, Hour: 0, Day: 1 },
      { Minute: 0, Hour: 0, Day: 15 }
    ])
    expect(cronToCalendarIntervals('0 6 * jan mon')).toEqual([
      { Minute: 0, Hour: 6, Month: 1, Weekday: 1 }
    ])
    // 7 is Sunday and collapses with 0
    expect(cronToCalendarIntervals('0 6 * * 0,7')).toEqual([{ Minute: 0, Hour: 6, Weekday: 0 }])
  })

  it('supports a range with a step', () => {
    expect(cronToCalendarIntervals('0 8-18/5 * * *')).toEqual([
      { Minute: 0, Hour: 8 },
      { Minute: 0, Hour: 13 },
      { Minute: 0, Hour: 18 }
    ])
  })

  it('returns an all-wildcard schedule as a single empty dict', () => {
    expect(cronToCalendarIntervals('* * * * *')).toEqual([{}])
  })

  it('caps the cartesian product with a Spanish error', () => {
    // 60 x 24 = 1440 > 1000
    expect(() => cronToCalendarIntervals('* 0-23 * * *')).not.toThrow()
    expect(() => cronToCalendarIntervals('0-59 0-23 * * *')).toThrow(CronError)
    expect(() => cronToCalendarIntervals('0-59 0-23 * * *')).toThrow(/programación más sencilla/)
    expect(() => cronToCalendarIntervals('0-59 0-23 * * *')).toThrow(
      new RegExp(String(MAX_CALENDAR_INTERVALS))
    )
  })

  it('rejects invalid fields with Spanish messages', () => {
    expect(() => cronToCalendarIntervals('60 * * * *')).toThrow(/minuto/)
    expect(() => cronToCalendarIntervals('0 25 * * *')).toThrow(/hora/)
    expect(() => cronToCalendarIntervals('0 0 0 * *')).toThrow(/día del mes/)
    expect(() => cronToCalendarIntervals('0 0 * 13 *')).toThrow(/mes/)
    expect(() => cronToCalendarIntervals('0 0 * * 8')).toThrow(/día de la semana/)
    expect(() => cronToCalendarIntervals('0 0 * * *  *')).toThrow(/5 campos/)
    expect(() => cronToCalendarIntervals('*/0 * * * *')).toThrow(/paso/)
    expect(() => cronToCalendarIntervals('5-1 * * * *')).toThrow(/invertido/)
    expect(() => cronToCalendarIntervals('abc * * * *')).toThrow(/no válido/)
  })
})

describe('validateCron', () => {
  it('accepts a normal expression', () => {
    expect(validateCron('*/15 9-17 * * 1-5')).toBeNull()
    expect(validateCron('0 3 * * *')).toBeNull()
  })

  it('returns a Spanish message for invalid expressions', () => {
    expect(validateCron('')).toMatch(/vacía/)
    expect(validateCron('0 3 * *')).toMatch(/5 campos/)
    expect(validateCron('99 3 * * *')).toMatch(/minuto/)
    expect(validateCron('0 3 * * L')).toMatch(/no válido/)
  })
})

describe('describeNext', () => {
  it('returns the ISO timestamp of the next run', () => {
    const from = new Date('2026-01-01T10:00:00.000Z')
    const next = describeNext('0 * * * *', from)
    expect(next).not.toBeNull()
    const nextDate = new Date(next!)
    expect(nextDate.getTime()).toBeGreaterThan(from.getTime())
    expect(nextDate.getMinutes()).toBe(0)
  })

  it('returns null for invalid expressions', () => {
    expect(describeNext('not a cron')).toBeNull()
  })
})
