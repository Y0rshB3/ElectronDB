<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { CellValue, ColumnInfo, QueryColumn, StorageClass } from '@shared/types'
import { useColumnWidthsStore } from '@renderer/stores/columnWidths'
import { columnKindOf, type ColumnKind } from './columnKind'
import { displayCell, isCellChanged, type ActiveCell, type EditableRow } from './rowEditing'
import TemporalInput from './TemporalInput.vue'
import { temporalSpec, type TemporalSpec } from './temporal'

const props = defineProps<{
  columns: QueryColumn[]
  rows: EditableRow[]
  primaryKey: string[]
  sort: { column: string; direction: 'ASC' | 'DESC' } | null
  readonly?: boolean
  /** Row number offset for the # column (page offset). */
  offset?: number
  /** Row (and cell) whose change made the last apply fail. */
  errorRow?: string | null
  errorCol?: number | null
  /** Declared column info aligned with `columns` (nullability, datetime(3)...), when known. */
  columnInfo?: (ColumnInfo | null | undefined)[]
  /**
   * Remembers column widths under this key (connection + table) across reloads and
   * reopening; without it widths live as long as the grid.
   */
  widthKey?: string | null
  /**
   * SQLite: values are dynamically typed, so cells use the plain text editor
   * (no date pickers that would reject a stored integer or real).
   */
  plainEditors?: boolean
}>()

const emit = defineEmits<{
  sort: [column: string]
  edit: [uid: string, col: number, value: CellValue]
}>()

const selected = defineModel<string[]>('selected', { default: () => [] })
const active = defineModel<ActiveCell | null>('active', { default: null })

/** Presentation only: numbers right aligned in mono, dates in mono. */
const kinds = computed<ColumnKind[]>(() => props.columns.map(columnKindOf))
/** Date/time picker per column (DATE, DATETIME/TIMESTAMP with fsp, TIME, YEAR). */
const specs = computed<(TemporalSpec | null)[]>(() =>
  props.columns.map((c, i) =>
    props.plainEditors ? null : temporalSpec(c.type, props.columnInfo?.[i]?.columnType)
  )
)

const STORAGE_LABELS: Record<StorageClass, string> = {
  null: 'NULL',
  integer: 'INTEGER',
  real: 'REAL',
  text: 'TEXT',
  blob: 'BLOB'
}

/**
 * A locked column (SQLite rowid, generated column) is never edited on a
 * loaded row; a new row may set its rowid.
 */
function isLocked(row: EditableRow, col: number): boolean {
  const locked = props.columns[col]?.locked
  return !!locked && (locked !== 'rowid' || !!row.original)
}

/** Tooltip: the value, plus its SQLite storage class and why it is locked. */
function cellTitle(row: EditableRow, col: number): string {
  const text = displayCell(row.values[col])
  const parts = [text]
  const storage = row.storage?.[col]
  if (storage && !isCellChanged(row, col)) parts.push(`Almacenado como ${STORAGE_LABELS[storage]}`)
  const locked = props.columns[col]?.locked
  if (locked && isLocked(row, col))
    parts.push(
      locked === 'rowid' ? 'rowid: identifica la fila (no editable)' : `No editable: ${locked}`
    )
  return parts.join(' · ')
}
const nullable = (col: number): boolean => props.columnInfo?.[col]?.nullable ?? true

/* ---------- column widths (drag the header edge, double-click to fit) ---------- */

const MIN_COL_WIDTH = 48
const MAX_FIT_WIDTH = 600
const widthsStore = useColumnWidthsStore()
const localWidths = ref<Record<string, number>>({})
const widths = computed<Record<string, number>>(() =>
  props.widthKey ? widthsStore.get(props.widthKey) : localWidths.value
)
function setWidth(name: string, width: number): void {
  const w = Math.max(MIN_COL_WIDTH, Math.round(width))
  if (props.widthKey) widthsStore.set(props.widthKey, name, w)
  else localWidths.value = { ...localWidths.value, [name]: w }
}
/** Inline sizing of a resized column (th and td); untouched columns keep content sizing. */
const colStyles = computed(() =>
  props.columns.map((c) => {
    const w = widths.value[c.name]
    return w
      ? { width: `${w}px`, minWidth: `${w}px`, maxWidth: `${w}px`, '--col-w': `${w - 24}px` }
      : undefined
  })
)

function startResize(event: PointerEvent, col: number): void {
  const th = (event.currentTarget as HTMLElement).closest('th')
  if (!th) return
  const handle = event.currentTarget as HTMLElement
  try {
    handle.setPointerCapture?.(event.pointerId)
  } catch {
    /* synthetic or already released pointer: dragging still works while over the handle */
  }
  const startX = event.clientX
  const startW = th.getBoundingClientRect().width
  const name = props.columns[col].name
  resizing.value = true
  const onMove = (e: PointerEvent): void => setWidth(name, startW + e.clientX - startX)
  const onUp = (): void => {
    resizing.value = false
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('pointercancel', onUp)
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('pointercancel', onUp)
}

/** Double-click on the edge: fit the header and the rendered values (capped). */
function autoFit(col: number): void {
  const el = root.value
  if (!el) return
  let content = 0
  el.querySelectorAll<HTMLElement>(`td[data-col="${col}"] .cell-value`).forEach((v) => {
    content = Math.max(content, v.scrollWidth)
  })
  const header = el.querySelector<HTMLElement>(`th[data-col="${col}"] .header-cell`)
  content = Math.max(content, (header?.scrollWidth ?? 0) + 8)
  setWidth(props.columns[col].name, Math.min(MAX_FIT_WIDTH, content + 26))
}
const resizing = ref(false)

const editing = ref<ActiveCell | null>(null)
const draft = ref('')
/** True once the user typed in the editor: lets an emptied NULL cell become '' instead of staying NULL. */
const typed = ref(false)
const inputRef = ref<HTMLInputElement[] | HTMLInputElement | null>(null)
type TemporalEditor = InstanceType<typeof TemporalInput>
const temporalRef = ref<TemporalEditor[] | TemporalEditor | null>(null)
let lastClicked: number | null = null

function isEditing(uid: string, col: number): boolean {
  return editing.value?.uid === uid && editing.value.col === col
}

function isActive(uid: string, col: number): boolean {
  return active.value?.uid === uid && active.value.col === col
}

function selectRow(event: MouseEvent, index: number): void {
  const uid = props.rows[index].uid
  if (event.shiftKey && lastClicked !== null) {
    const [a, b] = [Math.min(lastClicked, index), Math.max(lastClicked, index)]
    selected.value = props.rows.slice(a, b + 1).map((r) => r.uid)
  } else if (event.metaKey || event.ctrlKey) {
    selected.value = selected.value.includes(uid)
      ? selected.value.filter((u) => u !== uid)
      : [...selected.value, uid]
  } else {
    selected.value = [uid]
  }
  lastClicked = index
}

function clickCell(uid: string, col: number, index: number): void {
  active.value = { uid, col }
  if (!selected.value.includes(uid)) selected.value = [uid]
  lastClicked = index
}

async function startEdit(uid: string, col: number): Promise<void> {
  const row = props.rows.find((r) => r.uid === uid)
  if (props.readonly || !row || row.deleted || isLocked(row, col)) return
  active.value = { uid, col }
  editing.value = { uid, col }
  const value = row.values[col]
  draft.value = value === null ? '' : displayCell(value)
  typed.value = false
  await nextTick()
  if (specs.value[col]) return // TemporalInput focuses itself
  const el = Array.isArray(inputRef.value) ? inputRef.value[0] : inputRef.value
  el?.focus()
  el?.select()
}

/** Commits a value decided by the temporal editor (validated literal, or null). */
function commitValue(value: string | null): void {
  if (!editing.value) return
  const { uid, col } = editing.value
  const row = props.rows.find((r) => r.uid === uid)
  editing.value = null
  if (!row) return
  const current = row.values[col]
  if (value === null ? current === null : current !== null && displayCell(current) === value) return
  emit('edit', uid, col, value)
}

function onTemporalCommit(value: string | null): void {
  commitValue(value)
  move(1, 0)
  root.value?.focus()
}

/** Leaving a temporal editor commits only valid text; invalid text keeps the editor open. */
function onTemporalLeave(): void {
  const editor = Array.isArray(temporalRef.value) ? temporalRef.value[0] : temporalRef.value
  if (!editor) return commit()
  editor.tryCommit()
}

function onTemporalKey(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    onTemporalLeave()
    return
  }
  if (event.key === 'Tab') {
    event.preventDefault()
    event.stopPropagation()
    const editor = Array.isArray(temporalRef.value) ? temporalRef.value[0] : temporalRef.value
    if (editor?.tryCommit() ?? true) move(0, event.shiftKey ? -1 : 1)
    return
  }
  event.stopPropagation()
}

function cancelTemporal(): void {
  cancel()
  root.value?.focus()
}

function commit(): void {
  if (!editing.value) return
  const { uid, col } = editing.value
  const row = props.rows.find((r) => r.uid === uid)
  editing.value = null
  if (!row) return
  const current = row.values[col]
  if (current !== null && displayCell(current) === draft.value) return
  if (current === null && draft.value === '' && !typed.value) return
  emit('edit', uid, col, draft.value)
}

function cancel(): void {
  editing.value = null
}

function move(dRow: number, dCol: number): void {
  if (!active.value || !props.rows.length) return
  const idx = props.rows.findIndex((r) => r.uid === active.value!.uid)
  const rowIdx = Math.min(Math.max(idx + dRow, 0), props.rows.length - 1)
  const col = Math.min(Math.max(active.value.col + dCol, 0), props.columns.length - 1)
  active.value = { uid: props.rows[rowIdx].uid, col }
  selected.value = [props.rows[rowIdx].uid]
}

function onInputKey(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    // Commit the cell and let Cmd+S bubble so the view applies the changes.
    commit()
    return
  }
  event.stopPropagation()
  if (event.key === 'Enter') {
    event.preventDefault()
    commit()
    move(1, 0)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
  } else if (event.key === 'Tab') {
    event.preventDefault()
    commit()
    move(0, event.shiftKey ? -1 : 1)
  }
}

function onGridKey(event: KeyboardEvent): void {
  if (editing.value || !active.value) return
  const moves: Record<string, [number, number]> = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1]
  }
  if (moves[event.key]) {
    event.preventDefault()
    move(...moves[event.key])
  } else if (event.key === 'Enter' || event.key === 'F2') {
    event.preventDefault()
    void startEdit(active.value.uid, active.value.col)
  }
}

function sortIcon(column: string): string | null {
  if (props.sort?.column !== column) return null
  return props.sort.direction === 'ASC' ? 'mdi-arrow-up' : 'mdi-arrow-down'
}

function ariaSort(column: string): 'ascending' | 'descending' | 'none' {
  if (props.sort?.column !== column) return 'none'
  return props.sort.direction === 'ASC' ? 'ascending' : 'descending'
}

const root = ref<HTMLElement | null>(null)

/** Brings the failed row into view when an apply error points at it. */
async function revealError(): Promise<void> {
  if (!props.errorRow) return
  await nextTick()
  const el =
    root.value?.querySelector('tr.row-error td.cell-error') ??
    root.value?.querySelector('tr.row-error')
  el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
}
watch(() => [props.errorRow, props.errorCol], revealError)

defineExpose({ startEdit, revealError, autoFit })
</script>

<template>
  <div
    ref="root"
    class="editable-grid"
    tabindex="0"
    role="grid"
    :aria-rowcount="rows.length"
    @keydown="onGridKey"
  >
    <table>
      <thead>
        <tr>
          <th class="col-index" scope="col">#</th>
          <th
            v-for="(col, c) in columns"
            :key="c"
            scope="col"
            :class="[`kind-${kinds[c]}`, { 'is-sorted': !!sortIcon(col.name) }]"
            :aria-sort="ariaSort(col.name)"
            :title="`${col.name} · ${col.type}`"
            :style="colStyles[c]"
            :data-col="c"
            :data-test="`header-${col.name}`"
            @click="!resizing && emit('sort', col.name)"
          >
            <span class="header-cell">
              <v-icon
                v-if="primaryKey.includes(col.name)"
                icon="mdi-key-variant"
                size="13"
                class="header-cell__key"
                aria-label="Clave primaria"
              />
              <span class="header-cell__name">{{ col.name }}</span>
              <v-icon
                v-if="sortIcon(col.name)"
                :icon="sortIcon(col.name)!"
                size="13"
                class="header-cell__sort"
              />
            </span>
            <span
              class="col-resizer"
              role="separator"
              aria-orientation="vertical"
              :aria-label="`Redimensionar ${col.name} (doble clic: ajustar al contenido)`"
              :data-test="`resize-${col.name}`"
              @pointerdown.stop.prevent="startResize($event, c)"
              @click.stop
              @dblclick.stop="autoFit(c)"
            />
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(row, index) in rows"
          :key="row.uid"
          :class="{
            'row-selected': selected.includes(row.uid),
            'row-deleted': row.deleted,
            'row-new': !row.original,
            'row-error': !!errorRow && row.uid === errorRow
          }"
          :data-test="`row-${index}`"
        >
          <td class="col-index" @click="selectRow($event, index)">
            {{ row.original ? (offset ?? 0) + index + 1 : '*' }}
          </td>
          <td
            v-for="(col, c) in columns"
            :key="c"
            :class="[
              `kind-${kinds[c]}`,
              {
                'cell-changed': isCellChanged(row, c),
                'cell-active': isActive(row.uid, c),
                'cell-null': row.values[c] === null,
                'cell-editing': isEditing(row.uid, c),
                'cell-locked': isLocked(row, c),
                'cell-error': !!errorRow && row.uid === errorRow && errorCol === c
              }
            ]"
            :style="colStyles[c]"
            :data-col="c"
            :data-test="`cell-${index}-${c}`"
            @click="clickCell(row.uid, c, index)"
            @dblclick="startEdit(row.uid, c)"
          >
            <!--
              The value stays in the flow (hidden while editing) so the column keeps
              its width and the row its height; the editor overlays the cell box.
            -->
            <span
              class="cell-value"
              :class="{ 'is-sizer': isEditing(row.uid, c) }"
              :title="isEditing(row.uid, c) ? undefined : cellTitle(row, c)"
              :aria-hidden="isEditing(row.uid, c) || undefined"
              >{{ displayCell(row.values[c]) }}</span
            >
            <span
              v-if="isEditing(row.uid, c)"
              class="cell-editor"
              :class="{ 'is-temporal': !!specs[c] }"
              data-test="cell-editor"
            >
              <TemporalInput
                v-if="specs[c]"
                ref="temporalRef"
                v-model="draft"
                :spec="specs[c]!"
                :nullable="nullable(c)"
                :label="`Editar ${col.name}`"
                :placeholder="row.values[c] === null ? 'NULL' : undefined"
                autofocus
                @commit="onTemporalCommit"
                @cancel="cancelTemporal"
                @leave="onTemporalLeave"
                @keydown="onTemporalKey"
              />
              <input
                v-else
                ref="inputRef"
                v-model="draft"
                class="cell-input"
                :aria-label="`Editar ${col.name}`"
                data-test="cell-input"
                :placeholder="row.values[c] === null ? 'NULL' : undefined"
                @input="typed = true"
                @keydown="onInputKey"
                @blur="commit"
              />
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.editable-grid {
  --grid-row-h: var(--nd-row-h);
  /* Amber glass for pending edits (no dedicated token: derived from --nd-warning). */
  --grid-changed-bg: color-mix(in srgb, var(--nd-warning) 13%, transparent);
  --grid-changed-ring: color-mix(in srgb, var(--nd-warning) 45%, transparent);

  overflow: auto;
  height: 100%;
  outline: none;
  font-family: var(--nd-font-ui);
  font-size: var(--nd-fs-dense);
  color: var(--nd-text);
}
.editable-grid:focus-visible {
  box-shadow: none;
}
table {
  border-collapse: separate;
  border-spacing: 0;
  min-width: 100%;
}
th,
td {
  border-right: 1px solid var(--nd-hairline);
  border-bottom: 1px solid var(--nd-hairline);
  padding: 0 12px;
  white-space: nowrap;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  height: var(--grid-row-h);
  text-align: left;
  transition: background-color var(--nd-dur-fast) var(--nd-ease);
}
th:last-child,
td:last-child {
  border-right: none;
}
/*
 * Column sizing (layout only): real columns shrink to their content and a
 * trailing pseudo cell absorbs the spare width, instead of the browser
 * spreading it evenly across every column.
 */
th:not(.col-index),
td:not(.col-index) {
  width: 1%;
  min-width: 56px;
}
tr::after {
  content: '';
  display: table-cell;
  border-bottom: 1px solid var(--nd-hairline);
}
thead tr::after {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--nd-bg-panel);
  border-bottom: none;
  box-shadow: inset 0 -1px 0 var(--nd-border);
}
tbody tr:hover::after {
  background: var(--nd-hover);
}
tbody tr.row-selected::after {
  background: var(--nd-selected);
}
tbody tr.row-new::after {
  background: var(--nd-success-soft);
}
tbody tr.row-deleted::after {
  background: var(--nd-error-soft);
}
.cell-value {
  display: inline-block;
  max-width: var(--col-w, 320px);
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
}

/* ---- Column resize handle ---- */
.col-resizer {
  position: absolute;
  top: 0;
  right: -3px;
  z-index: 2;
  width: 7px;
  height: 100%;
  cursor: col-resize;
  touch-action: none;
}
.col-resizer::after {
  content: '';
  position: absolute;
  top: 25%;
  bottom: 25%;
  left: 3px;
  width: 1px;
  background: transparent;
  transition: background var(--nd-dur) var(--nd-ease);
}
th:hover .col-resizer::after {
  background: var(--nd-border-strong);
}
.col-resizer:hover::after,
.col-resizer:active::after {
  background: var(--nd-accent);
}

/* ---- Header ---- */
th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--nd-bg-panel);
  box-shadow: inset 0 -1px 0 var(--nd-border);
  border-bottom: none;
  color: var(--nd-text-2);
  font-size: var(--nd-fs-small);
  font-weight: 600;
  cursor: pointer;
  user-select: none;
}
th:hover {
  color: var(--nd-text);
  background: color-mix(in srgb, var(--nd-bg-panel) 100%, var(--nd-text) 4%);
}
th.is-sorted {
  color: var(--nd-text);
}
.header-cell {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
}
.header-cell__name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.header-cell__key {
  color: var(--nd-warning);
  opacity: 0.9;
}
.header-cell__sort {
  color: var(--nd-accent);
}
th.kind-number {
  text-align: right;
}

/* ---- Cells ---- */
td.kind-number {
  font-family: var(--nd-font-mono);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
td.kind-temporal {
  font-family: var(--nd-font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--nd-text-2);
}
td.kind-number,
td.kind-temporal {
  font-size: var(--nd-fs-small);
}
tbody tr:hover td {
  background: var(--nd-hover);
}

/* ---- Row number gutter ---- */
.col-index {
  width: 52px;
  min-width: 52px;
  padding: 0 10px 0 8px;
  text-align: right;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  font-variant-numeric: tabular-nums;
  color: var(--nd-text-muted);
  cursor: pointer;
  user-select: none;
  position: sticky;
  left: 0;
  background: var(--nd-bg-panel);
  border-right: 1px solid var(--nd-border);
}
th.col-index {
  z-index: 2;
  font-family: var(--nd-font-ui);
  font-size: var(--nd-fs-small);
  color: var(--nd-text-muted);
}
tbody tr:hover .col-index {
  color: var(--nd-text-2);
  background: color-mix(in srgb, var(--nd-bg-panel) 100%, var(--nd-text) 4%);
}

/* ---- Row states ---- */
.row-selected td {
  background: var(--nd-selected);
}
tbody tr.row-selected:hover td {
  background: color-mix(in srgb, var(--nd-selected) 100%, var(--nd-text) 3%);
}
.row-selected .col-index,
tbody tr.row-selected:hover .col-index {
  color: var(--nd-accent);
  background: color-mix(in srgb, var(--nd-bg-panel) 100%, var(--nd-accent) 10%);
  box-shadow: inset 2px 0 0 var(--nd-accent);
}
.row-new td {
  background: var(--nd-success-soft);
}
.row-new .col-index {
  color: var(--nd-success);
  box-shadow: inset 2px 0 0 var(--nd-success);
}
.row-deleted td {
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--nd-error) 70%, transparent);
  color: var(--nd-text-muted);
  background: var(--nd-error-soft);
}
.row-deleted .col-index {
  color: var(--nd-error);
  box-shadow: inset 2px 0 0 var(--nd-error);
}
/* Change that made the last apply fail. */
.row-error .col-index {
  color: var(--nd-error);
  box-shadow: inset 3px 0 0 var(--nd-error);
}
tbody tr.row-error td:not(.cell-changed):not(.col-index) {
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--nd-error) 45%, transparent),
    inset 0 -1px 0 color-mix(in srgb, var(--nd-error) 45%, transparent);
}
tbody tr.row-error td.cell-error {
  background: var(--nd-error-soft) !important;
  box-shadow: inset 0 0 0 2px var(--nd-error);
}

/* ---- Cell states ---- */
td.cell-changed {
  position: relative;
  background: var(--grid-changed-bg) !important;
  box-shadow: inset 0 0 0 1px var(--grid-changed-ring);
}
td.cell-changed::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  border-style: solid;
  border-width: 0 6px 6px 0;
  border-color: transparent var(--nd-warning) transparent transparent;
}
td.cell-active {
  box-shadow:
    inset 0 0 0 1px var(--nd-accent),
    inset 0 0 12px rgba(var(--nd-accent-rgb), 0.18);
}
td.cell-changed.cell-active {
  box-shadow:
    inset 0 0 0 1px var(--nd-accent),
    inset 0 0 0 2px var(--grid-changed-ring);
}
td.cell-null .cell-value {
  font-style: italic;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
td.cell-locked .cell-value {
  color: var(--nd-text-muted);
}
td.cell-editing {
  /* Same padding as any cell: the hidden value keeps the column width unchanged. */
  background: var(--nd-bg-input) !important;
  box-shadow: var(--nd-glow);
  position: relative;
  z-index: 2;
  overflow: visible;
}
.cell-value.is-sizer {
  visibility: hidden;
}
.cell-editor {
  position: absolute;
  inset: 0;
  display: flex;
}
/* Room for the calendar button without squeezing the value: it overhangs the next cell. */
.cell-editor.is-temporal {
  right: auto;
  width: calc(100% + 26px);
  background: var(--nd-bg-raised);
  box-shadow: inset 0 0 0 1px var(--nd-accent);
  border-radius: 0 var(--nd-radius-sm) var(--nd-radius-sm) 0;
}
.cell-input {
  width: 100%;
  height: 100%;
  padding: 0 12px;
  background: transparent;
  color: var(--nd-text);
  font: inherit;
  border: none;
  outline: none;
  box-shadow: inset 0 0 0 1px var(--nd-accent);
}
.cell-input::placeholder {
  color: var(--nd-text-muted);
  font-style: italic;
}
.cell-input:focus-visible {
  box-shadow: inset 0 0 0 1px var(--nd-accent);
}
</style>
