<script setup lang="ts">
import { computed, onMounted, ref, toRef, watch } from 'vue'
import type { CellValue, QueryColumn } from '@shared/types'
import { invokeSilent } from '@renderer/api'
import ResultGrid from '@renderer/components/common/ResultGrid.vue'
import ApplyErrorBanner from '@renderer/components/data/ApplyErrorBanner.vue'
import EditableGrid from '@renderer/components/data/EditableGrid.vue'
import RowEditActions from '@renderer/components/data/RowEditActions.vue'
import { commitRows, sortRows } from '@renderer/components/data/rowEditing'
import { isApplyShortcut, useRowEditor } from '@renderer/components/data/useRowEditor'
import {
  decideEditability,
  payloadColumns,
  resultSource,
  type Editability
} from './resultEditability'

/**
 * One query result set. When its statement is a plain SELECT of exactly one
 * base table and the result carries its whole primary key it can be edited
 * like the table data view (Navicat behaviour); otherwise it stays read-only
 * and says why. Edits are written by key, so a truncated result is still
 * safe to edit.
 */
const props = defineProps<{
  connectionId: string
  /** Statement that produced the result: editability is decided from its FROM clause. */
  sql: string
  columns: QueryColumn[]
  rows: CellValue[][]
  truncated: boolean
}>()

const emit = defineEmits<{ dirty: [value: boolean] }>()

const editor = useRowEditor(toRef(props, 'columns'))
const { rows: gridRows, selected, active, applying, applyError, pending, dirty } = editor
editor.reset(props.rows)

/** Statement stage runs synchronously: most read-only results never touch the server. */
const source = resultSource(props.columns, props.sql)
const editability = ref<Editability | null>(
  source.ok ? null : { editable: false, reason: source.reason }
)
const checking = computed(() => editability.value === null)
const editable = computed(() => editability.value?.editable === true)
const keyColumns = computed(() => (editability.value?.editable ? editability.value.keyColumns : []))
const loadedCount = computed(() => gridRows.value.filter((r) => r.original).length)
const readOnlyReason = computed(() =>
  editability.value && !editability.value.editable ? editability.value.reason : ''
)
const target = computed(() =>
  editability.value?.schema ? `${editability.value.schema}.${editability.value.table}` : null
)

async function checkEditability(): Promise<void> {
  if (!source.ok) return
  try {
    const structure = await invokeSilent(
      'db:tableStructure',
      props.connectionId,
      source.source.schema,
      source.source.table
    )
    editability.value = decideEditability(props.columns, source.source, structure, props.rows)
  } catch {
    editability.value = decideEditability(props.columns, source.source, null)
  }
}

/* Client-side sort, like the read-only grid: edits follow their rows by uid. */
const sort = ref<{ column: string; direction: 'ASC' | 'DESC' } | null>(null)
const initialOrder = new Map(gridRows.value.map((r, i) => [r.uid, i]))

function toggleSort(column: string): void {
  const col = props.columns.findIndex((c) => c.name === column)
  if (col < 0) return
  if (sort.value?.column !== column) sort.value = { column, direction: 'ASC' }
  else if (sort.value.direction === 'ASC') sort.value = { column, direction: 'DESC' }
  else sort.value = null
  gridRows.value = sort.value
    ? sortRows(gridRows.value, col, sort.value.direction)
    : [...gridRows.value].sort(
        (a, b) => (initialOrder.get(a.uid) ?? Infinity) - (initialOrder.get(b.uid) ?? Infinity)
      )
}

async function applyChanges(): Promise<boolean> {
  const state = editability.value
  if (!state?.editable) return false
  const applied = await editor.apply(
    { connectionId: props.connectionId, schema: state.schema, table: state.table },
    payloadColumns(props.columns),
    state.primaryKey
  )
  if (!applied) return false
  // Generated ids fill the key the user left empty, only when that key is the AUTO_INCREMENT column.
  const generated = applied.changes.flatMap((c, i) =>
    c.kind === 'insert' ? [applied.result.insertIds?.[i] ?? null] : []
  )
  const idColumn = state.generatedKeyColumn
    ? props.columns.findIndex((c) => c.name === state.generatedKeyColumn)
    : -1
  gridRows.value = commitRows(gridRows.value, generated, idColumn >= 0 ? idColumn : null)
  for (const row of gridRows.value)
    if (!initialOrder.has(row.uid)) initialOrder.set(row.uid, Infinity)
  return true
}

const grid = ref<InstanceType<typeof EditableGrid> | null>(null)

/** "Ir a la fila": selects the row (and cell) whose change failed. */
function locateApplyError(): void {
  const failure = applyError.value
  if (!failure?.uid) return
  selected.value = [failure.uid]
  active.value = { uid: failure.uid, col: failure.col ?? 0 }
  grid.value?.revealError()
}

function onKeydown(event: KeyboardEvent): void {
  if (!editable.value || !isApplyShortcut(event)) return
  event.preventDefault()
  event.stopPropagation()
  void applyChanges()
}

watch(dirty, (value) => emit('dirty', value))
onMounted(checkEditability)

defineExpose({ applyChanges, discard: editor.discard, dirty, editability })
</script>

<template>
  <div class="editable-result" @keydown="onKeydown">
    <div
      class="editable-result__bar nd-viewbar--rowedit"
      role="toolbar"
      aria-label="Edición del resultado"
      data-test="result-bar"
    >
      <span
        v-if="checking"
        class="nd-status-pill editable-result__chip"
        role="status"
        data-test="editability"
      >
        <v-progress-circular indeterminate size="10" width="1.5" />
        Comprobando si se puede editar…
      </span>
      <span
        v-else-if="editable"
        class="nd-status-pill nd-status-pill--accent editable-result__chip"
        role="status"
        :title="`Los cambios se aplican en ${target} por su clave primaria`"
        data-test="editability"
      >
        <v-icon icon="mdi-pencil-outline" size="13" aria-hidden="true" />
        <span class="editable-result__chip-text">Editable · {{ target }}</span>
      </span>
      <span
        v-else
        class="nd-status-pill editable-result__chip"
        role="status"
        :title="
          target
            ? `No se puede editar ${target}: ${readOnlyReason}`
            : `No se puede editar: ${readOnlyReason}`
        "
        data-test="editability"
      >
        <v-icon icon="mdi-lock-outline" size="13" aria-hidden="true" />
        <span class="editable-result__chip-text">Solo lectura · {{ readOnlyReason }}</span>
      </span>
      <template v-if="editable">
        <span class="nd-viewbar__sep" aria-hidden="true" />
        <RowEditActions
          :can-add="true"
          :can-delete="selected.length > 0"
          :can-set-null="!!active"
          :pending="pending"
          :applying="applying"
          @add="editor.addRow"
          @delete="editor.deleteSelected"
          @null="editor.setNull"
          @discard="editor.discard"
          @apply="applyChanges"
        />
      </template>
    </div>

    <ApplyErrorBanner
      v-if="applyError"
      :message="applyError.message"
      :can-locate="!!applyError.uid"
      @locate="locateApplyError"
      @close="applyError = null"
    />

    <div class="editable-result__grid">
      <ResultGrid v-if="!source.ok" :columns="columns" :rows="props.rows" :truncated="truncated" />
      <template v-else>
        <EditableGrid
          ref="grid"
          v-model:selected="selected"
          v-model:active="active"
          :columns="columns"
          :rows="gridRows"
          :primary-key="keyColumns"
          :sort="sort"
          :readonly="!editable"
          :error-row="applyError?.uid ?? null"
          :error-col="applyError?.col ?? null"
          @sort="toggleSort"
          @edit="editor.onEdit"
        />
      </template>
    </div>
    <div v-if="source.ok" class="editable-result__footer" data-test="result-footer">
      <span class="nd-mono">{{ loadedCount }}</span> filas
      <span v-if="truncated" class="editable-result__truncated">· resultado truncado</span>
    </div>
  </div>
</template>

<style scoped src="../data/viewChrome.css"></style>
<style scoped>
.editable-result {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.editable-result__bar {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 2px;
  min-height: 40px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--nd-hairline);
}
.editable-result__chip {
  /* The bar wraps before this shrinks; it only ellipsizes when alone on a line. */
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}
.editable-result__chip-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.editable-result__grid {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}
.editable-result__footer {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  height: 28px;
  padding: 0 12px;
  border-top: 1px solid var(--nd-border);
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.editable-result__truncated {
  color: var(--nd-warning);
}
</style>
