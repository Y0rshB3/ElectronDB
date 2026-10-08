<script setup lang="ts">
/**
 * Table mode of the MongoDB documents view (docs/multi-engine-design.md, 9.1):
 * one row per document, one column per top-level field, shell-syntax
 * previews with a type icon per cell and a «mixto» badge on columns with
 * several BSON types. Double-click edits a scalar (typed editor) or opens
 * the document editor for nested values.
 */
import { computed } from 'vue'
import type { MongoFieldStat } from '@shared/types'
import {
  BSON_TYPE_LABELS,
  bsonTypeOf,
  cellPreview,
  dateMillis,
  isoDate,
  localDate,
  objectIdTime,
  type BsonType,
  type EjsonObject,
  type EjsonValue
} from '@shared/mongo/shellFormat'
import { TYPE_ICONS, mixedTypes, typeOfCell } from './docModel'

const props = defineProps<{
  docs: EjsonObject[]
  columns: string[]
  fields: MongoFieldStat[]
  selected: number[]
  /** Row index → top-level fields with staged edits. */
  changed: Record<number, string[]>
  deleted: number[]
  localTime: boolean
  /** Number of the first row (paging). */
  offset: number
}>()

const emit = defineEmits<{
  select: [index: number, additive: boolean]
  edit: [index: number, column: string]
  menu: [event: MouseEvent, index: number, column: string | null]
}>()

const fieldOf = computed(() => Object.fromEntries(props.fields.map((f) => [f.path, f])))

function iconOf(v: EjsonValue | undefined): string {
  if (v === undefined) return ''
  return TYPE_ICONS[typeOfCell(v) as BsonType] ?? 'mdi-shape-outline'
}

function tooltip(v: EjsonValue | undefined, column: string): string {
  if (v === undefined) return `${column}: (sin campo)`
  const type = typeOfCell(v)
  const label = BSON_TYPE_LABELS[type as BsonType] ?? type
  let extra = ''
  if (type === 'date') {
    const ms = dateMillis(v as EjsonObject)
    if (ms !== null) extra = `\nUTC: ${isoDate(ms) ?? ms}\nLocal: ${localDate(ms)}`
  } else if (type === 'objectId') {
    const ms = objectIdTime(String((v as EjsonObject).$oid))
    if (ms !== null) extra = `\nCreado: ${isoDate(ms) ?? ms}`
  }
  return `${column} · ${label}${extra}\n${cellPreview(v)}`
}

function isNum(v: EjsonValue | undefined): boolean {
  if (v === undefined) return false
  const t = bsonTypeOf(v)
  return t === 'int' || t === 'long' || t === 'double' || t === 'decimal'
}
</script>

<template>
  <div class="document-grid" tabindex="0" data-test="document-grid">
    <table>
      <thead>
        <tr>
          <th class="col-index">#</th>
          <th v-for="c in columns" :key="c" :title="c">
            <span class="document-grid__head">
              <span class="nd-mono">{{ c }}</span>
              <span
                v-if="mixedTypes(fieldOf[c])"
                class="document-grid__mixed"
                :title="`Tipos: ${Object.keys(fieldOf[c]?.types ?? {}).join(', ')}`"
                >mixto</span
              >
            </span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(doc, i) in docs"
          :key="i"
          :class="{
            'row-selected': selected.includes(i),
            'row-deleted': deleted.includes(i)
          }"
          :data-test="`doc-row-${i}`"
          @click="emit('select', i, $event.metaKey || $event.ctrlKey)"
          @contextmenu.prevent="emit('menu', $event, i, null)"
        >
          <td class="col-index">{{ offset + i + 1 }}</td>
          <td
            v-for="c in columns"
            :key="c"
            :class="{
              'cell-missing': doc[c] === undefined,
              'cell-changed': changed[i]?.includes(c),
              'cell-num': isNum(doc[c])
            }"
            :title="tooltip(doc[c], c)"
            @dblclick="emit('edit', i, c)"
            @contextmenu.prevent.stop="emit('menu', $event, i, c)"
          >
            <span class="document-grid__cell">
              <v-icon
                v-if="doc[c] !== undefined"
                :icon="iconOf(doc[c])"
                size="12"
                class="document-grid__type"
                aria-hidden="true"
              />
              <span class="cell-value">{{
                doc[c] === undefined ? '' : cellPreview(doc[c], { localTime })
              }}</span>
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.document-grid {
  --grid-changed-bg: color-mix(in srgb, var(--nd-warning) 13%, transparent);
  overflow: auto;
  height: 100%;
  outline: none;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text);
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
  padding: 0 10px;
  white-space: nowrap;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  height: var(--nd-row-h);
  text-align: left;
}
th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--nd-bg-panel);
  box-shadow: inset 0 -1px 0 var(--nd-border);
  border-bottom: none;
  color: var(--nd-text-2);
  font-weight: 600;
}
.col-index {
  width: 44px;
  color: var(--nd-text-muted);
  text-align: right;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
}
tbody tr {
  cursor: default;
}
tbody tr:hover td {
  background: var(--nd-hover);
}
tbody tr.row-selected td {
  background: var(--nd-selected);
}
tbody tr.row-deleted td {
  background: var(--nd-error-soft);
  text-decoration: line-through;
}
td.cell-changed {
  background: var(--grid-changed-bg) !important;
}
td.cell-missing {
  background: repeating-linear-gradient(
    -45deg,
    transparent,
    transparent 5px,
    var(--nd-hairline) 5px,
    var(--nd-hairline) 6px
  );
}
td.cell-num .cell-value {
  font-variant-numeric: tabular-nums;
}
.document-grid__head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.document-grid__mixed {
  padding: 0 6px;
  border-radius: var(--nd-radius-pill);
  font-size: var(--nd-fs-xs);
  color: var(--nd-warning);
  background: var(--nd-warning-soft);
}
.document-grid__cell {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 300px;
}
.document-grid__type {
  flex: none;
  color: var(--nd-text-muted);
}
.cell-value {
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--nd-font-mono);
}
</style>
