import { parseLogLine, type ParsedLogLine } from '@shared/jobLog'

/** One parsed line with its absolute line number in the log file (stable key). */
export interface LogRow extends ParsedLogLine {
  n: number
}

/** Body lines whose absolute numbers fall in [key * LOG_CHUNK_LINES, (key + 1) * LOG_CHUNK_LINES). */
export interface LogChunk {
  key: number
  rows: readonly LogRow[]
  /** Step headings inside (taller lines), for height estimates. */
  headings: number
}

export const LOG_CHUNK_LINES = 100

interface CachedChunk {
  first: number
  end: number
  chunk: LogChunk | null
}

/**
 * Incremental view model of an append-only run log. Each sync parses only
 * the lines that arrived since the previous one, and finished chunks keep
 * their identity, so the panel re-renders just the chunk that grew. Lines
 * are keyed by absolute number: trimming the front never shifts them.
 */
export class RunLogModel {
  /** Absolute number of rows[0]. */
  private start = 0
  /** Parsed lines (null for blank ones). */
  private rows: (LogRow | null)[] = []
  /** Parser state after the last row: inside the final summary block. */
  private inSummary = false
  private generation = -1
  private cache = new Map<number, CachedChunk>()

  /** Updates the model from a buffer (`lines[0]` is line `offset`). */
  sync(offset: number, lines: readonly string[], generation: number): void {
    const end = offset + lines.length
    const cachedEnd = this.start + this.rows.length
    if (
      generation !== this.generation ||
      offset < this.start ||
      offset > cachedEnd ||
      end < cachedEnd
    ) {
      this.reset(offset, generation)
    } else if (offset > this.start) {
      this.rows.splice(0, offset - this.start)
      this.start = offset
    }
    for (let abs = this.start + this.rows.length; abs < end; abs++)
      this.rows.push(this.parse(lines[abs - offset], abs))
  }

  reset(offset = 0, generation = -1): void {
    this.start = offset
    this.rows = []
    this.inSummary = false
    this.generation = generation
    this.cache.clear()
  }

  private parse(raw: string, n: number): LogRow | null {
    if (raw === '') return null
    const parsed = parseLogLine(raw, this.inSummary)
    if (parsed.kind === 'summary' && parsed.text === 'Resumen') this.inSummary = true
    if (parsed.kind === 'title' || parsed.kind === 'heading') this.inSummary = false
    return { ...parsed, n }
  }

  /** Number of non-blank lines. */
  get size(): number {
    let count = 0
    for (const row of this.rows) if (row) count++
    return count
  }

  /** Body lines (outside the final summary) grouped in chunks; unchanged chunks keep identity. */
  chunks(): LogChunk[] {
    const out: LogChunk[] = []
    const end = this.start + this.rows.length
    if (end === this.start) return out
    const firstKey = Math.floor(this.start / LOG_CHUNK_LINES)
    const lastKey = Math.floor((end - 1) / LOG_CHUNK_LINES)
    for (const key of this.cache.keys()) if (key < firstKey || key > lastKey) this.cache.delete(key)
    for (let key = firstKey; key <= lastKey; key++) {
      const first = Math.max(key * LOG_CHUNK_LINES, this.start)
      const last = Math.min((key + 1) * LOG_CHUNK_LINES, end)
      let cached = this.cache.get(key)
      if (!cached || cached.first !== first || cached.end !== last) {
        const rows: LogRow[] = []
        let headings = 0
        for (let abs = first; abs < last; abs++) {
          const row = this.rows[abs - this.start]
          if (!row || row.inSummary) continue
          rows.push(row)
          if (row.kind === 'heading') headings++
        }
        cached = { first, end: last, chunk: rows.length ? { key, rows, headings } : null }
        this.cache.set(key, cached)
      }
      if (cached.chunk) out.push(cached.chunk)
    }
    return out
  }

  /** Lines of the final summary block. */
  summary(): LogRow[] {
    const out: LogRow[] = []
    for (const row of this.rows) if (row?.inSummary) out.push(row)
    return out
  }
}
