<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ColumnDraft } from '@renderer/utils/tableDesigner'
import { SQLITE_TYPES, sqliteEmptyColumn } from './planner'

/**
 * Columns of a SQLite table: free-text declared type (with suggestions),
 * NOT NULL, primary key, DEFAULT as an SQL expression, and AUTOINCREMENT,
 * offered only on a single INTEGER PRIMARY KEY of a rowid table.
 */
const props = defineProps<{ withoutRowid: boolean }>()
const model = defineModel<ColumnDraft[]>({ required: true })
const selected = ref<number | null>(null)

const pkCount = computed(() => model.value.filter((c) => c.primaryKey).length)

function canAutoIncrement(c: ColumnDraft): boolean {
  return (
    !props.withoutRowid &&
    c.primaryKey &&
    pkCount.value === 1 &&
    c.columnType.trim().toUpperCase() === 'INTEGER'
  )
}

function patch(index: number, change: Partial<ColumnDraft>): void {
  model.value = model.value.map((c, i) => {
    if (i !== index) return c
    const next = { ...c, ...change }
    // AUTOINCREMENT only survives on a single INTEGER PRIMARY KEY.
    if (
      next.autoIncrement &&
      (next.columnType.trim().toUpperCase() !== 'INTEGER' || !next.primaryKey)
    )
      next.autoIncrement = false
    return next
  })
}

function add(insertAt?: number): void {
  const next = [...model.value]
  const at = insertAt ?? next.length
  next.splice(at, 0, sqliteEmptyColumn())
  model.value = next
  selected.value = at
}

function remove(): void {
  if (selected.value === null) return
  model.value = model.value.filter((_, i) => i !== selected.value)
  selected.value = model.value.length ? Math.min(selected.value, model.value.length - 1) : null
}

function move(delta: number): void {
  if (selected.value === null) return
  const to = selected.value + delta
  if (to < 0 || to >= model.value.length) return
  const next = [...model.value]
  const [item] = next.splice(selected.value, 1)
  next.splice(to, 0, item)
  model.value = next
  selected.value = to
}
</script>

<template>
  <div class="columns-editor">
    <div class="designer-toolbar" role="toolbar" aria-label="Campos">
      <v-btn prepend-icon="mdi-plus" size="small" data-test="add-column" @click="add()"
        >Añadir campo</v-btn
      >
      <v-btn
        prepend-icon="mdi-table-row-plus-before"
        size="small"
        :disabled="selected === null"
        @click="add(selected ?? 0)"
        >Insertar</v-btn
      >
      <v-btn
        prepend-icon="mdi-delete-outline"
        size="small"
        :disabled="selected === null"
        data-test="remove-column"
        @click="remove"
        >Eliminar</v-btn
      >
      <span class="designer-toolbar__sep" aria-hidden="true" />
      <v-btn
        icon="mdi-arrow-up"
        size="small"
        aria-label="Subir campo"
        :disabled="selected === null || selected === 0"
        @click="move(-1)"
      />
      <v-btn
        icon="mdi-arrow-down"
        size="small"
        aria-label="Bajar campo"
        :disabled="selected === null || selected >= model.length - 1"
        @click="move(1)"
      />
      <span class="designer-toolbar__count">{{ model.length }} campo(s)</span>
    </div>
    <div class="columns-editor__scroll">
      <table class="designer-table">
        <thead>
          <tr>
            <th class="w-name">Nombre</th>
            <th class="w-type">Tipo</th>
            <th class="w-check text-center" title="Admite NULL">Nulo</th>
            <th class="w-check text-center" title="Clave primaria">Clave</th>
            <th class="w-default">Predeterminado (expresión SQL)</th>
            <th
              class="w-check text-center"
              title="AUTOINCREMENT: solo en una clave primaria INTEGER (sin él, SQLite puede reutilizar ids borrados)"
            >
              A.I.
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(col, i) in model"
            :key="col.id"
            :class="{ 'is-selected': selected === i, 'is-new': !col.originalName }"
            :data-test="`column-row-${i}`"
            @click="selected = i"
          >
            <td>
              <input
                :value="col.name"
                class="designer-input"
                aria-label="Nombre del campo"
                :data-test="`column-name-${i}`"
                @input="patch(i, { name: ($event.target as HTMLInputElement).value })"
              />
            </td>
            <td>
              <v-combobox
                :model-value="col.columnType"
                :items="SQLITE_TYPES"
                density="compact"
                variant="plain"
                hide-details
                aria-label="Tipo"
                class="designer-combo"
                :data-test="`column-type-${i}`"
                @update:model-value="patch(i, { columnType: String($event ?? '') })"
              />
            </td>
            <td class="text-center">
              <input
                type="checkbox"
                :checked="col.nullable"
                aria-label="Admite NULL"
                :data-test="`column-nullable-${i}`"
                @change="patch(i, { nullable: !col.nullable })"
              />
            </td>
            <td class="text-center">
              <input
                type="checkbox"
                :checked="col.primaryKey"
                aria-label="Clave primaria"
                @change="
                  patch(i, {
                    primaryKey: !col.primaryKey,
                    nullable: col.primaryKey ? col.nullable : false
                  })
                "
              />
            </td>
            <td>
              <input
                :value="col.defaultValue ?? ''"
                class="designer-input"
                :placeholder="col.nullable ? 'NULL' : 'Sin valor'"
                title="Expresión SQL: 0, 'texto', CURRENT_TIMESTAMP, (datetime('now'))… Vacío = sin valor predeterminado."
                aria-label="Valor predeterminado"
                :data-test="`column-default-${i}`"
                @input="
                  patch(i, { defaultValue: ($event.target as HTMLInputElement).value || null })
                "
              />
            </td>
            <td class="text-center">
              <input
                type="checkbox"
                :checked="col.autoIncrement"
                aria-label="AUTOINCREMENT"
                :disabled="!canAutoIncrement(col) && !col.autoIncrement"
                :data-test="`column-autoincrement-${i}`"
                @change="patch(i, { autoIncrement: !col.autoIncrement })"
              />
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!model.length" class="designer-empty">
        <v-icon icon="mdi-table-column-plus-after" size="32" />
        La tabla no tiene campos. Añade uno para empezar.
      </div>
    </div>
  </div>
</template>

<style scoped src="../designerTable.css"></style>
<style scoped>
.columns-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.columns-editor__scroll {
  flex: 1 1 auto;
  overflow: auto;
}
.w-name {
  width: 24%;
}
.w-type {
  width: 190px;
}
.w-check {
  width: 64px;
}
.w-default {
  width: 28%;
}
</style>
