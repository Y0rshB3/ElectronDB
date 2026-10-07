/**
 * Automation run log: human-readable lines shared by the main process (which
 * writes them to `<logDir>/jobs/<runId>.log` and streams them through
 * event:jobLog) and the renderer (which parses them back for styling).
 *
 * Layout, modelled on Navicat's batch job log:
 *
 *   [17:38:10] Inicio de «Backup diario» · 05/10/2026 · manual · 2 pasos
 *   [17:38:10] Paso 1/2 · Base de datos accounts (Local)
 *   [17:38:10]   Encontrados 3 objetos (2 tablas, 1 vista)
 *   [17:38:14]   Tabla user ................................        1.234 filas  OK
 *   [17:38:14]   Resultado: OK · 3 objetos · 1.234 filas · 2,1 MB · 4,1 s
 *   [17:38:15] Resumen
 *   [17:38:15]   Pasos: 2 · Correctos: 1 · Con error: 1 · Cancelados: 0 · Omitidos: 0
 *   [17:38:15]   ERROR · Paso 2/2 · Base de datos crm (Local): Unknown database 'crm'
 *   [17:38:15]   Duración total: 5,0 s
 *   [17:38:15] Finalizado con errores: 1 de 2 pasos con error.
 *
 * Only names, counts, sizes, paths and error messages: never row data or SQL text.
 */

import type { RunStatus } from './types'

/** Lines kept per run in the renderer (older ones are dropped from the view, not the file). */
export const JOB_LOG_MAX_LINES = 20_000
/** Batching window of event:jobLog. */
export const JOB_LOG_FLUSH_MS = 200

const LABEL_WIDTH = 48
const COUNT_WIDTH = 16

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Local wall-clock time, HH:mm:ss. */
export function clock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/** Integer with Spanish thousands separators, always grouped: 1234 -> "1.234". */
export function formatCount(value: number): string {
  const n = Math.round(value)
  const sign = n < 0 ? '-' : ''
  return sign + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

const decimal = (value: number, digits = 1): string => value.toFixed(digits).replace('.', ',')

/** Byte size with a decimal comma: "245,3 KB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${formatCount(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${decimal(value, value >= 100 ? 0 : 1)} ${units[unit]}`
}

/** Elapsed time: "850 ms", "12,3 s", "2 min 05 s", "1 h 02 min". */
export function formatElapsed(ms: number): string {
  const value = Math.max(0, ms)
  if (value < 1000) return `${Math.round(value)} ms`
  if (value < 60_000) return `${decimal(value / 1000)} s`
  const totalSeconds = Math.round(value / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours} h ${pad2(minutes)} min`
  return `${minutes} min ${pad2(seconds)} s`
}

/** "1 fila" / "1.234 filas". */
export function plural(count: number, singular: string, pluralForm: string): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`
}

/** Collapses whitespace/newlines so one entry is always one line. */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

/** `[HH:mm:ss] body` — the persisted and streamed form of every line. */
export function stampLine(at: Date, body: string): string {
  return `[${clock(at)}] ${body.replace(/[\r\n]+/g, ' ')}`
}

/* ---------- builders (main process) ---------- */

export const OBJECT_TYPE_LABELS: Record<string, string> = {
  Table: 'Tabla',
  View: 'Vista',
  Function: 'Función',
  Procedure: 'Procedimiento',
  Event: 'Evento',
  Trigger: 'Trigger',
  Statement: 'Sentencia'
}

const OBJECT_TYPE_PLURALS: Record<string, [string, string]> = {
  Table: ['tabla', 'tablas'],
  View: ['vista', 'vistas'],
  Function: ['función', 'funciones'],
  Procedure: ['procedimiento', 'procedimientos'],
  Event: ['evento', 'eventos']
}

const TRIGGER_LABELS: Record<string, string> = {
  manual: 'manual',
  schedule: 'programada',
  cli: 'launchd'
}

export function objectTypeLabel(type: string | undefined): string {
  return (type && OBJECT_TYPE_LABELS[type]) || 'Objeto'
}

/** "3 objetos (2 tablas, 1 vista)". */
export function describeObjectCounts(types: string[]): string {
  const counts = new Map<string, number>()
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1)
  const parts = [...counts.entries()].map(([type, n]) => {
    const [one, many] = OBJECT_TYPE_PLURALS[type] ?? ['objeto', 'objetos']
    return plural(n, one, many)
  })
  const head = plural(types.length, 'objeto', 'objetos')
  return parts.length ? `${head} (${parts.join(', ')})` : head
}

export function runStartLine(input: {
  jobName: string
  trigger: string
  steps: number
  at: Date
}): string {
  const date = `${pad2(input.at.getDate())}/${pad2(input.at.getMonth() + 1)}/${input.at.getFullYear()}`
  const trigger = TRIGGER_LABELS[input.trigger] ?? input.trigger
  return `Inicio de «${input.jobName}» · ${date} · ${trigger} · ${plural(input.steps, 'paso', 'pasos')}`
}

export interface StepInfo {
  type: string
  schema: string
  connectionName: string
  referenceName: string
  /** restoreschema: schema stored in the backup and the connection it came from. */
  sourceSchema?: string
  sourceConnectionName?: string
  /** restoreschema «Solo estructura»: objects without rows. */
  structureOnly?: boolean
}

/** Name of the replace content mode that creates every object with empty tables. */
export const STRUCTURE_ONLY_LABEL = 'Solo estructura'

/** "Solo estructura: 7 objetos, 0 filas" — result of a structure-only replace. */
export function structureOnlySummary(objects: number): string {
  return `${STRUCTURE_ONLY_LABEL}: ${plural(objects, 'objeto', 'objetos')}, 0 filas`
}

/**
 * Restore heading: "Base de datos auth: Staging -> Local", with the target
 * schema appended when it is not the source name ("... -> Local · auth_copy").
 */
export function restoreLabel(step: StepInfo): string {
  const source = step.sourceSchema || step.schema || '?'
  const target = step.schema || source
  const from = step.sourceConnectionName || 'backup'
  const suffix = target !== source ? ` · ${target}` : ''
  const content = step.structureOnly ? ' (solo estructura)' : ''
  return `Base de datos ${source}: ${from} -> ${step.connectionName}${suffix}${content}`
}

/** Short step name used in headings and the summary: "Base de datos accounts (Local)". */
export function stepLabel(step: StepInfo): string {
  if (step.type === 'backupschema') return `Base de datos ${step.schema} (${step.connectionName})`
  if (step.type === 'restoreschema') return restoreLabel(step)
  const where = step.schema ? `${step.schema} (${step.connectionName})` : step.connectionName
  return `Consulta «${step.referenceName}» · ${where}`
}

export function stepHeading(index: number, total: number, step: StepInfo): string {
  return `Paso ${index}/${total} · ${stepLabel(step)}`
}

export type LineStatus = 'ok' | 'error'

/**
 * One finished object, aligned like Navicat:
 * "  Tabla user ..........................        1.234 filas  OK".
 * `count` null means "no rows" (views, routines, structure-only tables).
 */
export function objectLine(input: {
  type: string | undefined
  name: string
  count: number | null
  unit?: [string, string]
  status: LineStatus
  error?: string
}): string {
  const [one, many] = input.unit ?? ['fila', 'filas']
  return labelLine({
    label: `${objectTypeLabel(input.type)} ${input.name}`,
    value: input.count === null ? '' : plural(input.count, one, many),
    status: input.status,
    error: input.error
  })
}

/**
 * Any aligned "label ..... value  OK" line (safety backups, DROP/CREATE of a
 * restore...), styled like the object lines.
 */
export function labelLine(input: {
  label: string
  value?: string
  status: LineStatus
  error?: string
}): string {
  const dots = Math.max(3, LABEL_WIDTH - input.label.length - 1)
  const status = input.status === 'ok' ? 'OK' : `ERROR: ${oneLine(input.error ?? 'error')}`
  return `  ${input.label} ${'.'.repeat(dots)} ${(input.value ?? '').padStart(COUNT_WIDTH)}  ${status}`
}

export type ResultStatus = 'OK' | 'ERROR' | 'CANCELADO' | 'OMITIDO'

export function resultLine(status: ResultStatus, parts: string[]): string {
  return [`  Resultado: ${status}`, ...parts.filter(Boolean).map(oneLine)].join(' · ')
}

export interface SummaryStep {
  label: string
  index: number
  status: RunStatus
  message: string | null
  /** Shown for a successful step (e.g. "Solo estructura: 7 objetos, 0 filas"). */
  note?: string | null
}

/** Safety copy taken before a database was replaced (restore steps). */
export interface SafetyCopy {
  schema: string
  connectionName: string
  path: string
}

/** File name of a path written by main (POSIX or Windows separators). */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

/** How to undo a replace from the UI (single source for the log, the summary and the dialogs). */
export const UNDO_REPLACE_HOW =
  'Copias de seguridad › conexión › base de datos › Restaurar › «Reemplazar la base de datos completa»'

/** "Para deshacerlo, restaura la copia previa <file> de <conn> (…) ." */
export function undoHint(copy: SafetyCopy): string {
  return `Para volver al estado anterior restaura la copia previa ${fileNameOf(copy.path)} (Copias de seguridad › ${copy.connectionName} › ${copy.schema}) con «Reemplazar la base de datos completa».`
}

/** Summary block printed at the end of every run. */
export function summaryLines(input: {
  status: RunStatus
  durationMs: number
  steps: SummaryStep[]
  /** The process died mid-run; the run was closed when Vortaq started again. */
  interrupted?: boolean
  /** Safety copies taken by restore steps: listed so the user knows how to undo. */
  safetyCopies?: SafetyCopy[]
}): string[] {
  const total = input.steps.length
  const count = (s: RunStatus): number => input.steps.filter((x) => x.status === s).length
  const ok = count('success')
  const failed = input.steps.filter((x) => x.status === 'failed')
  const cancelled = input.steps.filter(
    (x) => x.status === 'cancelled' && x.message !== SKIPPED_MESSAGE
  ).length
  const skipped = input.steps.filter((x) => x.message === SKIPPED_MESSAGE).length
  const lines = [
    'Resumen',
    `  Pasos: ${total} · Correctos: ${ok} · Con error: ${failed.length} · Cancelados: ${cancelled} · Omitidos: ${skipped}`
  ]
  for (const f of failed)
    lines.push(`  ERROR · Paso ${f.index}/${total} · ${f.label}: ${oneLine(f.message ?? 'error')}`)
  for (const s of input.steps)
    if (s.status === 'success' && s.note)
      lines.push(`  Paso ${s.index}/${total} · ${s.label}: ${oneLine(s.note)}`)
  const copies = input.safetyCopies ?? []
  if (copies.length) {
    lines.push(`  Copias previas (para deshacer: ${UNDO_REPLACE_HOW}):`)
    for (const c of copies)
      lines.push(`    ${c.schema} en ${c.connectionName}: ${fileNameOf(c.path)}`)
  }
  lines.push(`  Duración total: ${formatElapsed(input.durationMs)}`)
  if (input.interrupted) lines.push(`Ejecución interrumpida: ${ok} de ${total} pasos completados.`)
  else if (input.status === 'cancelled')
    lines.push(`Ejecución cancelada: ${ok} de ${total} pasos completados.`)
  else if (input.status === 'failed' || failed.length)
    lines.push(
      `Finalizado con errores: ${failed.length} de ${total} ${total === 1 ? 'paso' : 'pasos'} con error.`
    )
  else
    lines.push(`Finalizado correctamente: ${ok} de ${total} ${total === 1 ? 'paso' : 'pasos'} OK.`)
  return lines
}

export const SKIPPED_MESSAGE = 'Omitido por un error anterior.'
export const CANCELLED_MESSAGE = 'Ejecución cancelada.'
export const INTERRUPTED_MESSAGE =
  'Interrumpida: Vortaq se cerró o se reinició antes de terminar este paso.'

/* ---------- parser (renderer) ---------- */

export type LogLineKind = 'title' | 'heading' | 'line' | 'result' | 'summary' | 'final'
export type LogTone = 'ok' | 'error' | 'cancelled' | 'skipped' | null

export interface ParsedLogLine {
  /** HH:mm:ss, or null for lines without a timestamp. */
  time: string | null
  /** Text before the status token (or the whole body). */
  text: string
  /** Status token ("OK", "ERROR", ...) highlighted with `tone`. */
  token: string
  /** Text after the token (error message...). */
  rest: string
  kind: LogLineKind
  tone: LogTone
  /** True for lines of the final summary block. */
  inSummary: boolean
}

const STAMP_RE = /^\[(\d{2}:\d{2}:\d{2})\] ?(.*)$/
/** Logs written before this format: "2026-10-05T15:38:10.000Z message". */
const LEGACY_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (.*)$/
const OBJECT_STATUS_RE = /^(.*?\S)( {2,})(OK|ERROR)((?:: .*)?)$/
const RESULT_RE = /^(\s*Resultado: )(OK|ERROR|CANCELADO|OMITIDO)(.*)$/
const SUMMARY_ERROR_RE = /^(\s*)(ERROR)( · .*)$/

const TOKEN_TONES: Record<string, LogTone> = {
  OK: 'ok',
  ERROR: 'error',
  CANCELADO: 'cancelled',
  OMITIDO: 'skipped'
}

function splitTime(raw: string): { time: string | null; body: string } {
  const stamped = STAMP_RE.exec(raw)
  if (stamped) return { time: stamped[1], body: stamped[2] }
  const legacy = LEGACY_RE.exec(raw)
  if (legacy) {
    const date = new Date(legacy[1])
    return { time: Number.isNaN(date.getTime()) ? null : clock(date), body: legacy[2] }
  }
  return { time: null, body: raw }
}

export function parseLogLine(raw: string, inSummary = false): ParsedLogLine {
  const { time, body } = splitTime(raw)
  const base: ParsedLogLine = {
    time,
    text: body,
    token: '',
    rest: '',
    kind: 'line',
    tone: null,
    inSummary
  }
  if (/^Inicio de «/.test(body)) return { ...base, kind: 'title' }
  if (/^Paso \d+\/\d+ · /.test(body)) return { ...base, kind: 'heading' }
  if (body === 'Resumen') return { ...base, kind: 'summary', inSummary: true }
  if (/^Finalizado correctamente/.test(body))
    return { ...base, kind: 'final', tone: 'ok', inSummary: true }
  if (/^Finalizado con errores/.test(body))
    return { ...base, kind: 'final', tone: 'error', inSummary: true }
  if (/^Ejecución cancelada/.test(body))
    return { ...base, kind: 'final', tone: 'cancelled', inSummary: true }
  if (/^Ejecución interrumpida/.test(body))
    return { ...base, kind: 'final', tone: 'error', inSummary: true }
  const result = RESULT_RE.exec(body)
  if (result)
    return {
      ...base,
      kind: 'result',
      text: result[1],
      token: result[2],
      rest: result[3],
      tone: TOKEN_TONES[result[2]] ?? null
    }
  const summaryError = inSummary ? SUMMARY_ERROR_RE.exec(body) : null
  if (summaryError)
    return {
      ...base,
      kind: 'summary',
      text: summaryError[1],
      token: summaryError[2],
      rest: summaryError[3],
      tone: 'error'
    }
  const object = OBJECT_STATUS_RE.exec(body)
  if (object)
    return {
      ...base,
      text: object[1] + object[2],
      token: object[3],
      rest: object[4],
      tone: TOKEN_TONES[object[3]] ?? null,
      kind: inSummary ? 'summary' : 'line'
    }
  // Legacy lifecycle lines: colour failures and cancellations.
  if (!STAMP_RE.test(raw) && time) {
    if (/ failed: | aborted /.test(body)) return { ...base, tone: 'error' }
    if (/finished with status (\w+)/.test(body)) {
      const status = /finished with status (\w+)/.exec(body)![1]
      const tone: LogTone =
        status === 'success' ? 'ok' : status === 'failed' ? 'error' : 'cancelled'
      return { ...base, kind: 'final', tone }
    }
  }
  return { ...base, kind: inSummary ? 'summary' : 'line' }
}

/** Parses a whole log; lines after "Resumen" are flagged as summary lines. */
export function parseRunLog(lines: readonly string[]): ParsedLogLine[] {
  const out: ParsedLogLine[] = []
  let inSummary = false
  for (const raw of lines) {
    if (raw === '') continue
    const parsed = parseLogLine(raw, inSummary)
    if (parsed.kind === 'summary' && parsed.text === 'Resumen') inSummary = true
    if (parsed.kind === 'title' || parsed.kind === 'heading') inSummary = false
    out.push(parsed)
  }
  return out
}

/** Splits jobs:runLog text into lines (no trailing empty line). */
export function splitLogText(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}
