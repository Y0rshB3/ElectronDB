import { defineStore } from 'pinia'
import { markRaw, ref } from 'vue'
import { JOB_LOG_MAX_LINES, splitLogText } from '@shared/jobLog'
import type { JobLogEvent } from '@shared/types'
import { api } from '@renderer/api'
import { errorMessage } from '@renderer/composables/useNotify'

/** jobs:runLog answer when the run or its file does not exist. */
const NO_LOG = 'Sin registro'
/** Runs whose log stays in memory (live runs are never evicted while streaming). */
const MAX_BUFFERS = 12

export interface RunLogBuffer {
  /**
   * Visible lines; `lines[0]` is line number `offset` of the log file. A raw
   * (non-reactive) array: watch `rev` to follow changes, it can hold 20k lines.
   */
  lines: string[]
  /** Lines dropped from the start to respect JOB_LOG_MAX_LINES. */
  offset: number
  /** Bumped on every change of `lines`/`offset`. */
  rev: number
  /**
   * Bumped when lines are replaced instead of appended or trimmed (file load,
   * missed batches): line `offset + i` may then hold different text.
   */
  generation: number
  /** True when every line since the first one is present (live from seq 0 or loaded). */
  complete: boolean
  loading: boolean
  /** True once jobs:runLog answered that there is no log file. */
  missing: boolean
  error: string
}

function emptyBuffer(): RunLogBuffer {
  return {
    lines: markRaw([]),
    offset: 0,
    rev: 0,
    generation: 0,
    complete: false,
    loading: false,
    missing: false,
    error: ''
  }
}

/**
 * Automation run logs. Lines stream in through event:jobLog (batched by the
 * main process, `seq` = index of the first line) and are merged with the
 * persisted file read through jobs:runLog, so a panel opened mid-run or
 * after a reload shows every line exactly once.
 */
export const useJobLogsStore = defineStore('jobLogs', () => {
  const buffers = ref<Record<string, RunLogBuffer>>({})
  const order: string[] = []

  function touch(runId: string): RunLogBuffer {
    let buf = buffers.value[runId]
    if (!buf) {
      buffers.value[runId] = emptyBuffer()
      buf = buffers.value[runId]
    }
    const idx = order.indexOf(runId)
    if (idx >= 0) order.splice(idx, 1)
    order.push(runId)
    while (order.length > MAX_BUFFERS) {
      const evicted = order.shift()!
      delete buffers.value[evicted]
    }
    return buf
  }

  /** Trims to JOB_LOG_MAX_LINES and publishes the change. */
  function commit(buf: RunLogBuffer): void {
    const extra = buf.lines.length - JOB_LOG_MAX_LINES
    if (extra > 0) {
      buf.lines.splice(0, extra)
      buf.offset += extra
    }
    buf.rev++
  }

  /** Merges a batch of live lines. Overlapping lines are ignored, gaps mark the buffer incomplete. */
  function append(event: JobLogEvent): void {
    if (!event || !event.runId || !Array.isArray(event.lines)) return
    const buf = touch(event.runId)
    const end = buf.offset + buf.lines.length
    if (event.seq > end) {
      // Missed lines (window opened mid-run): keep what arrives, a load() fills the gap.
      if (buf.lines.length === 0) buf.offset = event.seq
      else buf.generation++
      buf.complete = false
      buf.lines.push(...event.lines)
    } else {
      const fresh = event.lines.slice(end - event.seq)
      if (fresh.length === 0) return
      if (event.seq === 0 && buf.lines.length === 0) buf.complete = true
      buf.lines.push(...fresh)
    }
    commit(buf)
  }

  /** Reads the persisted log and merges it with lines that arrived meanwhile. */
  async function load(runId: string): Promise<void> {
    const buf = touch(runId)
    buf.loading = true
    buf.error = ''
    try {
      const text = await api.invokeSilent('jobs:runLog', runId)
      const current = buffers.value[runId]
      if (!current) return
      if (text === NO_LOG) {
        current.missing = current.lines.length === 0
        return
      }
      const fileLines = splitLogText(text)
      // Live lines past the end of the file (written after the read) are kept.
      const liveTail = current.lines.slice(Math.max(0, fileLines.length - current.offset))
      current.lines = markRaw([...fileLines, ...liveTail])
      current.offset = 0
      current.generation++
      current.complete = true
      current.missing = false
      commit(current)
    } catch (err) {
      const current = buffers.value[runId]
      if (current) current.error = `No se pudo leer el registro: ${errorMessage(err)}`
    } finally {
      const current = buffers.value[runId]
      if (current) current.loading = false
    }
  }

  /** Loads the file unless the buffer already holds the whole log. */
  async function ensure(runId: string): Promise<void> {
    const buf = buffers.value[runId]
    if (buf && (buf.complete || buf.loading)) {
      touch(runId)
      return
    }
    await load(runId)
  }

  function get(runId: string | null | undefined): RunLogBuffer | null {
    return runId ? (buffers.value[runId] ?? null) : null
  }

  function listen(): () => void {
    return api.on('event:jobLog', append)
  }

  return { buffers, append, load, ensure, get, listen }
})
