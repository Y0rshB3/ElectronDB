<script setup lang="ts">
import { computed } from 'vue'
import type { CellValue, QueryColumn } from '@shared/types'
import { isNumericKind } from '@renderer/utils/columnMeta'

const props = defineProps<{
  columns: QueryColumn[]
  rows: CellValue[][]
  truncated?: boolean
  height?: string | number
}>()

/** MySQL numeric column types: the fallback when the driver sends no `typeKind`. */
const NUMERIC_TYPE = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|float|double|year)\b/i

/** Numeric columns are right aligned in tabular monospace. */
const numeric = computed(() =>
  props.columns.map((c) =>
    c.typeKind ? isNumericKind(c.typeKind) : NUMERIC_TYPE.test(c.type ?? '')
  )
)

const headers = computed(() => [
  { title: '#', key: '__index', width: 56, sortable: false, align: 'end' as const },
  ...props.columns.map((c, i) => ({
    title: c.name,
    key: `c${i}`,
    sortable: true,
    align: numeric.value[i] ? ('end' as const) : ('start' as const)
  }))
])

const columnIndexes = computed(() => props.columns.map((_, i) => i))

const items = computed(() =>
  props.rows.map((row, idx) => {
    const item: Record<string, CellValue> = { __index: idx + 1 }
    row.forEach((cell, i) => (item[`c${i}`] = cell))
    return item
  })
)

function display(value: CellValue): string {
  if (value === null) return '(NULL)'
  if (typeof value === 'boolean') return value ? '1' : '0'
  return String(value)
}
</script>

<template>
  <div class="result-grid">
    <v-data-table
      :headers="headers"
      :items="items"
      :items-per-page="-1"
      :height="height ?? '100%'"
      fixed-header
      hide-default-footer
      density="compact"
      class="result-grid__table"
    >
      <template #[`item.__index`]="{ item }">
        <span class="result-grid__index">{{ item.__index }}</span>
      </template>
      <template v-for="i in columnIndexes" :key="i" #[`item.c${i}`]="{ item }">
        <span
          class="result-grid__cell"
          :class="{ 'cell-null': item[`c${i}`] === null, 'result-grid__cell--num': numeric[i] }"
          :title="display(item[`c${i}`])"
          >{{ display(item[`c${i}`]) }}</span
        >
      </template>
      <template #bottom>
        <div class="result-grid__footer">
          <span class="nd-mono">{{ rows.length }}</span> filas<span
            v-if="truncated"
            class="result-grid__truncated"
          >
            · resultado truncado</span
          >
        </div>
      </template>
    </v-data-table>
  </div>
</template>

<style scoped>
.result-grid {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.result-grid__table {
  flex: 1;
  min-height: 0;
}
.result-grid__footer {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  border-top: 1px solid var(--nd-border);
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  flex: none;
}
.result-grid__truncated {
  color: var(--nd-warning);
}
.result-grid__index {
  font-family: var(--nd-font-mono);
  font-variant-numeric: tabular-nums;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.result-grid__cell--num {
  font-family: var(--nd-font-mono);
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'zero' 1;
}
.cell-null {
  font-style: italic;
  color: var(--nd-text-muted);
}
:deep(td) {
  white-space: nowrap;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--nd-fs-dense);
}
:deep(th) {
  white-space: nowrap;
}
</style>
