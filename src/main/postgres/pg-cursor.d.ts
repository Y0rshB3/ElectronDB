/** Minimal typings for pg-cursor 2.x (the package ships none). */
declare module 'pg-cursor' {
  import type { FieldDef, Submittable } from 'pg'

  interface CursorResult {
    command: string | null
    rowCount: number | null
    fields: FieldDef[]
  }

  interface CursorConfig {
    rowMode?: 'array'
    types?: { getTypeParser(oid: number, format?: string): (value: string) => unknown }
  }

  class Cursor<Row = unknown[]> implements Submittable {
    constructor(text: string, values?: unknown[] | null, config?: CursorConfig)
    submit(connection: unknown): void
    read(
      rowCount: number,
      callback: (err: Error | undefined, rows: Row[], result: CursorResult) => void
    ): void
    close(callback: (err?: Error) => void): void
  }

  export default Cursor
}
