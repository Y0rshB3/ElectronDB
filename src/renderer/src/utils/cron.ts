/**
 * Friendly builder around 5-field cron expressions (minute hour day month weekday).
 */
export type CronPreset =
  | { type: 'daily'; hour: number; minute: number }
  | { type: 'weekly'; days: number[]; hour: number; minute: number }
  | { type: 'monthly'; day: number; hour: number; minute: number }
  | { type: 'custom'; expression: string }

export const WEEKDAYS: { value: number; label: string; short: string }[] = [
  { value: 1, label: 'Lunes', short: 'Lun' },
  { value: 2, label: 'Martes', short: 'Mar' },
  { value: 3, label: 'Miércoles', short: 'Mié' },
  { value: 4, label: 'Jueves', short: 'Jue' },
  { value: 5, label: 'Viernes', short: 'Vie' },
  { value: 6, label: 'Sábado', short: 'Sáb' },
  { value: 0, label: 'Domingo', short: 'Dom' }
]

const pad = (n: number): string => String(n).padStart(2, '0')

export function buildCron(preset: CronPreset): string {
  switch (preset.type) {
    case 'daily':
      return `${preset.minute} ${preset.hour} * * *`
    case 'weekly': {
      const days = [...new Set(preset.days)].sort((a, b) => a - b)
      return `${preset.minute} ${preset.hour} * * ${days.length ? days.join(',') : '*'}`
    }
    case 'monthly':
      return `${preset.minute} ${preset.hour} ${preset.day} * *`
    case 'custom':
      return preset.expression.trim()
  }
}

export function isValidCron(expression: string): boolean {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const fieldRe = /^(\*|(\d+)(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/
  return fields.every((f) => fieldRe.test(f))
}

export function parseCron(expression: string): CronPreset {
  const custom: CronPreset = { type: 'custom', expression }
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return custom
  const [min, hour, dom, month, dow] = fields
  const minute = Number(min)
  const hourNum = Number(hour)
  if (!Number.isInteger(minute) || !Number.isInteger(hourNum)) return custom
  if (month !== '*') return custom
  if (dom === '*' && dow === '*') return { type: 'daily', hour: hourNum, minute }
  if (dom === '*' && /^\d+(,\d+)*$/.test(dow)) {
    return { type: 'weekly', days: dow.split(',').map(Number), hour: hourNum, minute }
  }
  if (dow === '*' && /^\d+$/.test(dom))
    return { type: 'monthly', day: Number(dom), hour: hourNum, minute }
  return custom
}

export function describeCron(expression: string): string {
  if (!isValidCron(expression)) return 'Expresión cron inválida'
  const preset = parseCron(expression)
  const time = (h: number, m: number): string => `a las ${pad(h)}:${pad(m)}`
  switch (preset.type) {
    case 'daily':
      return `Todos los días ${time(preset.hour, preset.minute)}`
    case 'weekly': {
      const names = preset.days
        .map((d) => WEEKDAYS.find((w) => w.value === d)?.label ?? String(d))
        .join(', ')
      return `Cada ${names} ${time(preset.hour, preset.minute)}`
    }
    case 'monthly':
      return `El día ${preset.day} de cada mes ${time(preset.hour, preset.minute)}`
    case 'custom':
      return `Personalizada: ${expression}`
  }
}
