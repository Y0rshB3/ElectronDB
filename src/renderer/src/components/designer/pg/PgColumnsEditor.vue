<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DataTypeInfo, TableStructure } from '@shared/types'
import type { ColumnDraft } from '@renderer/utils/tableDesigner'
import { pgEmptyColumn } from './planner'
import { IDENTITY_TYPES, splitArrayType, withArray } from './types'

/**
 * PostgreSQL columns editor (the MySQL one is ColumnsEditor.vue). Types come
 * from the server's pg_type (db:dataTypes) with an «array» checkbox; defaults
 * are raw SQL expressions; auto increment means identity for new columns and
 * is read-only for existing serial / identity columns; existing columns cannot
 * be reordered (PostgreSQL has no column positions).
 */
const props = defineProps<{
  dataTypes: DataTypeInfo[]
  /** Structure being edited (null for a new table): original types, enum labels. */
  original: TableStructure | null
}>()
const model = defineModel<ColumnDraft[]>({ required: true })
const enumAdditions = defineModel<Record<string, string[]>>('enumAdditions', {
  default: () => ({})
})
const selected = ref<number | null>(null)
const newLabel = ref('')

const typeNames = computed(() => props.dataTypes.map((t) => t.name))

function patch(index: number, change: Partial<ColumnDraft>): void {
  model.value = model.value.map((c, i) => (i === index ? { ...c, ...change } : c))
}

function pgOf(c: ColumnDraft): NonNullable<ColumnDraft['pg']> {
  return c.pg ?? { identity: null, serial: false, generated: null }
}

function patchPg(index: number, change: Partial<NonNullable<ColumnDraft['pg']>>): void {
  const col = model.value[index]
  patch(index, { pg: { ...pgOf(col), ...change } })
}

function setBase(index: number, base: string | null): void {
  const col = model.value[index]
  const { array } = splitArrayType(col.columnType)
  const next = withArray((base ?? '').trim(), array)
  const change: Partial<ColumnDraft> = { columnType: next }
  if (!IDENTITY_TYPES.has(splitArrayType(next).base.toLowerCase()) && !col.originalName)
    change.autoIncrement = false
  patch(index, change)
}

function setArray(index: number, array: boolean): void {
  const col = model.value[index]
  patch(index, { columnType: withArray(splitArrayType(col.columnType).base, array) })
}

function originalType(col: ColumnDraft): string | null {
  if (!col.originalName || !props.original) return null
  return props.original.columns.find((c) => c.name === col.originalName)?.columnType ?? null
}

/** Existing column whose type changes: USING may be needed. */
function typeChanged(col: ColumnDraft): boolean {
  const before = originalType(col)
  return before !== null && before !== col.columnType
}

/** Existing serial / identity / generated columns keep their nature. */
function autoLocked(col: ColumnDraft): boolean {
  const pg = pgOf(col)
  return !!col.originalName && (pg.serial || !!pg.identity)
}

function canAutoIncrement(col: ColumnDraft): boolean {
  const { base, array } = splitArrayType(col.columnType)
  return !array && IDENTITY_TYPES.has(base.toLowerCase())
}

function toggleAuto(index: number): void {
  const col = model.value[index]
  if (col.autoIncrement) {
    patch(index, { autoIncrement: false, pg: { ...pgOf(col), identity: null } })
  } else {
    patch(index, {
      autoIncrement: true,
      defaultValue: null,
      nullable: false,
      pg: { ...pgOf(col), identity: pgOf(col).identity ?? 'by-default' }
    })
  }
}

function add(insertAt?: number): void {
  const next = [...model.value]
  const at = insertAt ?? next.length
  next.splice(at, 0, pgEmptyColumn())
  model.value = next
  selected.value = at
}

function remove(): void {
  if (selected.value === null) return
  model.value = model.value.filter((_, i) => i !== selected.value)
  selected.value = model.value.length ? Math.min(selected.value, model.value.length - 1) : null
}

/** Only new columns move, and only past other new columns (no positions in PostgreSQL). */
function canMove(delta: number): boolean {
  if (selected.value === null) return false
  const to = selected.value + delta
  if (to < 0 || to >= model.value.length) return false
  return !model.value[selected.value].originalName && !model.value[to].originalName
}

function move(delta: number): void {
  if (!canMove(delta) || selected.value === null) return
  const to = selected.value + delta
  const next = [...model.value]
  const [item] = next.splice(selected.value, 1)
  next.splice(to, 0, item)
  model.value = next
  selected.value = to
}

const current = computed(() => (selected.value === null ? null : model.value[selected.value]))

/** Enum type of the selected column: its key for enumAdditions and its labels. */
const currentEnum = computed(() => {
  const col = current.value
  if (!col) return null
  const base = splitArrayType(col.columnType).base
  const fromType = props.dataTypes.find((t) => t.kind === 'enum' && t.name === base)
  const fromOriginal = col.originalName
    ? props.original?.columns.find(
        (c) => c.name === col.originalName && c.columnType === col.columnType
      )
    : undefined
  const labels = fromType?.enumValues ?? fromOriginal?.enumValues
  if (!labels) return null
  return { key: base, labels, added: enumAdditions.value[base] ?? [] }
})

function addLabel(): void {
  const e = currentEnum.value
  const label = newLabel.value.trim()
  if (!e || !label || e.labels.includes(label) || e.added.includes(label)) return
  enumAdditions.value = { ...enumAdditions.value, [e.key]: [...e.added, label] }
  newLabel.value = ''
}

function removeLabel(label: string): void {
  const e = currentEnum.value
  if (!e) return
  const rest = e.added.filter((l) => l !== label)
  const next = { ...enumAdditions.value }
  if (rest.length) next[e.key] = rest
  else delete next[e.key]
  enumAdditions.value = next
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
      >
        Insertar
      </v-btn>
      <v-btn
        prepend-icon="mdi-delete-outline"
        size="small"
        :disabled="selected === null"
        data-test="remove-column"
        @click="remove"
      >
        Eliminar
      </v-btn>
      <span class="designer-toolbar__sep" aria-hidden="true" />
      <v-btn
        icon="mdi-arrow-up"
        size="small"
        aria-label="Subir campo"
        title="PostgreSQL no permite reordenar columnas existentes"
        :disabled="!canMove(-1)"
        data-test="move-up"
        @click="move(-1)"
      />
      <v-btn
        icon="mdi-arrow-down"
        size="small"
        aria-label="Bajar campo"
        title="PostgreSQL no permite reordenar columnas existentes"
        :disabled="!canMove(1)"
        data-test="move-down"
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
            <th class="w-check text-center" title="Lista (array)">[ ]</th>
            <th class="w-check text-center" title="Admite NULL">Nulo</th>
            <th class="w-check text-center" title="Clave primaria">Clave</th>
            <th class="w-default">Predeterminado</th>
            <th class="w-check text-center" title="Auto incremento (identity)">A.I.</th>
            <th>Comentario</th>
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
                :model-value="splitArrayType(col.columnType).base"
                :items="typeNames"
                density="compact"
                variant="plain"
                hide-details
                aria-label="Tipo"
                class="designer-combo"
                :data-test="`column-type-${i}`"
                @update:model-value="setBase(i, $event)"
              />
            </td>
            <td class="text-center">
              <input
                type="checkbox"
                :checked="splitArrayType(col.columnType).array"
                aria-label="Lista (array)"
                :data-test="`column-array-${i}`"
                @change="setArray(i, !splitArrayType(col.columnType).array)"
              />
            </td>
            <td class="text-center">
              <input
                type="checkbox"
                :checked="col.nullable"
                aria-label="Admite NULL"
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
                v-if="col.pg?.generated"
                :value="`GENERATED ALWAYS AS (${col.pg.generated}) STORED`"
                class="designer-input"
                readonly
                title="Columna calculada: la expresión no se edita aquí"
                aria-label="Expresión calculada"
              />
              <input
                v-else-if="col.pg?.serial"
                :value="col.defaultValue ?? ''"
                class="designer-input"
                readonly
                title="Auto incremento (serial): el valor lo da su secuencia"
                aria-label="Valor predeterminado (serial)"
              />
              <input
                v-else
                :value="col.defaultValue ?? ''"
                class="designer-input"
                placeholder="Sin valor"
                title="Expresión SQL: 'texto', 0, now()… Vacío = sin valor predeterminado."
                aria-label="Valor predeterminado"
                :disabled="col.autoIncrement"
                :data-test="`column-default-${i}`"
                @input="
                  patch(i, {
                    defaultValue: ($event.target as HTMLInputElement).value.trim()
                      ? ($event.target as HTMLInputElement).value
                      : null
                  })
                "
              />
            </td>
            <td class="text-center">
              <input
                type="checkbox"
                :checked="col.autoIncrement"
                aria-label="Auto incremento"
                :title="
                  col.pg?.serial
                    ? 'Auto incremento (serial)'
                    : col.pg?.identity
                      ? 'Identity'
                      : 'Auto incremento: GENERATED … AS IDENTITY'
                "
                :disabled="autoLocked(col) || !!col.pg?.generated || !canAutoIncrement(col)"
                @change="toggleAuto(i)"
              />
            </td>
            <td>
              <input
                :value="col.comment"
                class="designer-input designer-input--ui"
                aria-label="Comentario"
                @input="patch(i, { comment: ($event.target as HTMLInputElement).value })"
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

    <div v-if="current && selected !== null" class="pg-details" data-test="column-details">
      <div class="pg-details__title">Campo «{{ current.name || 'sin nombre' }}»</div>
      <div v-if="current.pg?.serial" class="pg-details__note" data-test="serial-note">
        Auto incremento (serial): el valor lo da su secuencia. Vortaq no lo convierte en identity.
      </div>
      <v-select
        v-if="current.autoIncrement && !current.pg?.serial"
        :model-value="current.pg?.identity ?? 'by-default'"
        :items="[
          { title: 'Por defecto (BY DEFAULT)', value: 'by-default' },
          { title: 'Siempre (ALWAYS)', value: 'always' }
        ]"
        label="Identity"
        :disabled="autoLocked(current)"
        density="compact"
        variant="outlined"
        hide-details
        class="pg-details__field"
        data-test="identity-select"
        @update:model-value="patchPg(selected, { identity: $event })"
      />
      <v-text-field
        v-if="typeChanged(current)"
        :model-value="current.pg?.using ?? ''"
        label="USING (conversión del tipo)"
        :placeholder="`${current.originalName}::${current.columnType}`"
        hint="Expresión que convierte los valores existentes al nuevo tipo"
        persistent-hint
        density="compact"
        variant="outlined"
        class="pg-details__field"
        data-test="using-field"
        @update:model-value="patchPg(selected, { using: $event || undefined })"
      />
      <div v-if="currentEnum" class="pg-details__enum" data-test="enum-editor">
        <div class="pg-details__label">Valores de {{ currentEnum.key }}</div>
        <div class="pg-details__chips">
          <v-chip v-for="l in currentEnum.labels" :key="l" size="small" label>{{ l }}</v-chip>
          <v-chip
            v-for="l in currentEnum.added"
            :key="`+${l}`"
            size="small"
            label
            color="primary"
            closable
            :data-test="`enum-added-${l}`"
            @click:close="removeLabel(l)"
            >+ {{ l }}</v-chip
          >
        </div>
        <div class="d-flex ga-2 align-center">
          <v-text-field
            v-model="newLabel"
            label="Añadir valor"
            density="compact"
            variant="outlined"
            hide-details
            class="pg-details__field"
            data-test="enum-new-label"
            @keyup.enter="addLabel"
          />
          <v-btn size="small" prepend-icon="mdi-plus" data-test="enum-add" @click="addLabel"
            >Añadir</v-btn
          >
        </div>
        <div class="pg-details__note">
          Los valores nuevos se añaden con ALTER TYPE … ADD VALUE antes de la transacción.
        </div>
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
  width: 22%;
}
.w-type {
  width: 220px;
}
.w-check {
  width: 56px;
}
.w-default {
  width: 22%;
}
.pg-details {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--nd-hairline);
  background: var(--nd-bg-raised);
}
.pg-details__title,
.pg-details__label {
  font-size: var(--nd-fs-small);
  font-weight: 600;
  color: var(--nd-text-2);
}
.pg-details__note {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.pg-details__field {
  max-width: 420px;
}
.pg-details__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
</style>
