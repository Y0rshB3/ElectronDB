import { guardedWriteTargets } from '@shared/productionGuard'
import type { JobTask } from '@shared/types'
import { typedTarget, useConfirm } from '@renderer/composables/useConfirm'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useSettingsStore } from '@renderer/stores/settings'
import { environmentPhrase } from '@shared/typedConfirm'

// Pure helpers live in src/shared so main enforces the same rules.
export { guardedRiskSignature, guardedWriteTargets } from '@shared/productionGuard'

/**
 * Confirmation for running or scheduling a job whose SQL tasks write to a
 * connection that needs the typed name (production, and the environments
 * chosen in Ajustes › Seguridad). Asks once per connection.
 */
export function useJobProductionGuard() {
  const connections = useConnectionsStore()
  const settings = useSettingsStore()
  const { confirmDestructive } = useConfirm()
  const lookup = (id: string) => connections.get(id)

  async function confirm(
    jobName: string,
    tasks: JobTask[],
    action: 'run' | 'schedule'
  ): Promise<boolean> {
    for (const connection of guardedWriteTargets(tasks, lookup, settings.typedEnvironments)) {
      const count = tasks.filter(
        (t) => t.type === 'runquery' && t.connectionId === connection.id
      ).length
      const where = `«${connection.name}» (${environmentPhrase(connection.environment)})`
      const target = typedTarget(connection)
      const message =
        action === 'run'
          ? `«${jobName}» ejecutará ${count} consulta(s) SQL sobre ${where}.`
          : `«${jobName}» quedará programada y ejecutará ${count} consulta(s) SQL sobre ${where} sin supervisión.`
      const ok = await confirmDestructive({
        connectionId: connection.id,
        title: action === 'run' ? `Ejecutar tarea en ${target}` : `Programar tarea en ${target}`,
        message,
        confirmText: action === 'run' ? `Ejecutar en ${target}` : `Programar en ${target}`,
        alwaysAsk: false
      })
      if (!ok) return false
    }
    return true
  }

  /** Signature helper input: the current typed environments. */
  return { confirm, lookup, environments: () => settings.typedEnvironments }
}
