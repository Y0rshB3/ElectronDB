<script setup lang="ts">
import { computed, ref } from 'vue'
import type { QueryColumn } from '@shared/types'
import { typeLabel, valueHint } from '../columnKind'
import { temporalSpec } from '../temporal'
import FilterValueToken from './FilterValueToken.vue'
import {
  CONNECTOR_LABEL,
  FILTER_OPERATORS,
  operatorInfo,
  splitList,
  type FilterConditionPatch,
  type FilterConditionState
} from './filterModel'

/**
 * One condition as a Navicat sentence: <column> <operator> <value> [Tipo] <y/o>.
 * Every word is a token: column and operator open a menu, values edit inline,
 * the connector toggles y/o.
 */
const props = defineProps<{
  node: FilterConditionState
  columns: QueryColumn[]
  hasNext: boolean
  invalid: boolean
}>()

const emit = defineEmits<{
  patch: [patch: FilterConditionPatch]
  'toggle-connector': []
  submit: []
}>()

const arity = computed(() => operatorInfo(props.node.operator).arity)
const column = computed(() => props.columns.find((c) => c.name === props.node.column))
const hint = computed(() => valueHint(column.value?.type))
const kind = computed(() => typeLabel(column.value?.type))
/** Calendar picker for date/time columns compared by value (not for contiene & co.). */
const LIKE_OPS = new Set([
  'contains',
  'notContains',
  'beginsWith',
  'notBeginsWith',
  'endsWith',
  'notEndsWith'
])
const temporal = computed(() =>
  LIKE_OPS.has(props.node.operator) ? null : temporalSpec(column.value?.type)
)

const COLUMN_PLACEHOLDER = '<columna>'
const columnSearch = ref('')
const columnMenu = ref(false)
const filteredColumns = computed(() => {
  const q = columnSearch.value.trim().toLowerCase()
  return q ? props.columns.filter((c) => c.name.toLowerCase().includes(q)) : props.columns
})

function pickColumn(name: string): void {
  columnMenu.value = false
  columnSearch.value = ''
  emit('patch', { column: name })
}

function setValue(index: number, value: string): void {
  const values = [...props.node.values]
  while (values.length <= index) values.push('')
  values[index] = value
  emit('patch', { values })
}

const listMenu = ref(false)
const listDraft = ref('')
function openList(open: boolean): void {
  if (open) listDraft.value = props.node.values.filter((v) => v !== '').join('\n')
  listMenu.value = open
}
function commitList(): void {
  emit('patch', { values: splitList(listDraft.value) })
  listMenu.value = false
}
const listText = computed(() => {
  const items = props.node.values.filter((v) => v !== '')
  return items.length ? `(${items.join(', ')})` : '<?>'
})
</script>

<template>
  <span class="fcond" data-test="filter-condition">
    <v-menu
      v-if="arity !== 'sql'"
      v-model="columnMenu"
      location="bottom start"
      :close-on-content-click="false"
    >
      <template #activator="{ props: menuProps }">
        <button
          type="button"
          class="ftok ftok--column"
          :class="{ 'is-placeholder': !node.column }"
          v-bind="menuProps"
          aria-label="Columna"
          data-test="filter-column-token"
          @click.stop
        >
          {{ node.column || COLUMN_PLACEHOLDER }}
        </button>
      </template>
      <v-card class="fmenu" min-width="220">
        <v-text-field
          v-if="columns.length > 8"
          v-model="columnSearch"
          density="compact"
          hide-details
          autofocus
          placeholder="Buscar columna"
          prepend-inner-icon="mdi-magnify"
          class="fmenu__search"
          data-test="filter-column-search"
        />
        <v-list density="compact" max-height="300" class="fmenu__list" aria-label="Columnas">
          <v-list-item
            v-for="c in filteredColumns"
            :key="c.name"
            :active="c.name === node.column"
            :data-test="`filter-column-option-${c.name}`"
            @click="pickColumn(c.name)"
          >
            <template #prepend>
              <v-icon
                :icon="c.name === node.column ? 'mdi-check' : 'mdi-blank'"
                size="14"
                class="fmenu__check"
              />
            </template>
            <v-list-item-title class="fmenu__name">{{ c.name }}</v-list-item-title>
            <template #append>
              <span class="fmenu__type">{{ c.type }}</span>
            </template>
          </v-list-item>
          <v-list-item v-if="!filteredColumns.length" disabled title="Sin columnas" />
        </v-list>
      </v-card>
    </v-menu>

    <v-menu location="bottom start">
      <template #activator="{ props: menuProps }">
        <button
          type="button"
          class="ftok ftok--operator"
          v-bind="menuProps"
          aria-label="Operador"
          data-test="filter-operator-token"
          @click.stop
        >
          {{ operatorInfo(node.operator).label }}
        </button>
      </template>
      <v-list density="compact" class="fmenu__list fmenu__ops" aria-label="Operadores">
        <v-list-item
          v-for="o in FILTER_OPERATORS"
          :key="o.value"
          :active="o.value === node.operator"
          :data-test="`filter-operator-option-${o.value}`"
          @click="emit('patch', { operator: o.value })"
        >
          <template #prepend>
            <v-icon
              :icon="o.value === node.operator ? 'mdi-check' : 'mdi-blank'"
              size="14"
              class="fmenu__check"
            />
          </template>
          <v-list-item-title>{{ o.label }}</v-list-item-title>
        </v-list-item>
      </v-list>
    </v-menu>

    <template v-if="arity === 'one'">
      <FilterValueToken
        :model-value="node.values[0] ?? ''"
        :hint="hint.placeholder"
        :inputmode="hint.inputmode"
        :temporal="temporal"
        :invalid="invalid && (node.values[0] ?? '') === ''"
        label="Valor"
        @update:model-value="setValue(0, $event)"
        @submit="emit('submit')"
      />
    </template>
    <template v-else-if="arity === 'two'">
      <FilterValueToken
        :model-value="node.values[0] ?? ''"
        :hint="hint.placeholder"
        :inputmode="hint.inputmode"
        :temporal="temporal"
        :invalid="invalid && (node.values[0] ?? '') === ''"
        label="Desde"
        @update:model-value="setValue(0, $event)"
        @submit="emit('submit')"
      />
      <span class="fcond__word">y</span>
      <FilterValueToken
        :model-value="node.values[1] ?? ''"
        :hint="hint.placeholder"
        :inputmode="hint.inputmode"
        :temporal="temporal"
        :invalid="invalid && (node.values[1] ?? '') === ''"
        label="Hasta"
        @update:model-value="setValue(1, $event)"
        @submit="emit('submit')"
      />
    </template>
    <v-menu
      v-else-if="arity === 'list'"
      :model-value="listMenu"
      location="bottom start"
      :close-on-content-click="false"
      @update:model-value="openList"
    >
      <template #activator="{ props: menuProps }">
        <button
          type="button"
          class="ftok ftok--value"
          :class="{ 'is-empty': listText === '<?>', 'is-invalid': invalid }"
          v-bind="menuProps"
          aria-label="Valores de la lista"
          data-test="filter-list-token"
          @click.stop
        >
          {{ listText }}
        </button>
      </template>
      <v-card class="fmenu fmenu__listedit" width="280">
        <v-textarea
          v-model="listDraft"
          rows="4"
          auto-grow
          max-rows="10"
          density="compact"
          hide-details
          autofocus
          :placeholder="`Un valor por línea o separados por comas (${hint.placeholder})`"
          aria-label="Valores de la lista"
          data-test="filter-list-input"
          @keydown.enter.meta.prevent="commitList"
          @keydown.enter.ctrl.prevent="commitList"
        />
        <div class="fmenu__actions">
          <span class="fmenu__count">{{ splitList(listDraft).length }} valor(es)</span>
          <v-btn size="small" variant="text" @click="listMenu = false">Cancelar</v-btn>
          <v-btn
            size="small"
            variant="tonal"
            color="primary"
            data-test="filter-list-accept"
            @click="commitList"
            >Aceptar</v-btn
          >
        </div>
      </v-card>
    </v-menu>
    <FilterValueToken
      v-else-if="arity === 'sql'"
      :model-value="node.sql"
      hint="p. ej. precio * cantidad > 100"
      :invalid="invalid && !node.sql.trim()"
      label="Condición SQL"
      sql
      @update:model-value="emit('patch', { sql: $event })"
      @submit="emit('submit')"
    />

    <span
      v-if="kind && arity !== 'none' && arity !== 'sql'"
      class="fcond__type"
      data-test="filter-type-hint"
      >[{{ kind }}]</span
    >
    <button
      v-if="hasNext"
      type="button"
      class="ftok ftok--connector"
      :title="
        node.connector === 'AND'
          ? 'y (AND): clic para cambiar a o'
          : 'o (OR): clic para cambiar a y'
      "
      :aria-label="`Conector ${node.connector}`"
      data-test="filter-connector"
      @click.stop="emit('toggle-connector')"
    >
      {{ CONNECTOR_LABEL[node.connector] }}
    </button>
  </span>
</template>

<style scoped src="./filterTokens.css"></style>
<style scoped>
.fcond {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}
.ftok.is-placeholder {
  color: var(--nd-text-muted);
  font-style: italic;
}
.fcond__word {
  padding: 0 2px;
  color: var(--nd-text-2);
}
.fcond__type {
  margin-left: 4px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.fmenu__check {
  margin-inline-end: 8px !important;
  color: var(--nd-accent);
}
.fmenu__type {
  margin-left: 16px;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.fmenu__list :deep(.v-list-item) {
  min-height: 28px !important;
}
.fmenu__list :deep(.v-list-item-title) {
  font-size: var(--nd-fs-dense);
}
.fmenu__search {
  padding: 6px 8px 0;
}
.fmenu__listedit {
  padding: 8px;
}
.fmenu__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
}
.fmenu__count {
  flex: 1 1 auto;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
</style>
