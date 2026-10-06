import { productionWriteTargets } from '@shared/productionGuard'
import type { JobTask } from '@shared/types'
import { useConfirm } from '@renderer/composables/useConfirm'
import { useConnectionsStore } from '@renderer/stores/connections'

// Pure helpers live in src/shared so main enforces the same rules.
export { productionRiskSignature, productionWriteTargets } from '@shared/productionGuard'

/**
 * Confirmation for running or scheduling a job whose SQL tasks write to production.
 * Asks once per production connection (typing its name when the setting is on).
 */
export function useJobProductionGuard() {
  const connections = useConnectionsStore()
  const { confirmDestructive } = useConfirm()

  async function confirm(
    jobName: string,
    tasks: JobTask[],
    action: 'run' | 'schedule'
  ): Promise<boolean> {
    for (const connection of productionWriteTargets(tasks, (id) => connections.get(id))) {
      const count = tasks.filter(
        (t) => t.type === 'runquery' && t.connectionId === connection.id
      ).length
      const message =
        action === 'run'
          ? `«${jobName}» ejecutará ${count} consulta(s) SQL sobre «${connection.name}» (producción).`
          : `«${jobName}» quedará programada y ejecutará ${count} consulta(s) SQL sobre «${connection.name}» (producción) sin supervisión.`
      const ok = await confirmDestructive({
        connectionId: connection.id,
        title: action === 'run' ? 'Ejecutar tarea en producción' : 'Programar tarea en producción',
        message,
        confirmText: action === 'run' ? 'Ejecutar en producción' : 'Programar en producción',
        alwaysAsk: false
      })
      if (!ok) return false
    }
    return true
  }

  return { confirm, lookup: (id: string) => connections.get(id) }
}
