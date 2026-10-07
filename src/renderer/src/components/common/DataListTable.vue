<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { cellText, sortItems, type ObjectColumn } from '@renderer/utils/objectColumns'

/**
 * Dense, sortable, keyboard-navigable list. Presentation only:
 * selection lives in the parent so it can be shared with other panels.
 */
const props = defineProps<{
  columns: ObjectColumn<unknown>[]
  items: unknown[]
  rowKey: (item: unknown) => string
  selectedKey?: string | null
  icon?: (item: unknown) => string
  label?: string
}>()

const emit = defineEmits<{
  select: [item: unknown]
  open: [item: unknown]
  contextmenu: [event: MouseEvent, item: unknown]
}>()

const sortKey = ref<string | null>(null)
const sortDesc = ref(false)
const body = ref<HTMLElement | null>(null)

const sortColumn = computed(() => props.columns.find((c) => c.key === sortKey.value))
const rows = computed(() => sortItems(props.items, sortColumn.value, sortDesc.value))

function toggleSort(key: string): void {
  if (sortKey.value !== key) {
    sortKey.value = key
    sortDesc.value = false
  } else if (!sortDesc.value) sortDesc.value = true
  else sortKey.value = null
}

function ariaSort(key: string): 'ascending' | 'descending' | 'none' {
  if (sortKey.value !== key) return 'none'
  return sortDesc.value ? 'descending' : 'ascending'
}

async function move(index: number, delta: number): Promise<void> {
  const next = rows.value[index + delta]
  if (!next) return
  emit('select', next)
  await nextTick()
  const el = body.value?.querySelectorAll<HTMLElement>('tr')[index + delta]
  el?.focus()
}
</script>

<template>
  <div class="data-list">
    <table class="data-list__table" :aria-label="label" data-test="data-list">
      <thead>
        <tr>
          <th
            v-for="(column, ci) in columns"
            :key="column.key"
            scope="col"
            :class="{
              'text-end': column.align === 'end',
              'data-list__th--sorted': sortKey === column.key,
              'data-list__th--first': ci === 0
            }"
            :aria-sort="ariaSort(column.key)"
          >
            <button type="button" class="data-list__sort" @click="toggleSort(column.key)">
              <span class="data-list__th-label">{{ column.title }}</span>
              <v-icon
                v-if="sortKey === column.key"
                :icon="sortDesc ? 'mdi-arrow-down' : 'mdi-arrow-up'"
                size="12"
                class="data-list__sort-icon"
              />
            </button>
          </th>
        </tr>
      </thead>
      <tbody ref="body">
        <tr
          v-for="(item, index) in rows"
          :key="rowKey(item)"
          :class="{ 'data-list__row--selected': rowKey(item) === selectedKey }"
          :aria-selected="rowKey(item) === selectedKey"
          tabindex="0"
          data-test="data-list-row"
          @click="emit('select', item)"
          @dblclick="emit('open', item)"
          @contextmenu.prevent="(emit('select', item), emit('contextmenu', $event, item))"
          @keydown.enter.prevent="emit('open', item)"
          @keydown.down.prevent="move(index, 1)"
          @keydown.up.prevent="move(index, -1)"
        >
          <td
            v-for="(column, ci) in columns"
            :key="column.key"
            :class="{
              'data-list__num': column.align === 'end',
              'data-list__name': ci === 0
            }"
            :title="cellText(column, item)"
          >
            <v-icon
              v-if="ci === 0 && icon"
              :icon="icon(item)"
              size="15"
              class="data-list__icon"
            />{{ cellText(column, item) }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.data-list {
  height: 100%;
  overflow: auto;
}
.data-list__table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text);
}
.data-list__table th {
  position: sticky;
  top: 0;
  z-index: 1;
  height: var(--nd-row-h);
  background: var(--nd-bg-panel);
  border-bottom: 1px solid var(--nd-border);
  font-size: var(--nd-fs-small);
  font-weight: 600;
  text-align: start;
  padding: 0;
  white-space: nowrap;
}
.data-list__table th.text-end .data-list__sort {
  justify-content: flex-end;
}
.data-list__sort {
  all: unset;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  height: var(--nd-row-h);
  box-sizing: border-box;
  padding: 0 12px;
  cursor: pointer;
  color: var(--nd-text-2);
  transition: color var(--nd-dur-fast) var(--nd-ease);
}
.data-list__th--first .data-list__sort {
  padding-left: 16px;
}
.data-list__sort:hover,
.data-list__th--sorted .data-list__sort {
  color: var(--nd-text);
}
.data-list__sort-icon {
  color: var(--nd-accent);
}
.data-list__sort:focus-visible {
  box-shadow: inset 0 0 0 1px rgba(var(--nd-accent-rgb), 0.6);
  border-radius: var(--nd-radius-sm);
}
.data-list__table td {
  height: var(--nd-row-h);
  padding: 0 12px;
  white-space: nowrap;
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  border-bottom: 1px solid var(--nd-hairline);
  transition: background-color var(--nd-dur-fast) var(--nd-ease);
}
.data-list__table td.data-list__name {
  position: relative;
  padding-left: 16px;
  font-weight: 500;
  min-width: 160px;
}
.data-list__table td.data-list__num {
  font-family: var(--nd-font-mono);
  font-variant-numeric: tabular-nums;
  font-size: var(--nd-fs-xs);
  text-align: end;
  color: var(--nd-text-2);
}
.data-list__table tbody tr {
  cursor: default;
  outline: none;
}
.data-list__table tbody tr:hover > td {
  background: var(--nd-hover);
}
.data-list__table tbody tr:focus-visible > td {
  background: var(--nd-hover);
  box-shadow:
    inset 0 1px 0 rgba(var(--nd-accent-rgb), 0.45),
    inset 0 -1px 0 rgba(var(--nd-accent-rgb), 0.45);
}
.data-list__table tbody tr.data-list__row--selected > td {
  background: var(--nd-selected);
}
.data-list__table tbody tr.data-list__row--selected > td.data-list__name::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 7px;
  bottom: 7px;
  width: 3px;
  border-radius: 3px;
  background: var(--nd-accent-gradient-v);
  box-shadow: 0 0 8px rgba(var(--nd-accent-rgb), 0.5);
}
.data-list__icon {
  margin-right: 8px;
  vertical-align: -3px;
  color: var(--nd-text-muted);
  transition: color var(--nd-dur-fast) var(--nd-ease);
}
.data-list__row--selected .data-list__icon {
  color: var(--nd-accent);
}
</style>
