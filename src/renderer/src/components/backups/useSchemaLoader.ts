import { ref } from 'vue'
import { api } from '@renderer/api'
import { errorMessage } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'

/**
 * Loads schema names per connection on demand (opening the connection when needed).
 * State is per component instance so dialogs do not leak stale lists.
 */
export function useSchemaLoader() {
  const connections = useConnectionsStore()
  const schemas = ref<Record<string, string[]>>({})
  const loading = ref<Record<string, boolean>>({})
  const errors = ref<Record<string, string>>({})

  async function load(connectionId: string | null | undefined, force = false): Promise<string[]> {
    if (!connectionId) return []
    if (!force && schemas.value[connectionId]) return schemas.value[connectionId]
    loading.value = { ...loading.value, [connectionId]: true }
    try {
      if (!connections.isOpen(connectionId)) await connections.open(connectionId)
      const dbs = await api.db.databases(connectionId)
      const names = dbs.map((d) => d.name)
      schemas.value = { ...schemas.value, [connectionId]: names }
      const nextErrors = { ...errors.value }
      delete nextErrors[connectionId]
      errors.value = nextErrors
      return names
    } catch (err) {
      errors.value = { ...errors.value, [connectionId]: errorMessage(err) }
      return []
    } finally {
      loading.value = { ...loading.value, [connectionId]: false }
    }
  }

  function of(connectionId: string | null | undefined): string[] {
    return connectionId ? (schemas.value[connectionId] ?? []) : []
  }

  function isLoading(connectionId: string | null | undefined): boolean {
    return !!connectionId && !!loading.value[connectionId]
  }

  function errorOf(connectionId: string | null | undefined): string | undefined {
    return connectionId ? errors.value[connectionId] : undefined
  }

  return { schemas, load, of, isLoading, errorOf }
}
