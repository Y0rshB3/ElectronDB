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
  /**
   * Passwords of encrypted .vqb typed in this session, by path, so the details
   * panel and the restore dialog ask only once. Memory only: never persisted.
   */
  const passwords = new Map<string, string>()

  function passwordOf(path: string): string | null {
    return passwords.get(path) ?? null
  }

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
    const known = passwords.get(path)
    const m = known ? await api.backups.unlockMeta(path, known) : await api.backups.meta(path)
    metaCache.value = { ...metaCache.value, [path]: m }
    return m
  }

  /**
   * Opens an encrypted .vqb with `password` (throws the main-process message
   * on a wrong one) and remembers the password for this session.
   */
  async function unlock(path: string, password: string): Promise<BackupMeta> {
    const m = await api.backups.unlockMeta(path, password)
    passwords.set(path, password)
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
    passwords.delete(file.path)
  }

  return {
    lists,
    loading,
    metaCache,
    listOf,
    isLoading,
    load,
    meta,
    unlock,
    passwordOf,
    invalidate,
    create,
    restore,
    remove
  }
})
