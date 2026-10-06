import type { RowChange } from './types'

/**
 * Message contract for a failed db:applyRowChanges batch. IPC errors only
 * carry their message, so main writes it with `formatRowChangeFailure` and the
 * renderer reads back which change (and column) failed with
 * `parseRowChangeFailure` to point at the row in the grid.
 */

export const ROW_CHANGE_ROLLBACK = 'No se aplicó ningún cambio: se deshicieron todos'

const KIND_LABEL: Record<RowChange['kind'], string> = {
  insert: 'fila nueva',
  update: 'fila modificada',
  delete: 'fila eliminada'
}

/** `index` is 0-based; `reason` is a lower-case Spanish clause without final period. */
export function formatRowChangeFailure(
  index: number,
  total: number,
  kind: RowChange['kind'],
  reason: string
): string {
  return `Falló el cambio ${index + 1} de ${total} (${KIND_LABEL[kind]}): ${reason}. ${ROW_CHANGE_ROLLBACK}.`
}

export interface RowChangeFailure {
  /** 0-based index of the failed change in the request. */
  index: number
  /** Table column named by the error («col»), when there is one. */
  column: string | null
  reason: string
}

const FAILURE = /^Falló el cambio (\d+) de \d+ \([^)]*\): ([\s\S]*)\. No se aplicó ningún cambio/

export function parseRowChangeFailure(message: string): RowChangeFailure | null {
  const match = FAILURE.exec(message)
  if (!match) return null
  const reason = match[2]
  return {
    index: Number(match[1]) - 1,
    column: /columna «([^»]+)»/.exec(reason)?.[1] ?? null,
    reason
  }
}
