import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Tiny durable JSON document store: reads once, keeps the document in memory
 * and writes atomically (temp file + rename) on every save.
 */
export class JsonStore<T extends object> {
  private data: T

  constructor(
    readonly filePath: string,
    private readonly defaults: () => T,
    private readonly migrate: (raw: unknown) => T = (raw) => raw as T
  ) {
    this.data = this.load()
  }

  private load(): T {
    if (!existsSync(this.filePath)) return this.defaults()
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'))
      return { ...this.defaults(), ...this.migrate(raw) }
    } catch (err) {
      const backup = `${this.filePath}.corrupt-${Date.now()}`
      try {
        renameSync(this.filePath, backup)
      } catch {
        /* ignore */
      }
      console.error(`electrondb: could not parse ${this.filePath}, moved to ${backup}`, err)
      return this.defaults()
    }
  }

  get(): T {
    return this.data
  }

  update(mutator: (draft: T) => void): T {
    mutator(this.data)
    this.save()
    return this.data
  }

  replace(next: T): T {
    this.data = next
    this.save()
    return this.data
  }

  save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    renameSync(tmp, this.filePath)
  }
}
