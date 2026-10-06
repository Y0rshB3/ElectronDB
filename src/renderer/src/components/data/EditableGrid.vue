<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { CellValue, QueryColumn } from '@shared/types'
import { columnKind, type ColumnKind } from './columnKind'
import { displayCell, isCellChanged, type ActiveCell, type EditableRow } from './rowEditing'

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
}>()

const emit = defineEmits<{
  sort: [column: string]
  edit: [uid: string, col: number, value: CellValue]
}>()

const selected = defineModel<string[]>('selected', { default: () => [] })
const active = defineModel<ActiveCell | null>('active', { default: null })

/** Presentation only: numbers right aligned in mono, dates in mono. */
const kinds = computed<ColumnKind[]>(() => props.columns.map((c) => columnKind(c.type)))

const editing = ref<ActiveCell | null>(null)
const draft = ref('')
/** True once the user typed in the editor: lets an emptied NULL cell become '' instead of staying NULL. */
const typed = ref(false)
const inputRef = ref<HTMLInputElement[] | HTMLInputElement | null>(null)
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
  if (props.readonly || !row || row.deleted) return
  active.value = { uid, col }
  editing.value = { uid, col }
  const value = row.values[col]
  draft.value = value === null ? '' : displayCell(value)
  typed.value = false
  await nextTick()
  const el = Array.isArray(inputRef.value) ? inputRef.value[0] : inputRef.value
  el?.focus()
  el?.select()
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

defineExpose({ startEdit, revealError })
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
            :data-test="`header-${col.name}`"
            @click="emit('sort', col.name)"
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
                'cell-error': !!errorRow && row.uid === errorRow && errorCol === c
              }
            ]"
            :data-test="`cell-${index}-${c}`"
            @click="clickCell(row.uid, c, index)"
            @dblclick="startEdit(row.uid, c)"
          >
            <input
              v-if="isEditing(row.uid, c)"
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
            <span v-else class="cell-value" :title="displayCell(row.values[c])">{{
              displayCell(row.values[c])
            }}</span>
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
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
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
td.cell-editing {
  padding: 0;
  background: var(--nd-bg-input) !important;
  box-shadow: var(--nd-glow);
  position: relative;
  z-index: 0;
}
.cell-input {
  width: 100%;
  min-width: 96px;
  height: calc(var(--grid-row-h) - 1px);
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
