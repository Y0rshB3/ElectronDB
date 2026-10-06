import { ROW_SEPARATOR } from './format'

const RS = ROW_SEPARATOR[0]
const LF = ROW_SEPARATOR[1]
const EMPTY: Buffer[] = []

/**
 * Splits a stream of bytes into row tuples separated by `\x1e\n`.
 * Works on raw bytes so a separator (or a multi-byte UTF-8 character)
 * falling across two pushed chunks is handled correctly. Rows are decoded
 * as UTF-8 only once their boundary is known.
 */
export class RowSplitter {
  private parts: Buffer[] = EMPTY
  private pendingLength = 0
  private pendingEndsWithRs = false

  /** Feeds bytes; returns every complete row found so far. */
  push(chunk: Buffer): string[] {
    const rows: string[] = []
    if (chunk.length === 0) return rows
    let start = 0
    if (this.pendingEndsWithRs && chunk[0] === LF) {
      // Separator split across the boundary: pending minus its trailing RS is a full row.
      rows.push(this.takePending(this.pendingLength - 1))
      start = 1
    }
    let idx = chunk.indexOf(ROW_SEPARATOR, start)
    while (idx !== -1) {
      const slice = chunk.subarray(start, idx)
      rows.push(this.pendingLength > 0 ? this.takePendingWith(slice) : slice.toString('utf8'))
      start = idx + ROW_SEPARATOR.length
      idx = chunk.indexOf(ROW_SEPARATOR, start)
    }
    if (start < chunk.length) {
      const rest = Buffer.from(chunk.subarray(start))
      if (this.parts === EMPTY) this.parts = []
      this.parts.push(rest)
      this.pendingLength += rest.length
      this.pendingEndsWithRs = rest[rest.length - 1] === RS
    }
    return rows
  }

  /** Returns the trailing row (no separator after the last row), or null when nothing is pending. */
  flush(): string | null {
    if (this.pendingLength === 0) return null
    return this.takePending(this.pendingLength)
  }

  private takePending(length: number): string {
    const joined =
      this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.pendingLength)
    this.reset()
    return joined.toString('utf8', 0, length)
  }

  private takePendingWith(tail: Buffer): string {
    const joined = Buffer.concat([...this.parts, tail], this.pendingLength + tail.length)
    this.reset()
    return joined.toString('utf8')
  }

  private reset(): void {
    this.parts = EMPTY
    this.pendingLength = 0
    this.pendingEndsWithRs = false
  }
}

/** Joins tuples with the row separator (no trailing separator), as stored inside a chunk. */
export function joinRows(rows: readonly string[]): Buffer {
  const parts: Buffer[] = []
  rows.forEach((row, i) => {
    if (i > 0) parts.push(ROW_SEPARATOR)
    parts.push(Buffer.from(row, 'utf8'))
  })
  return Buffer.concat(parts)
}
