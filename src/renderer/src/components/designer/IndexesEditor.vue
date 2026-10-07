<script setup lang="ts">
import { ref } from 'vue'
import { emptyIndex, type IndexDraft } from '@renderer/utils/tableDesigner'
import { INDEX_TYPES } from './columnType'

const props = withDefaults(
  defineProps<{
    columnNames: string[]
    /** Index methods offered (PostgreSQL: btree, gin…); MySQL keeps INDEX_TYPES. */
    types?: string[]
    /** PostgreSQL: key parts may be expressions typed by the user (lower(name)…). */
    allowExpressions?: boolean
  }>(),
  { types: () => INDEX_TYPES, allowExpressions: false }
)
const model = defineModel<IndexDraft[]>({ required: true })
const selected = ref<number | null>(null)

function patch(index: number, change: Partial<IndexDraft>): void {
  model.value = model.value.map((x, i) => (i === index ? { ...x, ...change } : x))
}

function add(): void {
  model.value = [...model.value, emptyIndex()]
  selected.value = model.value.length - 1
}

function remove(): void {
  if (selected.value === null) return
  model.value = model.value.filter((_, i) => i !== selected.value)
  selected.value = null
}
</script>

<template>
  <div class="d-flex flex-column fill-height">
    <div class="designer-toolbar" role="toolbar" aria-label="Índices">
      <v-btn prepend-icon="mdi-plus" size="small" data-test="add-index" @click="add"
        >Añadir índice</v-btn
      >
      <v-btn
        prepend-icon="mdi-delete-outline"
        size="small"
        :disabled="selected === null"
        @click="remove"
        >Eliminar</v-btn
      >
      <span class="designer-toolbar__count">{{ model.length }} índice(s)</span>
    </div>
    <div class="flex-grow-1 overflow-auto">
      <table class="designer-table">
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Campos</th>
            <th>Tipo</th>
            <th class="text-center">Único</th>
            <th>Comentario</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(idx, i) in model"
            :key="idx.id"
            :class="{ 'is-selected': selected === i, 'is-new': !idx.originalName }"
            @click="selected = i"
          >
            <td>
              <input
                :value="idx.name"
                class="designer-input"
                aria-label="Nombre del índice"
                @input="patch(i, { name: ($event.target as HTMLInputElement).value })"
              />
            </td>
            <td>
              <v-combobox
                v-if="props.allowExpressions"
                :model-value="idx.columns"
                :items="columnNames"
                multiple
                chips
                closable-chips
                density="compact"
                variant="plain"
                hide-details
                aria-label="Campos o expresiones del índice"
                class="designer-select"
                @update:model-value="patch(i, { columns: $event })"
              />
              <v-select
                v-else
                :model-value="idx.columns"
                :items="columnNames"
                multiple
                chips
                closable-chips
                density="compact"
                variant="plain"
                hide-details
                aria-label="Campos del índice"
                class="designer-select"
                @update:model-value="patch(i, { columns: $event })"
              />
            </td>
            <td>
              <v-select
                :model-value="idx.type"
                :items="props.types"
                density="compact"
                variant="plain"
                hide-details
                aria-label="Tipo de índice"
                class="designer-select"
                @update:model-value="
                  patch(i, {
                    type: $event,
                    unique: $event === 'FULLTEXT' || $event === 'SPATIAL' ? false : idx.unique
                  })
                "
              />
            </td>
            <td class="text-center">
              <input
                type="checkbox"
                :checked="idx.unique"
                aria-label="Único"
                :disabled="idx.type === 'FULLTEXT' || idx.type === 'SPATIAL'"
                @change="patch(i, { unique: !idx.unique })"
              />
            </td>
            <td>
              <input
                :value="idx.comment"
                class="designer-input designer-input--ui"
                aria-label="Comentario del índice"
                @input="patch(i, { comment: ($event.target as HTMLInputElement).value })"
              />
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!model.length" class="designer-empty">
        <v-icon icon="mdi-lightning-bolt-outline" size="32" />
        Sin índices (además de la clave primaria).
      </div>
    </div>
  </div>
</template>

<style scoped src="./designerTable.css"></style>
