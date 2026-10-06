import { Cron } from 'croner'
import { describeCron, isValidCron, parseCron } from '@renderer/utils/cron'

/** Modes offered by the friendly schedule builder. */
export type ScheduleMode = 'daily' | 'weekly' | 'monthly' | 'hourly' | 'custom'

export interface ScheduleForm {
  mode: ScheduleMode
  /** HH:MM for daily / weekly / monthly. */
  time: string
  /** Weekdays (0 = Sunday) for weekly. */
  days: number[]
  /** Day of month (1-31) for monthly. */
  dayOfMonth: number
  /** Interval for hourly mode: every N hours. */
  everyHours: number
  /** Minute past the hour for hourly mode. */
  minuteOfHour: number
  /** Raw expression for custom mode. */
  expression: string
}

export const SCHEDULE_MODES: { value: ScheduleMode; title: string }[] = [
  { value: 'daily', title: 'Diaria' },
  { value: 'weekly', title: 'Semanal' },
  { value: 'monthly', title: 'Mensual' },
  { value: 'hourly', title: 'Cada N horas' },
  { value: 'custom', title: 'Personalizada (cron)' }
]

const pad = (n: number): string => String(n).padStart(2, '0')
const HOURLY_RE = /^(\d{1,2}) \*\/(\d{1,2}) \* \* \*$/

/**
 * Hourly shape the builder can represent exactly: minute 0-59 and step 2-23.
 * Anything else (e.g. "0 *\/24 * * *") stays custom so saving never rewrites it.
 */
function matchHourly(normalized: string): { minute: number; every: number } | null {
  const match = HOURLY_RE.exec(normalized)
  if (!match) return null
  const minute = Number(match[1])
  const every = Number(match[2])
  if (minute > 59 || every < 2 || every > 23) return null
  return { minute, every }
}

export function defaultScheduleForm(): ScheduleForm {
  return {
    mode: 'daily',
    time: '02:00',
    days: [1],
    dayOfMonth: 1,
    everyHours: 6,
    minuteOfHour: 0,
    expression: '0 2 * * *'
  }
}

function parseTime(time: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(time.trim())
  if (!match) return { hour: 0, minute: 0 }
  return { hour: clamp(Number(match[1]), 0, 23), minute: clamp(Number(match[2]), 0, 59) }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Builds the 5-field cron expression represented by the form. */
export function cronFromForm(form: ScheduleForm): string {
  const { hour, minute } = parseTime(form.time)
  switch (form.mode) {
    case 'daily':
      return `${minute} ${hour} * * *`
    case 'weekly': {
      const days = [...new Set(form.days)].sort((a, b) => a - b)
      return `${minute} ${hour} * * ${days.length ? days.join(',') : '*'}`
    }
    case 'monthly':
      return `${minute} ${hour} ${clamp(form.dayOfMonth, 1, 31)} * *`
    case 'hourly': {
      const every = clamp(form.everyHours, 1, 23)
      return `${clamp(form.minuteOfHour, 0, 59)} ${every === 1 ? '*' : `*/${every}`} * * *`
    }
    case 'custom':
      return form.expression.trim().replace(/\s+/g, ' ')
  }
}

/** Inverse of cronFromForm; unknown shapes fall back to custom mode. */
export function formFromCron(expression: string): ScheduleForm {
  const base = { ...defaultScheduleForm(), expression: expression.trim() }
  const normalized = expression.trim().replace(/\s+/g, ' ')
  const hourly = matchHourly(normalized)
  if (hourly)
    return { ...base, mode: 'hourly', minuteOfHour: hourly.minute, everyHours: hourly.every }
  const everyHour = /^(\d{1,2}) \* \* \* \*$/.exec(normalized)
  if (everyHour && Number(everyHour[1]) <= 59)
    return { ...base, mode: 'hourly', minuteOfHour: Number(everyHour[1]), everyHours: 1 }
  const preset = parseCron(normalized)
  switch (preset.type) {
    case 'daily':
      return { ...base, mode: 'daily', time: `${pad(preset.hour)}:${pad(preset.minute)}` }
    case 'weekly':
      return {
        ...base,
        mode: 'weekly',
        time: `${pad(preset.hour)}:${pad(preset.minute)}`,
        days: preset.days
      }
    case 'monthly':
      return {
        ...base,
        mode: 'monthly',
        time: `${pad(preset.hour)}:${pad(preset.minute)}`,
        dayOfMonth: preset.day
      }
    default:
      return { ...base, mode: 'custom' }
  }
}

/** Human (Spanish) description, including the hourly shape that utils/cron does not know. */
export function describeSchedule(expression: string): string {
  const normalized = expression.trim().replace(/\s+/g, ' ')
  const hourly = matchHourly(normalized)
  if (hourly) return `Cada ${hourly.every} horas, en el minuto ${hourly.minute}`
  const everyHour = /^(\d{1,2}) \* \* \* \*$/.exec(normalized)
  if (everyHour) return `Cada hora, en el minuto ${Number(everyHour[1])}`
  return describeCron(normalized)
}

const CUSTOM_PREFIX = 'Personalizada: '

/**
 * describeSchedule split for rendering: the human label plus, for custom expressions,
 * the raw cron so the view can show it in the monospace font.
 */
export function scheduleParts(expression: string): { label: string; cron: string | null } {
  const text = describeSchedule(expression)
  if (text.startsWith(CUSTOM_PREFIX)) {
    return { label: CUSTOM_PREFIX, cron: text.slice(CUSTOM_PREFIX.length) }
  }
  return { label: text, cron: null }
}

/** Next execution dates for a cron expression, or [] when it is invalid. */
export function nextRuns(expression: string, count = 5, from: Date = new Date()): Date[] {
  if (!isValidCron(expression)) return []
  try {
    return new Cron(expression.trim(), { paused: true }).nextRuns(count, from)
  } catch {
    return []
  }
}

export { isValidCron }
