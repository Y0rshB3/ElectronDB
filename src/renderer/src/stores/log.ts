import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { LogEvent } from '@shared/types'
import { api } from '@renderer/api'

const MAX_ENTRIES = 500

export const useLogStore = defineStore('log', () => {
  const entries = ref<LogEvent[]>([])
  const levelFilter = ref<LogEvent['level'] | 'all'>('all')

  const filtered = computed(() =>
    levelFilter.value === 'all'
      ? entries.value
      : entries.value.filter((e) => e.level === levelFilter.value)
  )
  const errorCount = computed(() => entries.value.filter((e) => e.level === 'error').length)

  function push(event: LogEvent): void {
    entries.value.push(event)
    if (entries.value.length > MAX_ENTRIES)
      entries.value.splice(0, entries.value.length - MAX_ENTRIES)
  }

  function clear(): void {
    entries.value = []
  }

  function listen(): () => void {
    return api.on('event:log', push)
  }

  return { entries, levelFilter, filtered, errorCount, push, clear, listen }
})
