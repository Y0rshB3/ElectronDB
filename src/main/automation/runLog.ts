import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Human-readable per-run log file (see @shared/jobLog for the line format).
 * Only lifecycle information is written here (steps, object names, row
 * counts, sizes, output paths, error messages) — never SQL text, row data or
 * credentials.
 */
export class RunLog {
  private ready = false

  constructor(readonly path: string) {}

  /** Appends one already formatted line. */
  write(line: string): void {
    try {
      if (!this.ready) {
        mkdirSync(dirname(this.path), { recursive: true })
        this.ready = true
      }
      appendFileSync(this.path, `${line}\n`)
    } catch {
      /* a broken log must never abort a run */
    }
  }
}
