<script setup lang="ts">
/**
 * One key/value/type row of the tree mode (DocumentTree.vue), recursive.
 * Scalars edit in place with the typed editor; arrays and documents expand.
 * Removing an array element sets the whole array (handled by the view).
 */
import { computed, ref } from 'vue'
import {
  BSON_TYPE_LABELS,
  cellPreview,
  isContainer,
  type BsonType,
  type EjsonObject,
  type EjsonValue
} from '@shared/mongo/shellFormat'
import { TYPE_ICONS, typeOfCell, type PathSegment } from './docModel'

/** Nesting deeper than this is collapsed (section 9.1). */
const MAX_DEPTH = 20

const props = defineProps<{
  label: string
  value: EjsonValue
  path: PathSegment[]
  depth: number
  localTime: boolean
  readonly: boolean
  isChanged: (path: PathSegment[]) => boolean
}>()

const emit = defineEmits<{
  edit: [path: PathSegment[]]
  remove: [path: PathSegment[]]
  add: [path: PathSegment[]]
}>()

const open = ref(props.depth < 1)
const container = computed(() => isContainer(props.value))
const type = computed(() => typeOfCell(props.value))
const children = computed<[string, EjsonValue, PathSegment][]>(() => {
  const v = props.value
  if (Array.isArray(v)) return v.map((x, i) => [String(i), x, i])
  if (container.value)
    return Object.entries(v as EjsonObject).map(
      ([k, x]) => [k, x, k] as [string, EjsonValue, string]
    )
  return []
})
const summary = computed(() => cellPreview(props.value, { localTime: props.localTime }))
const isId = computed(() => props.path.length === 1 && props.path[0] === '_id')
</script>

<template>
  <div class="tree-node" :class="{ 'tree-node--changed': isChanged(path) }">
    <div class="tree-node__row" :style="{ paddingLeft: `${depth * 16 + 4}px` }">
      <button
        v-if="container"
        type="button"
        class="tree-node__toggle"
        :aria-expanded="open"
        :aria-label="open ? `Contraer ${label}` : `Expandir ${label}`"
        @click="open = !open"
      >
        <v-icon :icon="open ? 'mdi-chevron-down' : 'mdi-chevron-right'" size="14" />
      </button>
      <span v-else class="tree-node__toggle" aria-hidden="true" />
      <span class="tree-node__key nd-mono">{{ label }}</span>
      <span
        class="tree-node__value nd-mono"
        :title="summary"
        @dblclick="!container && !readonly && !isId && emit('edit', path)"
        >{{ summary }}</span
      >
      <span class="tree-node__type">
        <v-icon :icon="TYPE_ICONS[type] ?? 'mdi-shape-outline'" size="12" aria-hidden="true" />
        {{ BSON_TYPE_LABELS[type as BsonType] ?? type }}
      </span>
      <span v-if="!readonly && !isId" class="tree-node__actions">
        <v-btn
          v-if="!container"
          icon="mdi-pencil-outline"
          size="x-small"
          variant="text"
          :aria-label="`Editar ${label}`"
          title="Editar valor"
          @click="emit('edit', path)"
        />
        <v-btn
          v-if="container"
          icon="mdi-plus"
          size="x-small"
          variant="text"
          :aria-label="
            Array.isArray(value) ? `Añadir elemento a ${label}` : `Añadir campo a ${label}`
          "
          :title="Array.isArray(value) ? 'Añadir elemento' : 'Añadir campo'"
          @click="emit('add', path)"
        />
        <v-btn
          icon="mdi-close"
          size="x-small"
          variant="text"
          :aria-label="`Eliminar ${label}`"
          :title="
            typeof path[path.length - 1] === 'number' ? 'Eliminar elemento' : 'Eliminar campo'
          "
          @click="emit('remove', path)"
        />
      </span>
    </div>
    <template v-if="container && open">
      <div
        v-if="depth + 1 > MAX_DEPTH"
        class="tree-node__deep"
        :style="{ paddingLeft: `${(depth + 1) * 16 + 24}px` }"
      >
        Anidamiento de más de {{ MAX_DEPTH }} niveles: abre el documento completo para verlo.
      </div>
      <template v-else>
        <DocumentTreeNode
          v-for="[key, child, seg] in children"
          :key="key"
          :label="key"
          :value="child"
          :path="[...path, seg]"
          :depth="depth + 1"
          :local-time="localTime"
          :readonly="readonly"
          :is-changed="isChanged"
          @edit="emit('edit', $event)"
          @remove="emit('remove', $event)"
          @add="emit('add', $event)"
        />
      </template>
    </template>
  </div>
</template>

<style scoped>
.tree-node__row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  padding-right: 8px;
  font-size: var(--nd-fs-dense);
  border-bottom: 1px solid var(--nd-hairline);
}
.tree-node__row:hover {
  background: var(--nd-hover);
}
.tree-node--changed > .tree-node__row {
  background: color-mix(in srgb, var(--nd-warning) 13%, transparent);
}
.tree-node__toggle {
  flex: none;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--nd-text-muted);
  background: none;
  border: none;
  cursor: pointer;
}
.tree-node__key {
  flex: 0 0 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--nd-info);
}
.tree-node__value {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tree-node__type {
  flex: 0 0 110px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--nd-text-muted);
  font-size: var(--nd-fs-xs);
}
.tree-node__actions {
  flex: none;
  display: inline-flex;
  opacity: 0;
}
.tree-node__row:hover .tree-node__actions,
.tree-node__row:focus-within .tree-node__actions {
  opacity: 1;
}
.tree-node__deep {
  padding: 4px 0;
  color: var(--nd-text-muted);
  font-size: var(--nd-fs-xs);
}
</style>
