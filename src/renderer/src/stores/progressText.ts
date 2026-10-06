import { formatCount, objectTypeLabel } from '@shared/jobLog'
import type { ProgressEvent } from '@shared/types'

/** What progress UIs (floating card, status bar, dialogs) show for one operation. */
export interface ProgressView {
  /** Second line of the card: "Paso 3/15 · accounts", "12/85 objetos"... */
  subtitle: string
  /** Current activity: "Tabla user (12/85) · 123.456 filas". */
  message: string
  /** 0-100, or null when unknown (indeterminate bar). */
  percent: number | null
  /** Left side of the counter row ("Paso 3/15", "12/85 objetos"), null to hide it. */
  counter: string | null
}

const PHASE_LABELS: Record<string, string> = {
  object: 'Objetos',
  rows: 'Filas',
  list: 'Preparando',
  finish: 'Finalizando',
  done: 'Completado',
  error: 'Error',
  cancelled: 'Cancelado',
  success: 'Completado',
  failed: 'Error',
  partial: 'Finalizado con errores'
}

const clamp = (value: number): number => Math.max(0, Math.min(100, Math.round(value)))

/** "Tabla user (12/85) · 123.456 filas" from the structured detail, or '' without one. */
function objectText(event: ProgressEvent): string {
  const d = event.detail
  if (!d?.objectName) return ''
  if (d.objectType === 'Statement') return `Sentencia ${d.objectName}`
  const position = d.objectIndex && d.objects ? ` (${d.objectIndex}/${d.objects})` : ''
  return `${objectTypeLabel(d.objectType)} ${d.objectName}${position}${rowsText(d.rows, d.rowsEstimate)}`
}

/** " · 300.000 de ~1.000.000 filas" while the estimate is ahead, " · 300.000 filas" otherwise. */
function rowsText(rows: number | null | undefined, estimate: number | null | undefined): string {
  if (typeof rows !== 'number') return ''
  if (estimate && estimate > rows)
    return ` · ${formatCount(rows)} de ~${formatCount(estimate)} filas`
  if (rows <= 0) return ''
  return ` · ${formatCount(rows)} ${rows === 1 ? 'fila' : 'filas'}`
}

/**
 * Fraction (0-1) done within the current step/operation: weighted work
 * (objects plus estimated rows, so it moves inside a large table) when the
 * backup reports it, objects done / objects otherwise.
 */
function objectFraction(event: ProgressEvent): number {
  const d = event.detail
  if (d?.workTotal && d.workTotal > 0)
    return Math.min(1, Math.max(0, (d.workDone ?? 0) / d.workTotal))
  if (!d?.objects) return 0
  return Math.min(1, (d.objectsDone ?? 0) / d.objects)
}

function fallback(event: ProgressEvent): ProgressView {
  const percent = event.total ? clamp((event.current / event.total) * 100) : null
  return {
    subtitle: PHASE_LABELS[event.phase] ?? event.phase,
    message: event.error ?? event.message,
    percent: event.done ? 100 : percent,
    counter: event.total ? `${formatCount(event.current)} / ${formatCount(event.total)}` : null
  }
}

/**
 * Human progress for one operation. Automation runs show the step
 * ("Paso 3/15 · accounts") and the object inside it; single backups show
 * objects done / total objects. Events without detail keep the plain text.
 */
export function describeProgress(event: ProgressEvent): ProgressView {
  const d = event.detail
  if (event.done || !d) return fallback(event)
  if (d.step && d.steps) {
    const stepText = `Paso ${d.step}/${d.steps}`
    return {
      subtitle: d.stepLabel ? `${stepText} · ${d.stepLabel}` : stepText,
      message:
        objectText(event) ||
        (event.phase === 'list' ? `Encontrados ${event.message}` : 'Iniciando…'),
      percent: clamp(((d.step - 1 + objectFraction(event)) / d.steps) * 100),
      counter: d.objects
        ? `${stepText} · ${formatCount(d.objectsDone ?? 0)}/${formatCount(d.objects)} objetos`
        : stepText
    }
  }
  if (d.objects) {
    const done = `${formatCount(d.objectsDone ?? 0)}/${formatCount(d.objects)} objetos`
    return {
      subtitle: done,
      message: objectText(event) || event.message,
      percent: clamp(objectFraction(event) * 100),
      counter: done
    }
  }
  return fallback(event)
}

/** One-line text for the status bar. */
export function progressStatusText(event: ProgressEvent): string {
  if (!event.detail || event.done) {
    return `${event.message}${event.total ? ` (${event.current}/${event.total})` : ''}`
  }
  const view = describeProgress(event)
  const prefix = event.detail.jobName ? `${event.detail.jobName} · ` : ''
  return `${prefix}${[view.subtitle, view.message].filter(Boolean).join(' · ')}`
}
