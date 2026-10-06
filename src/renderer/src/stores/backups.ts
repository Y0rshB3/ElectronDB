import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  BackupCreateOptions,
  BackupCreateResult,
  BackupFile,
  BackupMeta,
  RestoreOptions,
  RestoreResult
} from '@shared/types'
import { api, newOperationId } from '@renderer/api'

const listKey = (connectionId: string, schema?: string | null): string =>
  `${connectionId}:${schema ?? '*'}`

export const useBackupsStore = defineStore('backups', () => {
  const lists = ref<Record<string, BackupFile[]>>({})
  const loading = ref<Record<string, boolean>>({})
  const metaCache = ref<Record<string, BackupMeta>>({})

  function listOf(connectionId: string, schema?: string | null): BackupFile[] {
    return lists.value[listKey(connectionId, schema)] ?? []
  }

  function isLoading(connectionId: string, schema?: string | null): boolean {
    return !!loading.value[listKey(connectionId, schema)]
  }

  async function load(connectionId: string, schema?: string | null): Promise<BackupFile[]> {
    const key = listKey(connectionId, schema)
    loading.value = { ...loading.value, [key]: true }
    try {
      const files = await api.backups.list(connectionId, schema)
      lists.value = { ...lists.value, [key]: files }
      return files
    } finally {
      loading.value = { ...loading.value, [key]: false }
    }
  }

  async function meta(path: string, force = false): Promise<BackupMeta> {
    if (!force && metaCache.value[path]) return metaCache.value[path]
    const m = await api.backups.meta(path)
    metaCache.value = { ...metaCache.value, [path]: m }
    return m
  }

  function invalidate(connectionId: string): void {
    const next = { ...lists.value }
    for (const key of Object.keys(next)) if (key.startsWith(`${connectionId}:`)) delete next[key]
    lists.value = next
  }

  async function create(
    options: BackupCreateOptions
  ): Promise<{ operationId: string; result: BackupCreateResult }> {
    const operationId = newOperationId('backup')
    const result = await api.backups.create(operationId, options)
    invalidate(options.connectionId)
    return { operationId, result }
  }

  async function restore(
    options: RestoreOptions
  ): Promise<{ operationId: string; result: RestoreResult }> {
    const operationId = newOperationId('restore')
    const result = await api.backups.restore(operationId, options)
    return { operationId, result }
  }

  async function remove(file: BackupFile): Promise<void> {
    await api.backups.delete(file.path)
    const next = { ...lists.value }
    for (const key of Object.keys(next)) next[key] = next[key].filter((f) => f.path !== file.path)
    lists.value = next
    const nextMeta = { ...metaCache.value }
    delete nextMeta[file.path]
    metaCache.value = nextMeta
  }

  return {
    lists,
    loading,
    metaCache,
    listOf,
    isLoading,
    load,
    meta,
    invalidate,
    create,
    restore,
    remove
  }
})
