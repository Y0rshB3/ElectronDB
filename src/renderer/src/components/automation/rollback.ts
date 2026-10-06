import { UNDO_REPLACE_HOW, fileNameOf, formatCount } from '@shared/jobLog'
import type { JobRun, JobTaskRun, RollbackPlanItem } from '@shared/types'
import type { ConfirmRequest } from '@renderer/stores/ui'

/** Pure helpers of «Restaurar todo en Local» (run history + RollbackDialog). */

/**
 * What RollbackDialog restores: the backups of a run (optionally only some of
 * its steps pre-checked) or backup files picked in the backups list.
 */
export type RollbackDialogSource =
  | { kind: 'run'; runId: string; taskIds?: string[] }
  | { kind: 'files'; backupPaths: string[]; sourceConnectionId: string; title: string }

/** A finished run (not itself a rollback) with at least one backup file can be restored. */
export function canRollback(run: JobRun): boolean {
  if (run.kind === 'rollback') return false
  if (run.status === 'running' || run.status === 'queued') return false
  return run.tasks.some(
    (t) =>
      t.status === 'success' &&
      !!t.outputPath &&
      (t.type ? t.type === 'backupschema' : t.outputPath.toLowerCase().endsWith('.nb3'))
  )
}

/** A restore step whose output is the safety copy of the database it replaced. */
export function isSafetyCopyStep(task: JobTaskRun): boolean {
  return task.type === 'restoreschema' && !!task.outputPath
}

/** Item selected by default: everything that can run, except structure-only copies. */
export function selectedByDefault(item: RollbackPlanItem): boolean {
  return !item.problem && !item.structureOnly
}

/** "3 objetos · 1.234 filas" of a plan item (from the backup manifest). */
export function contentText(item: RollbackPlanItem): string {
  if (item.objects === null) return ''
  const n = formatCount
  const objects = `${n(item.objects)} ${item.objects === 1 ? 'objeto' : 'objetos'}`
  if (item.structureOnly) return `${objects} · sin datos`
  return item.rows === null
    ? objects
    : `${objects} · ${n(item.rows)} ${item.rows === 1 ? 'fila' : 'filas'}`
}

/**
 * Confirmation before cancelling a run that restores databases: after its
 * DROP DATABASE the database stays incomplete. Null = no confirmation needed.
 */
export function cancelRestorePrompt(run: JobRun): ConfirmRequest | null {
  const pending = run.tasks.filter(
    (t) => t.type === 'restoreschema' && (t.status === 'running' || t.status === 'queued')
  )
  if (!pending.length) return null
  const current = pending.find((t) => t.status === 'running')
  const name = current?.schema ? `«${current.schema}»` : 'la base de datos que se está restaurando'
  const copy = current?.outputPath
    ? `Su copia previa es ${fileNameOf(current.outputPath)}: para volver al estado anterior restáurala desde ${UNDO_REPLACE_HOW}.`
    : 'Si ya se había borrado y no tiene copia previa, tendrás que volver a restaurarla.'
  return {
    title: '¿Detener la restauración?',
    message: `Si cancelas ahora, ${name} puede quedar borrada o restaurada solo en parte. Las bases de datos que faltan no se tocan.\n\n${copy}`,
    confirmText: 'Detener',
    color: 'error'
  }
}

export interface RollbackConfirmation {
  title: string
  message: string
  /** Exact list of the databases that will be REPLACED and created. */
  details: string
}

export function rollbackConfirmation(input: {
  jobName: string
  runDate: string
  targetName: string
  items: RollbackPlanItem[]
  safetyBackup: boolean
  /** Where the copies come from; default «la ejecución de «job» del <date>». */
  origin?: string
}): RollbackConfirmation {
  // Unknown existence (target not reachable) is treated as «will be replaced».
  const replaced = input.items.filter((i) => i.targetExists !== false)
  const created = input.items.filter((i) => i.targetExists === false)
  const lines: string[] = []
  if (replaced.length) {
    lines.push(`Se REEMPLAZARÁN en «${input.targetName}» (se borran y se crean de nuevo):`)
    for (const i of replaced)
      lines.push(
        `  • ${i.targetSchema}${i.targetExists === null ? ' (si existe)' : ''}  ← ${i.schema} de ${i.sourceConnectionName}`
      )
  }
  if (created.length) {
    if (lines.length) lines.push('')
    lines.push(`Se crearán en «${input.targetName}»:`)
    for (const i of created)
      lines.push(`  • ${i.targetSchema}  ← ${i.schema} de ${i.sourceConnectionName}`)
  }
  const empty = input.items.filter((i) => i.warning)
  if (empty.length) {
    lines.push('')
    lines.push('ATENCIÓN, quedarán SIN DATOS:')
    for (const i of empty) lines.push(`  • ${i.targetSchema}: ${i.warning}`)
  }
  const n = input.items.length
  const safety = input.safetyBackup
    ? replaced.length
      ? `Antes de reemplazar cada una se hará una copia de seguridad previa; si esa copia falla, esa base de datos no se toca. Para deshacer después: ${UNDO_REPLACE_HOW} (la copia lleva la etiqueta «previo-rollback»).`
      : ''
    : replaced.length
      ? 'SIN copia previa: los datos actuales de esas bases de datos se perderán.'
      : ''
  return {
    title: `Restaurar en «${input.targetName}»`,
    message: [
      `Se restaurará${n === 1 ? '' : 'n'} ${n} base${n === 1 ? '' : 's'} de datos de ${input.origin ?? `la ejecución de «${input.jobName}» del ${input.runDate}`}.`,
      safety
    ]
      .filter(Boolean)
      .join('\n\n'),
    details: lines.join('\n')
  }
}
