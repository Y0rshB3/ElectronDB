import { Cron } from 'croner'

/**
 * Cron helpers shared by the in-app scheduler and the launchd agent writer.
 * Only 5-field expressions (minute hour day month weekday) are supported so
 * that every schedule can be expressed as launchd StartCalendarInterval.
 */

export interface CalendarInterval {
  Minute?: number
  Hour?: number
  Day?: number
  Month?: number
  Weekday?: number
}

/** Maximum number of StartCalendarInterval entries written for one job. */
export const MAX_CALENDAR_INTERVALS = 1000

interface FieldSpec {
  key: keyof CalendarInterval
  label: string
  min: number
  max: number
  names?: readonly string[]
}

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec'
] as const
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

const FIELDS: readonly FieldSpec[] = [
  { key: 'Minute', label: 'minuto', min: 0, max: 59 },
  { key: 'Hour', label: 'hora', min: 0, max: 23 },
  { key: 'Day', label: 'día del mes', min: 1, max: 31 },
  { key: 'Month', label: 'mes', min: 1, max: 12, names: MONTHS },
  // 7 is accepted as an alias of Sunday and normalised to 0.
  { key: 'Weekday', label: 'día de la semana', min: 0, max: 7, names: WEEKDAYS }
]

export class CronError extends Error {}

function splitFields(cron: string): string[] {
  return cron.trim().split(/\s+/).filter(Boolean)
}

function parseValue(token: string, spec: FieldSpec): number {
  const lower = token.toLowerCase()
  if (spec.names) {
    const idx = spec.names.indexOf(lower)
    if (idx >= 0) return spec.key === 'Month' ? idx + 1 : idx
  }
  if (!/^\d+$/.test(token)) {
    throw new CronError(
      `Valor "${token}" no válido en el campo ${spec.label} de la expresión cron.`
    )
  }
  const n = Number(token)
  if (n < spec.min || n > spec.max) {
    throw new CronError(
      `El campo ${spec.label} admite valores entre ${spec.min} y ${spec.max} (recibido ${token}).`
    )
  }
  return n
}

/** Expands one cron field to explicit values; returns null for "any" (`*`). */
export function expandCronField(field: string, spec: FieldSpec): number[] | null {
  if (field === '*') return null
  const values = new Set<number>()
  for (const part of field.split(',')) {
    if (!part) throw new CronError(`Lista vacía en el campo ${spec.label} de la expresión cron.`)
    const [rangeExpr, stepExpr, ...rest] = part.split('/')
    if (rest.length > 0 || stepExpr === '') {
      throw new CronError(
        `Paso no válido "${part}" en el campo ${spec.label} de la expresión cron.`
      )
    }
    let step = 1
    if (stepExpr !== undefined) {
      if (!/^\d+$/.test(stepExpr) || Number(stepExpr) < 1) {
        throw new CronError(
          `El paso "${stepExpr}" del campo ${spec.label} debe ser un entero mayor que 0.`
        )
      }
      step = Number(stepExpr)
    }
    let from: number
    let to: number
    if (rangeExpr === '*') {
      from = spec.min
      to = spec.max
    } else if (rangeExpr.includes('-')) {
      const [a, b, ...more] = rangeExpr.split('-')
      if (more.length > 0 || !a || !b) {
        throw new CronError(
          `Rango no válido "${rangeExpr}" en el campo ${spec.label} de la expresión cron.`
        )
      }
      from = parseValue(a, spec)
      to = parseValue(b, spec)
      if (from > to) {
        throw new CronError(`El rango "${rangeExpr}" del campo ${spec.label} está invertido.`)
      }
    } else {
      from = parseValue(rangeExpr, spec)
      to = stepExpr !== undefined ? spec.max : from
    }
    for (let v = from; v <= to; v += step) values.add(v)
  }
  const list = [...values].map((v) => (spec.key === 'Weekday' && v === 7 ? 0 : v))
  return [...new Set(list)].sort((a, b) => a - b)
}

/** Parses the 5 fields of a cron expression; throws CronError with a Spanish message. */
export function parseCronFields(cron: string): (number[] | null)[] {
  const fields = splitFields(cron)
  if (fields.length !== 5) {
    throw new CronError(
      `La expresión cron debe tener 5 campos (minuto hora día mes día-semana); se recibieron ${fields.length}.`
    )
  }
  return fields.map((field, i) => expandCronField(field, FIELDS[i]))
}

/** Returns a Spanish error message when the expression is not usable, null otherwise. */
export function validateCron(cron: string): string | null {
  if (!cron || !cron.trim()) return 'La expresión cron no puede estar vacía.'
  try {
    parseCronFields(cron)
    const next = new Cron(cron, { mode: '5-part' }).nextRun()
    if (!next) return 'La expresión cron nunca se ejecutaría.'
    return null
  } catch (err) {
    if (err instanceof CronError) return err.message
    return `Expresión cron no válida: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** ISO timestamp of the next execution, or null when invalid / never. */
export function describeNext(cron: string, from: Date = new Date()): string | null {
  try {
    return new Cron(cron, { mode: '5-part' }).nextRun(from)?.toISOString() ?? null
  } catch {
    return null
  }
}

/**
 * Converts a cron expression into launchd StartCalendarInterval entries.
 * `*` fields are omitted (launchd treats a missing key as wildcard); every
 * other field is expanded to explicit values and combined cartesianly.
 */
export function cronToCalendarIntervals(cron: string): CalendarInterval[] {
  const expanded = parseCronFields(cron)
  const total = expanded.reduce((acc, values) => acc * (values ? values.length : 1), 1)
  if (total > MAX_CALENDAR_INTERVALS) {
    throw new CronError(
      `La expresión cron "${cron}" genera ${total} combinaciones para launchd (máximo ${MAX_CALENDAR_INTERVALS}). Usa una programación más sencilla, por ejemplo menos valores por campo.`
    )
  }
  let combos: CalendarInterval[] = [{}]
  expanded.forEach((values, i) => {
    if (!values) return
    const key = FIELDS[i].key
    combos = combos.flatMap((base) => values.map((v) => ({ ...base, [key]: v })))
  })
  return combos
}
