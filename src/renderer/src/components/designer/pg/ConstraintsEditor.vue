<script setup lang="ts">
import { ref } from 'vue'
import { nextId, type ConstraintDraft } from '@renderer/utils/tableDesigner'

/**
 * PostgreSQL unique / check / exclusion constraints, edited as their
 * definition text (`UNIQUE (email)`, `CHECK ((price > 0))`). The primary key
 * is edited with the «Clave» column of Campos; foreign keys have their own tab.
 */
const model = defineModel<ConstraintDraft[]>({ required: true })
const selected = ref<number | null>(null)

const TYPES: { title: string; value: ConstraintDraft['type'] }[] = [
  { title: 'UNIQUE', value: 'unique' },
  { title: 'CHECK', value: 'check' },
  { title: 'EXCLUDE', value: 'exclusion' }
]

const PLACEHOLDER: Record<ConstraintDraft['type'], string> = {
  unique: 'UNIQUE (campo)',
  check: 'CHECK ((precio > 0))',
  exclusion: 'EXCLUDE USING gist (rango WITH &&)'
}

function patch(index: number, change: Partial<ConstraintDraft>): void {
  model.value = model.value.map((x, i) => (i === index ? { ...x, ...change } : x))
}

function add(): void {
  model.value = [
    ...model.value,
    { id: nextId(), originalName: null, name: '', type: 'check', definition: '' }
  ]
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
    <div class="designer-toolbar" role="toolbar" aria-label="Restricciones">
      <v-btn prepend-icon="mdi-plus" size="small" data-test="add-constraint" @click="add"
        >Añadir restricción</v-btn
      >
      <v-btn
        prepend-icon="mdi-delete-outline"
        size="small"
        :disabled="selected === null"
        @click="remove"
        >Eliminar</v-btn
      >
      <span class="designer-toolbar__count">{{ model.length }} restricción(es)</span>
    </div>
    <div class="flex-grow-1 overflow-auto">
      <table class="designer-table">
        <thead>
          <tr>
            <th style="width: 24%">Nombre</th>
            <th style="width: 120px">Tipo</th>
            <th>Definición</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(c, i) in model"
            :key="c.id"
            :class="{ 'is-selected': selected === i, 'is-new': !c.originalName }"
            :data-test="`constraint-row-${i}`"
            @click="selected = i"
          >
            <td>
              <input
                :value="c.name"
                class="designer-input"
                aria-label="Nombre de la restricción"
                @input="patch(i, { name: ($event.target as HTMLInputElement).value })"
              />
            </td>
            <td>
              <v-select
                :model-value="c.type"
                :items="TYPES"
                density="compact"
                variant="plain"
                hide-details
                aria-label="Tipo de restricción"
                class="designer-select"
                @update:model-value="patch(i, { type: $event })"
              />
            </td>
            <td>
              <input
                :value="c.definition"
                class="designer-input"
                :placeholder="PLACEHOLDER[c.type]"
                aria-label="Definición"
                :data-test="`constraint-definition-${i}`"
                @input="patch(i, { definition: ($event.target as HTMLInputElement).value })"
              />
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!model.length" class="designer-empty">
        <v-icon icon="mdi-shield-check-outline" size="32" />
        Sin restricciones UNIQUE, CHECK ni EXCLUDE.
      </div>
    </div>
  </div>
</template>

<style scoped src="../designerTable.css"></style>
