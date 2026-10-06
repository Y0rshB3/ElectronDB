import type { RunStatus } from '@shared/types'

export const RUN_STATUS: Record<RunStatus, { label: string; color: string; icon: string }> = {
  queued: { label: 'En cola', color: 'secondary', icon: 'mdi-timer-sand' },
  running: { label: 'Ejecutando', color: 'info', icon: 'mdi-progress-clock' },
  success: { label: 'Correcto', color: 'success', icon: 'mdi-check-circle-outline' },
  failed: { label: 'Error', color: 'error', icon: 'mdi-alert-circle-outline' },
  cancelled: { label: 'Cancelado', color: 'warning', icon: 'mdi-cancel' }
}

export const TRIGGER_LABELS: Record<string, string> = {
  manual: 'Manual',
  schedule: 'Programada',
  cli: 'launchd'
}
