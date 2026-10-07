import { onBeforeUnmount, ref } from 'vue'
import type { ProgressEvent } from '@shared/types'
import { api, newOperationId } from '@renderer/api'
import { appendLog, logEntryOf, type ImportLogEntry } from './importHelpers'

/**
 * One import operation of the wizard: its id, the live log built from its
 * progress events (kind 'import'), byte counters and cancellation.
 */
export function useImportOperation() {
  const operationId = ref<string | null>(null)
  const running = ref(false)
  const cancelling = ref(false)
  const log = ref<ImportLogEntry[]>([])
  const current = ref(0)
  const total = ref<number | null>(null)
  /** Text of the last periodic event («Línea 1.204 · 380 sentencias»). */
  const status = ref('')
  let seq = 0

  const off = api.on('event:progress', (event: ProgressEvent) => {
    if (!operationId.value || event.operationId !== operationId.value) return
    if (!event.done) {
      current.value = event.current
      total.value = event.total
      if (event.phase === 'statement' || event.phase === 'file') status.value = event.message
    }
    const entry = logEntryOf(event, ++seq)
    if (entry) log.value = appendLog(log.value, entry)
  })
  onBeforeUnmount(off)

  function reset(): void {
    operationId.value = null
    running.value = false
    cancelling.value = false
    log.value = []
    current.value = 0
    total.value = null
    status.value = ''
  }

  /** Runs `fn` with a fresh operation id; the log starts empty. */
  async function run<T>(fn: (operationId: string) => Promise<T>): Promise<T> {
    reset()
    const id = newOperationId('import')
    operationId.value = id
    running.value = true
    try {
      return await fn(id)
    } finally {
      running.value = false
      cancelling.value = false
    }
  }

  async function cancel(): Promise<void> {
    if (!operationId.value || !running.value) return
    cancelling.value = true
    try {
      await api.importers.cancel(operationId.value)
    } catch {
      cancelling.value = false
    }
  }

  return { operationId, running, cancelling, log, current, total, status, reset, run, cancel }
}
