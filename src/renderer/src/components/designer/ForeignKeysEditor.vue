<script setup lang="ts">
import { ref } from 'vue'
import { emptyForeignKey, type ForeignKeyDraft } from '@renderer/utils/tableDesigner'
import { FK_ACTIONS } from './columnType'

const props = defineProps<{ columnNames: string[]; schemas: string[]; defaultSchema: string }>()
const model = defineModel<ForeignKeyDraft[]>({ required: true })
const selected = ref<number | null>(null)

function patch(index: number, change: Partial<ForeignKeyDraft>): void {
  model.value = model.value.map((x, i) => (i === index ? { ...x, ...change } : x))
}

function add(): void {
  model.value = [...model.value, { ...emptyForeignKey(), referencedSchema: props.defaultSchema }]
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
    <div class="designer-toolbar" role="toolbar" aria-label="Claves foráneas">
      <v-btn prepend-icon="mdi-plus" size="small" data-test="add-fk" @click="add"
        >Añadir clave foránea</v-btn
      >
      <v-btn
        prepend-icon="mdi-delete-outline"
        size="small"
        :disabled="selected === null"
        @click="remove"
        >Eliminar</v-btn
      >
      <span class="designer-toolbar__count">{{ model.length }} clave(s) foránea(s)</span>
    </div>
    <div class="flex-grow-1 overflow-auto">
      <table class="designer-table">
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Campos</th>
            <th>Base de datos ref.</th>
            <th>Tabla ref.</th>
            <th>Campos ref.</th>
            <th>Al eliminar</th>
            <th>Al actualizar</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(fk, i) in model"
            :key="fk.id"
            :class="{ 'is-selected': selected === i, 'is-new': !fk.originalName }"
            @click="selected = i"
          >
            <td>
              <input
                :value="fk.name"
                class="designer-input"
                aria-label="Nombre de la clave foránea"
                @input="patch(i, { name: ($event.target as HTMLInputElement).value })"
              />
            </td>
            <td>
              <v-select
                :model-value="fk.columns"
                :items="columnNames"
                multiple
                chips
                density="compact"
                variant="plain"
                hide-details
                aria-label="Campos"
                class="designer-select"
                @update:model-value="patch(i, { columns: $event })"
              />
            </td>
            <td>
              <v-combobox
                :model-value="fk.referencedSchema"
                :items="schemas"
                density="compact"
                variant="plain"
                hide-details
                aria-label="Base de datos referenciada"
                class="designer-select"
                @update:model-value="patch(i, { referencedSchema: $event ?? '' })"
              />
            </td>
            <td>
              <input
                :value="fk.referencedTable"
                class="designer-input"
                aria-label="Tabla referenciada"
                @input="patch(i, { referencedTable: ($event.target as HTMLInputElement).value })"
              />
            </td>
            <td>
              <input
                :value="fk.referencedColumns.join(', ')"
                class="designer-input"
                placeholder="id, ..."
                aria-label="Campos referenciados (separados por comas)"
                @change="
                  patch(i, {
                    referencedColumns: ($event.target as HTMLInputElement).value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                  })
                "
              />
            </td>
            <td>
              <v-select
                :model-value="fk.onDelete"
                :items="FK_ACTIONS"
                density="compact"
                variant="plain"
                hide-details
                aria-label="Al eliminar"
                class="designer-select"
                @update:model-value="patch(i, { onDelete: $event })"
              />
            </td>
            <td>
              <v-select
                :model-value="fk.onUpdate"
                :items="FK_ACTIONS"
                density="compact"
                variant="plain"
                hide-details
                aria-label="Al actualizar"
                class="designer-select"
                @update:model-value="patch(i, { onUpdate: $event })"
              />
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!model.length" class="designer-empty">
        <v-icon icon="mdi-key-link" size="32" />
        Sin claves foráneas.
      </div>
    </div>
  </div>
</template>

<style scoped src="./designerTable.css"></style>
