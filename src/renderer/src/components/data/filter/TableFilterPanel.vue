<script setup lang="ts">
import { computed, ref } from 'vue'
import type { QueryColumn, TableFilterProfile } from '@shared/types'
import FilterConditionLine from './FilterConditionLine.vue'
import { CONNECTOR_LABEL, filterLines, type FilterLine, type FilterPanelState } from './filterModel'
import type { FilterAction } from './useTableFilter'

/**
 * Filter panel (presentational): the filter reads as sentences,
 * one line per condition, brackets on their own lines, "+" / "(+" to add, a
 * right-click menu for structure edits and filter profiles, and a raw WHERE
 * text mode. State and actions live in useTableFilter.
 */
const props = defineProps<{
  state: FilterPanelState
  columns: QueryColumn[]
  profiles: TableFilterProfile[]
  showProblems: boolean
  isApplied: boolean
  pendingApply: boolean
  activeCount: number
  /** First incomplete condition, shown and highlighted after a refused apply. */
  problem: { id: string; message: string } | null
  busy: boolean
}>()

const emit = defineEmits<{
  action: [action: FilterAction]
  'set-text': [text: string]
  'toggle-mode': []
  apply: []
  clear: []
  'menu-open': []
  'load-profile': [name: string]
  'save-profile': [name: string]
  'delete-profile': [name: string]
}>()

const lines = computed(() => filterLines(props.state.root))
const textMode = computed(() => props.state.mode === 'text')
const INDENT = 18

function act(action: FilterAction): void {
  emit('action', action)
}

function onPanelKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    emit('apply')
  }
}

function onTextKeydown(event: KeyboardEvent): void {
  // Enter applies (Shift+Enter keeps a new line for long conditions).
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    emit('apply')
  }
}

/* ---------- context menu ---------- */

type MenuKind = 'condition' | 'group' | 'short'
const menu = ref<{ open: boolean; x: number; y: number; kind: MenuKind; id: string | null }>({
  open: false,
  x: 0,
  y: 0,
  kind: 'short',
  id: null
})

/** Right-click on a line (long menu) or on a closing bracket / the empty area (short menu). */
function openMenu(event: MouseEvent, line: FilterLine | null): void {
  event.preventDefault()
  event.stopPropagation()
  const kind: MenuKind =
    !line || line.type === 'close' ? 'short' : line.type === 'open' ? 'group' : 'condition'
  const id = line ? line.node.id : null
  if (id) act({ type: 'select', id })
  menu.value = { open: true, x: event.clientX, y: event.clientY, kind, id }
  emit('menu-open')
}

function run(action: FilterAction): void {
  menu.value.open = false
  act(action)
}

const hasProfiles = computed(() => props.profiles.length > 0)

/* ---------- profile name dialog ---------- */

const nameDialog = ref(false)
const profileName = ref('')
function saveProfile(asNew: boolean): void {
  menu.value.open = false
  if (!asNew && props.state.profile) {
    emit('save-profile', props.state.profile)
    return
  }
  profileName.value = asNew && props.state.profile ? `${props.state.profile} (copia)` : ''
  nameDialog.value = true
}
function confirmName(): void {
  const name = profileName.value.trim()
  if (!name) return
  nameDialog.value = false
  emit('save-profile', name)
}
function pickProfile(event: 'load-profile' | 'delete-profile', name: string): void {
  menu.value.open = false
  if (event === 'load-profile') emit('load-profile', name)
  else emit('delete-profile', name)
}

defineExpose({ openMenu })
</script>

<template>
  <section
    class="fpanel"
    :class="{ 'is-applied': isApplied }"
    aria-label="Filtro"
    data-test="filter-panel"
    @keydown="onPanelKeydown"
  >
    <div class="fpanel__bar">
      <v-btn
        size="small"
        variant="tonal"
        color="primary"
        prepend-icon="mdi-filter-check-outline"
        :class="{ 'is-pending': pendingApply }"
        :disabled="busy"
        :title="
          problem?.message ??
          (pendingApply ? 'Hay cambios en el filtro sin aplicar (Cmd+Enter)' : 'Cmd+Enter')
        "
        data-test="apply-filter"
        @click="emit('apply')"
        >Aplicar filtro</v-btn
      >
      <v-btn
        size="small"
        variant="text"
        :disabled="busy || (!isApplied && !state.root.children.length && !state.text)"
        title="Quita el filtro y vuelve a cargar todas las filas"
        data-test="filter-clear"
        @click="emit('clear')"
        >Limpiar</v-btn
      >
      <span class="nd-viewbar__sep" aria-hidden="true" />
      <v-switch
        :model-value="textMode"
        color="primary"
        density="compact"
        hide-details
        :disabled="busy"
        aria-label="Editar como texto (WHERE)"
        class="fpanel__mode"
        data-test="filter-text-mode"
        @update:model-value="emit('toggle-mode')"
      >
        <template #label>Editar como texto (WHERE)</template>
      </v-switch>
      <span class="nd-viewbar__spacer" />
      <span
        v-if="state.profile"
        class="fpanel__profile"
        :title="`Perfil: ${state.profile}`"
        data-test="filter-profile"
      >
        <v-icon icon="mdi-bookmark-outline" size="13" />{{ state.profile }}
      </span>
      <span v-if="!textMode" class="fpanel__count">{{ activeCount }} activa(s)</span>
    </div>

    <div v-if="textMode" class="fpanel__text">
      <v-textarea
        :model-value="state.text"
        rows="1"
        auto-grow
        max-rows="6"
        density="compact"
        prefix="WHERE"
        placeholder="p. ej. id > 10 AND estado = 'activo'"
        aria-label="Filtro WHERE"
        hide-details
        class="fpanel__where"
        data-test="where"
        @update:model-value="emit('set-text', $event ?? '')"
        @keydown="onTextKeydown"
      />
      <p class="fpanel__note">
        Editar el texto lo convierte en SQL propio (se ejecuta tal cual). Al volver al editor visual
        se descarta el texto editado.
      </p>
    </div>

    <div
      v-else
      class="fpanel__lines"
      role="tree"
      aria-label="Condiciones del filtro"
      data-test="filter-lines"
      @contextmenu="openMenu($event, null)"
      @click.self="act({ type: 'select', id: null })"
    >
      <div
        v-for="line in lines"
        :key="`${line.type}-${line.node.id}`"
        class="fline"
        :class="{
          'is-selected': state.selectedId === line.node.id && line.type !== 'close',
          'is-disabled': !line.node.enabled,
          'is-invalid': showProblems && problem?.id === line.node.id
        }"
        :style="{ paddingLeft: `${8 + line.depth * INDENT}px` }"
        role="treeitem"
        :aria-selected="state.selectedId === line.node.id"
        :data-test="`filter-line-${line.type}`"
        @click="act({ type: 'select', id: line.node.id })"
        @contextmenu="openMenu($event, line)"
      >
        <template v-if="line.type === 'condition'">
          <input
            type="checkbox"
            class="fline__check"
            :checked="line.node.enabled"
            aria-label="Condición activa"
            data-test="filter-check"
            @click.stop
            @change="act({ type: 'toggle-enabled', id: line.node.id })"
          />
          <FilterConditionLine
            :node="line.node"
            :columns="columns"
            :has-next="line.hasNext"
            :invalid="showProblems && problem?.id === line.node.id"
            @patch="act({ type: 'patch', id: line.node.id, patch: $event })"
            @toggle-connector="act({ type: 'toggle-connector', id: line.node.id })"
            @submit="emit('apply')"
          />
        </template>
        <template v-else-if="line.type === 'open'">
          <input
            type="checkbox"
            class="fline__check"
            :checked="line.node.enabled"
            aria-label="Paréntesis activo"
            data-test="filter-check"
            @click.stop
            @change="act({ type: 'toggle-enabled', id: line.node.id })"
          />
          <span class="fline__paren">(</span>
        </template>
        <template v-else>
          <span class="fline__check-space" aria-hidden="true" />
          <span class="fline__paren">)</span>
          <button
            v-if="line.hasNext"
            type="button"
            class="ftok ftok--connector"
            :aria-label="`Conector ${line.node.connector}`"
            data-test="filter-connector"
            @click.stop="act({ type: 'toggle-connector', id: line.node.id })"
          >
            {{ CONNECTOR_LABEL[line.node.connector] }}
          </button>
          <span class="fline__adders">
            <button
              type="button"
              class="fadd"
              title="Añadir condición dentro del paréntesis"
              aria-label="Añadir condición dentro del paréntesis"
              data-test="filter-group-add"
              @click.stop="act({ type: 'insert', target: line.node.id })"
            >
              +
            </button>
            <button
              type="button"
              class="fadd"
              title="Añadir paréntesis dentro del paréntesis"
              aria-label="Añadir paréntesis dentro del paréntesis"
              data-test="filter-group-add-group"
              @click.stop="act({ type: 'insert-group', target: line.node.id })"
            >
              (+
            </button>
          </span>
        </template>
      </div>

      <div class="fline fline--root" @click.self="act({ type: 'select', id: null })">
        <span class="fline__adders">
          <button
            type="button"
            class="fadd"
            :disabled="!columns.length"
            title="Añadir condición"
            aria-label="Añadir condición"
            data-test="filter-add"
            @click.stop="act({ type: 'insert', target: null })"
          >
            +
          </button>
          <button
            type="button"
            class="fadd"
            :disabled="!columns.length"
            title="Añadir paréntesis"
            aria-label="Añadir paréntesis"
            data-test="filter-add-group"
            @click.stop="act({ type: 'insert-group', target: null })"
          >
            (+
          </button>
        </span>
        <span v-if="!lines.length" class="fline__empty"
          >Sin condiciones: pulsa + o haz clic derecho para añadir.</span
        >
        <span v-else-if="showProblems && problem" class="fline__problem" role="alert">
          <v-icon icon="mdi-alert-circle-outline" size="13" /> {{ problem.message }}: completa la
          condición marcada o desactívala.
        </span>
      </div>
    </div>

    <v-menu
      v-model="menu.open"
      :target="[menu.x, menu.y]"
      location="bottom start"
      :close-on-content-click="false"
    >
      <v-list density="compact" class="fctx" data-test="filter-context-menu">
        <template v-if="menu.kind !== 'short'">
          <v-list-item
            title="Insertar condición"
            prepend-icon="mdi-plus"
            data-test="ctx-insert"
            @click="run({ type: 'insert', target: menu.id })"
          />
          <v-list-item
            title="Insertar paréntesis"
            prepend-icon="mdi-code-parentheses"
            data-test="ctx-insert-group"
            @click="run({ type: 'insert-group', target: menu.id })"
          />
          <v-list-item
            title="Agrupar con paréntesis"
            prepend-icon="mdi-format-list-group"
            data-test="ctx-wrap"
            @click="run({ type: 'wrap', id: menu.id ?? '' })"
          />
          <v-divider />
          <v-list-item
            v-if="menu.kind === 'condition'"
            title="Borrar condición"
            prepend-icon="mdi-close"
            data-test="ctx-remove"
            @click="run({ type: 'remove', id: menu.id ?? '' })"
          />
          <template v-else>
            <v-list-item
              title="Borrar paréntesis"
              prepend-icon="mdi-code-parentheses-box"
              data-test="ctx-unwrap"
              @click="run({ type: 'unwrap', id: menu.id ?? '' })"
            />
            <v-list-item
              title="Borrar paréntesis y condiciones"
              prepend-icon="mdi-close-box-multiple-outline"
              data-test="ctx-remove-group"
              @click="run({ type: 'remove', id: menu.id ?? '' })"
            />
          </template>
        </template>
        <v-list-item
          v-else
          title="Añadir condición"
          prepend-icon="mdi-plus"
          data-test="ctx-add"
          @click="run({ type: 'insert', target: menu.id })"
        />
        <v-list-item
          title="Limpiar todo"
          prepend-icon="mdi-broom"
          data-test="ctx-clear-all"
          @click="run({ type: 'clear-all' })"
        />
        <v-divider />
        <v-menu location="end" open-on-hover :disabled="!hasProfiles" :open-delay="60">
          <template #activator="{ props: subProps }">
            <v-list-item
              v-bind="subProps"
              title="Cargar perfil"
              prepend-icon="mdi-bookmark-outline"
              append-icon="mdi-chevron-right"
              :disabled="!hasProfiles"
              data-test="ctx-load-profile"
            />
          </template>
          <v-list density="compact" class="fctx">
            <v-list-item
              v-for="p in profiles"
              :key="p.name"
              :title="p.name"
              :active="p.name === state.profile"
              :data-test="`ctx-load-${p.name}`"
              @click="pickProfile('load-profile', p.name)"
            />
          </v-list>
        </v-menu>
        <v-list-item
          title="Guardar perfil"
          prepend-icon="mdi-content-save-outline"
          :subtitle="state.profile ?? undefined"
          data-test="ctx-save-profile"
          @click="saveProfile(false)"
        />
        <v-list-item
          title="Guardar perfil como…"
          prepend-icon="mdi-content-save-edit-outline"
          data-test="ctx-save-profile-as"
          @click="saveProfile(true)"
        />
        <v-menu location="end" open-on-hover :disabled="!hasProfiles" :open-delay="60">
          <template #activator="{ props: subProps }">
            <v-list-item
              v-bind="subProps"
              title="Eliminar perfil"
              prepend-icon="mdi-bookmark-remove-outline"
              append-icon="mdi-chevron-right"
              :disabled="!hasProfiles"
              data-test="ctx-delete-profile"
            />
          </template>
          <v-list density="compact" class="fctx">
            <v-list-item
              v-for="p in profiles"
              :key="p.name"
              :title="p.name"
              :data-test="`ctx-delete-${p.name}`"
              @click="pickProfile('delete-profile', p.name)"
            />
          </v-list>
        </v-menu>
      </v-list>
    </v-menu>

    <v-dialog v-model="nameDialog" max-width="400">
      <v-card>
        <v-card-title class="d-flex align-center ga-3">
          <span class="nd-icon-badge"><v-icon icon="mdi-bookmark-outline" size="18" /></span>
          Guardar perfil de filtro
        </v-card-title>
        <v-card-text>
          <v-text-field
            v-model="profileName"
            label="Nombre del perfil"
            autofocus
            hint="Se guarda para esta tabla de esta conexión; un nombre existente se sobrescribe."
            persistent-hint
            data-test="profile-name"
            @keydown.enter="confirmName"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="nameDialog = false">Cancelar</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :disabled="!profileName.trim()"
            data-test="profile-name-confirm"
            @click="confirmName"
            >Guardar</v-btn
          >
        </v-card-actions>
      </v-card>
    </v-dialog>
  </section>
</template>

<style scoped src="./filterTokens.css"></style>
<style scoped>
.fpanel {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--nd-hairline);
  background: var(--nd-bg-sunken);
}
.fpanel__bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px 4px;
  min-height: 36px;
  padding: 3px 10px 3px 8px;
  border-bottom: 1px solid var(--nd-hairline);
  background: var(--nd-bg-raised);
}
.is-pending {
  box-shadow: 0 0 0 1px rgba(var(--nd-accent-rgb), 0.55);
}
.fpanel__mode {
  flex: none;
}
.fpanel__mode :deep(.v-label) {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  opacity: 1;
  white-space: nowrap;
}
.fpanel__mode :deep(.v-selection-control) {
  min-height: 26px;
}
.fpanel__profile {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.fpanel__count {
  margin-left: 8px;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.fpanel__lines {
  max-height: 34vh;
  overflow-y: auto;
  padding: 4px 0 6px;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
  line-height: 20px;
}
.fline {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 24px;
  padding-right: 10px;
  cursor: default;
  user-select: none;
}
.fline:hover {
  background: color-mix(in srgb, var(--nd-hover) 60%, transparent);
}
.fline.is-selected {
  background: rgba(var(--nd-accent-rgb), 0.1);
  box-shadow: inset 2px 0 0 rgba(var(--nd-accent-rgb), 0.7);
}
.fline.is-invalid {
  background: var(--nd-error-soft);
}
.fline.is-disabled > :not(.fline__check) {
  opacity: 0.42;
}
.fline__check {
  flex: none;
  width: 13px;
  height: 13px;
  margin: 0 4px 0 0;
  accent-color: rgb(var(--nd-accent-rgb));
  cursor: pointer;
}
.fline__check-space {
  flex: none;
  width: 17px;
}
.fline__paren {
  padding: 0 2px;
  font-weight: 700;
  color: var(--nd-text-2);
}
.fline__adders {
  display: inline-flex;
  gap: 4px;
  margin-left: 6px;
}
.fline--root {
  padding-left: 8px;
  min-height: 28px;
}
.fline--root .fline__adders {
  margin-left: 0;
}
.fadd {
  height: 20px;
  min-width: 26px;
  padding: 0 5px;
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-sm);
  background: var(--nd-bg-raised);
  font: inherit;
  font-weight: 600;
  line-height: 18px;
  color: var(--nd-text-2);
  cursor: pointer;
}
.fadd:hover:not(:disabled) {
  color: var(--nd-accent);
  border-color: rgba(var(--nd-accent-rgb), 0.55);
}
.fadd:disabled {
  opacity: 0.4;
  cursor: default;
}
.fline__empty {
  margin-left: 8px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.fline__problem {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-error);
}
.fpanel__text {
  padding: 6px 10px;
}
.fpanel__where :deep(.v-text-field__prefix) {
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  font-weight: 600;
  color: var(--nd-violet);
  opacity: 1;
  padding-inline-end: 8px;
  align-self: flex-start;
}
.fpanel__where :deep(textarea) {
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
}
.fpanel__note {
  margin: 4px 2px 0;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.fctx :deep(.v-list-item) {
  min-height: 28px !important;
}
.fctx :deep(.v-list-item-title) {
  font-size: var(--nd-fs-dense);
}
.fctx :deep(.v-list-item__prepend > .v-icon) {
  margin-inline-end: 10px;
  font-size: 16px;
}
</style>
