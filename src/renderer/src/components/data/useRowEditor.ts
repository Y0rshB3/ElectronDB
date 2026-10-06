import { computed, ref, type Ref } from 'vue'
import { parseRowChangeFailure } from '@shared/rowChangeFailure'
import type { ApplyRowChangesResult, CellValue, QueryColumn, RowChange } from '@shared/types'
import { api } from '@renderer/api'
import { useConfirm } from '@renderer/composables/useConfirm'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import {
  buildRowChangeBatch,
  newRow,
  pendingCount,
  rowsFromPage,
  setCell,
  type ActiveCell,
  type EditableRow
} from './rowEditing'

export interface ApplyTarget {
  connectionId: string
  schema: string
  table: string
}

export interface AppliedChanges {
  changes: RowChange[]
  result: ApplyRowChangesResult
}

/** Why the last Aplicar failed, shown inline above the grid (not as a toast over it). */
export interface ApplyError {
  message: string
  /** Row of the failed change, when main said which one (see shared/rowChangeFailure). */
  uid: string | null
  /** Displayed column index named by the error, when there is one. */
  col: number | null
}

/**
 * Pending-edit state and actions shared by the grids that write rows back
 * (table data view, editable query results). The caller owns the columns and
 * decides what to do after a successful apply (reload or commit locally).
 */
export function useRowEditor(columns: Readonly<Ref<QueryColumn[]>>) {
  const { confirmDestructive } = useConfirm()
  const notify = useNotify()

  const rows = ref<EditableRow[]>([])
  const selected = ref<string[]>([])
  const active = ref<ActiveCell | null>(null)
  const applying = ref(false)
  const applyError = ref<ApplyError | null>(null)

  const pending = computed(() => pendingCount(rows.value))
  const dirty = computed(() => pending.value > 0)

  /** Replaces the rows with freshly loaded data, dropping selection and edits. */
  function reset(data: CellValue[][]): void {
    rows.value = rowsFromPage(data)
    selected.value = []
    active.value = null
    applyError.value = null
  }

  function onEdit(uid: string, col: number, value: CellValue): void {
    const row = rows.value.find((r) => r.uid === uid)
    if (row) setCell(row, col, value)
  }

  function addRow(): void {
    const row = newRow(columns.value.length)
    rows.value.push(row)
    selected.value = [row.uid]
    active.value = { uid: row.uid, col: 0 }
  }

  function deleteSelected(): void {
    const ids = new Set(selected.value)
    // Rows added in the UI are simply dropped; loaded rows are flagged.
    rows.value = rows.value.filter((r) => r.original || !ids.has(r.uid))
    for (const row of rows.value) if (ids.has(row.uid)) row.deleted = !row.deleted
  }

  function setNull(): void {
    const cell = active.value
    if (!cell) return
    const row = rows.value.find((r) => r.uid === cell.uid)
    if (!row || row.deleted) return
    if (columns.value[cell.col] && row.values[cell.col] !== null) setCell(row, cell.col, null)
  }

  function discard(): void {
    applyError.value = null
    rows.value = rows.value
      .filter((r) => r.original)
      .map((r) => ({ ...r, values: [...r.original!], touched: [], deleted: false }))
  }

  /**
   * Confirms (typed confirmation on production connections) and sends the
   * pending edits. `payloadColumns` and `primaryKey` name the real table
   * columns, which may differ from the displayed ones (query aliases).
   * Resolves null when nothing was written.
   */
  async function apply(
    target: ApplyTarget,
    payloadColumns: QueryColumn[],
    primaryKey: string[]
  ): Promise<AppliedChanges | null> {
    if (!dirty.value || applying.value) return null
    const { changes, rowIds } = buildRowChangeBatch(rows.value, payloadColumns, primaryKey)
    if (!changes.length) return null
    const ok = await confirmDestructive({
      connectionId: target.connectionId,
      title: 'Aplicar cambios',
      message: `Se aplicarán ${changes.length} cambio(s) en ${target.schema}.${target.table}.`,
      alwaysAsk: false
    })
    if (!ok) return null
    applying.value = true
    applyError.value = null
    try {
      // Silent: the failure is shown inline next to the grid, with the row it concerns.
      const result = await api.invokeSilent(
        'db:applyRowChanges',
        target.connectionId,
        target.schema,
        target.table,
        changes,
        { confirmProduction: true }
      )
      notify.success(`${result.applied} cambio(s) aplicados`)
      return { changes, result }
    } catch (err) {
      // Keep the pending edits so the user can fix them and apply again.
      const message = errorMessage(err)
      const failure = parseRowChangeFailure(message)
      const column = failure?.column?.toLowerCase()
      const col = column ? payloadColumns.findIndex((c) => c.name.toLowerCase() === column) : -1
      applyError.value = {
        message,
        uid: failure ? (rowIds[failure.index] ?? null) : null,
        col: col >= 0 ? col : null
      }
      return null
    } finally {
      applying.value = false
    }
  }

  return {
    rows,
    selected,
    active,
    applying,
    applyError,
    pending,
    dirty,
    reset,
    onEdit,
    addRow,
    deleteSelected,
    setNull,
    discard,
    apply
  }
}

/** True for Cmd+S / Ctrl+S. */
export function isApplyShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's'
}
