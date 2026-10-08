<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { engineOf } from '@shared/engines'
import type { BackupFile, ConnectionConfig, JobTask } from '@shared/types'
import { useBackupsStore } from '@renderer/stores/backups'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useQueriesStore } from '@renderer/stores/queries'
import { useSettingsStore } from '@renderer/stores/settings'
import { ENVIRONMENT_LABELS } from '@renderer/utils/objectTypes'
import { formatDate } from '@renderer/utils/format'
import { useSchemaLoader } from '@renderer/components/backups/useSchemaLoader'
import { automationConnections } from '@renderer/components/backups/backupHelpers'
import { TASK_ICONS, defaultReferenceName } from './jobForm'
import {
  STEP_KINDS,
  backupStep,
  connectionsForKind,
  inJob,
  restorableSteps,
  restoreFromLatest,
  restoreFromStep,
  restoresOf,
  savedQueriesFor,
  savedQueryStep,
  sqlStep,
  visibleDatabases,
  type StepKind
} from './jobSteps'
import { ADD_DRAG_TYPE, endAddDrag, startAddDrag } from './stepDrag'

/**
 * «Añadir pasos»: pick a kind of step, browse connection › database and add
 * the available items to the job (double click, «Añadir» with several
 * checked, or dragging them onto the sequence). Connections are opened only
 * when the user expands them.
 */
const props = defineProps<{ tasks: JobTask[] }>()
const emit = defineEmits<{ add: [tasks: JobTask[]] }>()

const connections = useConnectionsStore()
const settings = useSettingsStore()
const queries = useQueriesStore()
const backups = useBackupsStore()
const schemaLoader = useSchemaLoader()

const kind = ref<StepKind>('backup')
const filter = ref('')
const selectedConnection = ref<string | null>(null)
const selectedDatabase = ref<string | null>(null)
const expanded = ref<Record<string, boolean>>({})
const checked = ref<string[]>([])

const kindMeta = computed(() => STEP_KINDS.find((k) => k.value === kind.value)!)

const kindConnections = computed(() => connectionsForKind(kind.value, connections.sorted))
const filteredConnections = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return kindConnections.value
  return kindConnections.value.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      visibleDatabases(c, schemaLoader.of(c.id)).some((d) => d.toLowerCase().includes(q))
  )
})

function databasesOf(c: ConnectionConfig): string[] {
  const all = visibleDatabases(c, schemaLoader.of(c.id))
  const q = filter.value.trim().toLowerCase()
  if (!q || c.name.toLowerCase().includes(q)) return all
  return all.filter((d) => d.toLowerCase().includes(q))
}

const connection = computed(() =>
  selectedConnection.value ? (connections.get(selectedConnection.value) ?? null) : null
)

// A kind that cannot use the selected connection clears the selection.
watch(kind, () => {
  checked.value = []
  if (
    selectedConnection.value &&
    !kindConnections.value.some((c) => c.id === selectedConnection.value)
  ) {
    selectedConnection.value = null
    selectedDatabase.value = null
  }
})
watch([selectedConnection, selectedDatabase], () => (checked.value = []))

const ENV_PILL: Record<string, string> = {
  production: 'nd-pill--production',
  staging: 'nd-pill--staging',
  local: 'nd-pill--local'
}

/** Expanding a connection lists its databases (and opens it: a user action). */
async function toggle(c: ConnectionConfig, open?: boolean): Promise<void> {
  const next = open ?? !expanded.value[c.id]
  expanded.value = { ...expanded.value, [c.id]: next }
  if (next) await schemaLoader.load(c.id)
}

function selectConnection(c: ConnectionConfig): void {
  selectedConnection.value = c.id
  selectedDatabase.value = null
  // Saved queries are stored locally: listing them needs no connection.
  if (kind.value !== 'savedQuery' && !expanded.value[c.id]) void toggle(c, true)
}

function selectDatabase(c: ConnectionConfig, name: string): void {
  selectedConnection.value = c.id
  selectedDatabase.value = name
}

function onConnectionKey(event: KeyboardEvent, c: ConnectionConfig): void {
  if (event.key === 'ArrowRight' && !expanded.value[c.id]) void toggle(c, true)
  else if (event.key === 'ArrowLeft' && expanded.value[c.id]) void toggle(c, false)
  else return
  event.preventDefault()
}

const blocked = (c: ConnectionConfig): boolean => settings.needsTypedConfirm(c.environment)
const usable = computed(() => automationConnections(connections.sorted))

/* ---------- available items ---------- */

interface Item {
  key: string
  icon: string
  title: string
  subtitle: string
  mono?: boolean
  inJob?: string
  build: () => JobTask[]
}
interface ItemGroup {
  key: string
  title: string
  items: Item[]
  empty?: string
}

/** Job copies of the selected database found on disk (restore kind). */
const latestFiles = ref<BackupFile[]>([])
const latestLoading = ref(false)
watch(
  () => [kind.value, selectedConnection.value, selectedDatabase.value] as const,
  async ([k, connectionId, schema]) => {
    latestFiles.value = []
    if (k !== 'restore' || !connectionId || !schema) return
    latestLoading.value = true
    try {
      const files = await backups.load(connectionId, schema)
      if (selectedConnection.value === connectionId && selectedDatabase.value === schema)
        latestFiles.value = files.filter((f) => f.run && f.run.includeData !== false)
    } catch {
      latestFiles.value = []
    } finally {
      latestLoading.value = false
    }
  }
)

function databaseItems(c: ConnectionConfig): string[] {
  const all = visibleDatabases(c, schemaLoader.of(c.id))
  return selectedDatabase.value ? all.filter((d) => d === selectedDatabase.value) : all
}

const groups = computed<ItemGroup[]>(() => {
  const c = connection.value
  const db = selectedDatabase.value
  const tasks = props.tasks
  if (kind.value === 'restore') {
    const steps = restorableSteps(tasks)
    const out: ItemGroup[] = [
      {
        key: 'steps',
        title: 'Copias que hace esta tarea',
        empty:
          'Añade antes un paso de copia de seguridad para restaurar lo que copie en la misma ejecución.',
        items: steps.map(({ task, index }) => {
          const used = restoresOf(task.id, tasks).length
          return {
            key: `step:${task.id}`,
            icon: TASK_ICONS.backupschema,
            title: `Copia del paso ${index + 1} · ${task.schema || defaultReferenceName(task)}`,
            subtitle: `${connections.nameOf(task.connectionId)}${task.includeData === false ? ' · solo estructura' : ''}${task.format === 'vqb' ? ` · .vqb${task.encrypt ? ' cifrada' : ''}` : ' · .nb3'}`,
            inJob: used ? (used === 1 ? 'ya se restaura' : `se restaura ${used} veces`) : undefined,
            build: () => [restoreFromStep(task, usable.value, blocked)]
          }
        })
      }
    ]
    if (c) {
      const names = databaseItems(c)
      out.push({
        key: 'latest',
        title: `Última copia en disco · ${c.name}`,
        empty: schemaLoader.isLoading(c.id)
          ? 'Cargando bases de datos…'
          : schemaLoader.errorOf(c.id)
            ? schemaLoader.errorOf(c.id)
            : 'Sin bases de datos.',
        items: names.map((name) => ({
          key: `latest:${c.id}:${name}`,
          icon: 'mdi-archive-clock-outline',
          title: `Última copia de ${name}`,
          subtitle:
            db === name
              ? latestLoading.value
                ? 'Buscando copias…'
                : latestFiles.value.length
                  ? `${latestFiles.value.length} copia(s) de tareas en disco · la más reciente del ${formatDate(latestFiles.value[0].createdAt)}`
                  : 'Aún no hay copias de tareas en disco: la ejecución usará la que exista entonces.'
              : 'La copia con datos más reciente hecha por una tarea',
          build: () => [restoreFromLatest(c, name, usable.value, blocked)]
        }))
      })
    }
    return out
  }
  if (!c) return []
  if (kind.value === 'backup') {
    return [
      {
        key: 'dbs',
        title: `Bases de datos · ${c.name}`,
        empty: schemaLoader.isLoading(c.id)
          ? 'Cargando bases de datos…'
          : (schemaLoader.errorOf(c.id) ?? 'Sin bases de datos.'),
        items: databaseItems(c).map((name) => ({
          key: `backup:${c.id}:${name}`,
          icon: 'mdi-database-outline',
          title: name,
          subtitle: `Copia ${engineOf(c).id === 'mysql' || engineOf(c).id === 'mariadb' ? 'en .vqb (o .nb3/.sql en sus ajustes)' : 'en .vqb'}`,
          inJob: inJob(tasks, 'backupschema', c.id, name) ? 'ya en la tarea' : undefined,
          build: () => [backupStep(c, name)]
        }))
      }
    ]
  }
  if (kind.value === 'savedQuery') {
    const list = savedQueriesFor(queries.list(c.id), db)
    return [
      {
        key: 'queries',
        title: `Consultas guardadas · ${db ?? c.name}`,
        empty: db
          ? `No hay consultas guardadas en ${db}. Elige la conexión para verlas todas, o guarda una desde una pestaña de consulta («Guardar consulta»).`
          : 'Esta conexión no tiene consultas guardadas. Guárdalas desde una pestaña de consulta («Guardar consulta»).',
        items: list.map((q) => {
          const first = q.sql.split('\n').find((l) => l.trim()) ?? ''
          return {
            key: `query:${c.id}:${q.id}`,
            icon: 'mdi-bookmark-outline',
            title: q.name,
            subtitle: `${q.schema ?? 'sin base de datos'} · ${first.trim().slice(0, 70)}`,
            mono: true,
            inJob: tasks.some(
              (t) => t.type === 'runquery' && t.connectionId === c.id && t.sql === q.sql
            )
              ? 'ya en la tarea'
              : undefined,
            build: () => [savedQueryStep(c, q, db)]
          }
        })
      }
    ]
  }
  // SQL libre: the connection itself (no database) or one of its databases.
  const items: Item[] = db
    ? []
    : [
        {
          key: `sql:${c.id}:`,
          icon: TASK_ICONS.runquery,
          title: `Nueva consulta en ${c.name}`,
          subtitle: 'Sin base de datos por defecto (usa nombres completos en el SQL)',
          build: () => [sqlStep(c, null)]
        }
      ]
  for (const name of databaseItems(c))
    items.push({
      key: `sql:${c.id}:${name}`,
      icon: TASK_ICONS.runquery,
      title: `Nueva consulta en ${name}`,
      subtitle: 'Escribe el SQL en los ajustes del paso',
      build: () => [sqlStep(c, name)]
    })
  return [{ key: 'sql', title: `SQL libre · ${db ?? c.name}`, items }]
})

const allItems = computed(() => groups.value.flatMap((g) => g.items))
const checkedItems = computed(() => allItems.value.filter((i) => checked.value.includes(i.key)))

function toggleChecked(key: string): void {
  checked.value = checked.value.includes(key)
    ? checked.value.filter((k) => k !== key)
    : [...checked.value, key]
}

function addItems(items: Item[]): void {
  const built = items.flatMap((i) => i.build())
  if (built.length) emit('add', built)
  checked.value = []
}

function addChecked(): void {
  addItems(checkedItems.value)
}

function onItemKey(event: KeyboardEvent, item: Item): void {
  if (event.key === 'Enter') {
    addItems([item])
    event.preventDefault()
  } else if (event.key === ' ') {
    toggleChecked(item.key)
    event.preventDefault()
  }
}

function onItemDragStart(event: DragEvent, item: Item): void {
  const items = checked.value.includes(item.key) ? checkedItems.value : [item]
  startAddDrag(() => items.flatMap((i) => i.build()))
  event.dataTransfer?.setData(ADD_DRAG_TYPE, item.key)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
}

const emptyTree = computed(() =>
  kind.value === 'savedQuery' || kind.value === 'sql'
    ? 'Las consultas solo se ejecutan en conexiones MySQL y MariaDB, y no tienes ninguna.'
    : 'No hay conexiones que admitan tareas.'
)
</script>

<template>
  <section class="step-browser" aria-label="Añadir pasos" data-test="step-browser">
    <header class="step-browser__head">
      <h3 class="step-browser__title">
        <v-icon icon="mdi-plus-box-multiple-outline" size="16" aria-hidden="true" />Añadir pasos
      </h3>
      <div
        class="step-browser__kinds"
        role="radiogroup"
        aria-label="Tipo de paso"
        data-test="step-kinds"
      >
        <button
          v-for="k in STEP_KINDS"
          :key="k.value"
          type="button"
          role="radio"
          class="step-kind nd-transition"
          :class="{ 'step-kind--active': kind === k.value }"
          :aria-checked="kind === k.value"
          :data-test="`step-kind-${k.value}`"
          @click="kind = k.value"
        >
          <v-icon :icon="k.icon" size="15" aria-hidden="true" />{{ k.label }}
        </button>
      </div>
    </header>
    <div class="step-browser__body">
      <div class="step-browser__tree" data-test="step-browser-tree">
        <v-text-field
          v-model="filter"
          density="compact"
          hide-details
          clearable
          placeholder="Filtrar conexiones o bases de datos"
          prepend-inner-icon="mdi-magnify"
          aria-label="Filtrar conexiones o bases de datos"
          class="step-browser__filter"
          data-test="step-browser-filter"
        />
        <p v-if="!kindConnections.length" class="step-browser__muted">{{ emptyTree }}</p>
        <ul v-else class="browse-tree" role="tree" aria-label="Conexiones">
          <li
            v-for="c in filteredConnections"
            :key="c.id"
            role="treeitem"
            :aria-expanded="!!expanded[c.id]"
            :aria-selected="selectedConnection === c.id && !selectedDatabase"
          >
            <div
              class="browse-node"
              :class="{ 'browse-node--selected': selectedConnection === c.id && !selectedDatabase }"
            >
              <button
                type="button"
                class="browse-node__chevron"
                :aria-label="expanded[c.id] ? `Contraer ${c.name}` : `Expandir ${c.name}`"
                :data-test="`browse-expand-${c.id}`"
                @click="toggle(c)"
              >
                <v-progress-circular
                  v-if="schemaLoader.isLoading(c.id)"
                  indeterminate
                  size="12"
                  width="2"
                />
                <v-icon
                  v-else
                  :icon="expanded[c.id] ? 'mdi-chevron-down' : 'mdi-chevron-right'"
                  size="16"
                />
              </button>
              <button
                type="button"
                class="browse-node__label"
                :data-test="`browse-connection-${c.id}`"
                @click="selectConnection(c)"
                @dblclick="toggle(c)"
                @keydown="onConnectionKey($event, c)"
              >
                <v-icon
                  :icon="engineOf(c).icon"
                  size="15"
                  class="browse-node__icon"
                  aria-hidden="true"
                />
                <span class="browse-node__name">{{ c.name }}</span>
                <span
                  v-if="c.environment !== 'other'"
                  class="nd-pill browse-node__env"
                  :class="ENV_PILL[c.environment]"
                  >{{ ENVIRONMENT_LABELS[c.environment] }}</span
                >
              </button>
            </div>
            <ul v-if="expanded[c.id]" role="group" class="browse-tree__children">
              <li v-if="schemaLoader.errorOf(c.id)" class="browse-node__error">
                {{ schemaLoader.errorOf(c.id) }}
              </li>
              <li
                v-for="name in databasesOf(c)"
                :key="name"
                role="treeitem"
                :aria-selected="selectedConnection === c.id && selectedDatabase === name"
              >
                <button
                  type="button"
                  class="browse-node browse-node--db browse-node__label"
                  :class="{
                    'browse-node--selected':
                      selectedConnection === c.id && selectedDatabase === name
                  }"
                  :data-test="`browse-db-${name}`"
                  @click="selectDatabase(c, name)"
                >
                  <v-icon
                    icon="mdi-database-outline"
                    size="14"
                    class="browse-node__icon"
                    aria-hidden="true"
                  />
                  <span class="browse-node__name">{{ name }}</span>
                  <span
                    v-if="
                      kind === 'savedQuery' && queries.list(c.id).some((q) => q.schema === name)
                    "
                    class="browse-node__count"
                    >{{ queries.list(c.id).filter((q) => q.schema === name).length }}</span
                  >
                </button>
              </li>
            </ul>
          </li>
        </ul>
      </div>

      <div class="step-browser__items" data-test="step-browser-items">
        <p v-if="!groups.length" class="step-browser__placeholder">
          <v-icon icon="mdi-gesture-tap" size="18" aria-hidden="true" />
          Elige una conexión o una base de datos para ver lo que puedes añadir.
        </p>
        <template v-for="g in groups" :key="g.key">
          <h4 class="step-browser__group">{{ g.title }}</h4>
          <p v-if="!g.items.length" class="step-browser__muted">{{ g.empty }}</p>
          <ul v-else class="avail-list" :aria-label="g.title">
            <li
              v-for="item in g.items"
              :key="item.key"
              class="avail-item nd-transition"
              :class="{ 'avail-item--checked': checked.includes(item.key) }"
              tabindex="0"
              draggable="true"
              :aria-label="`${item.title}. ${item.subtitle}. Intro para añadir, espacio para marcar.`"
              :data-test="`avail-${item.key}`"
              @dblclick="addItems([item])"
              @keydown="onItemKey($event, item)"
              @dragstart="onItemDragStart($event, item)"
              @dragend="endAddDrag"
            >
              <v-checkbox-btn
                :model-value="checked.includes(item.key)"
                density="compact"
                :aria-label="`Marcar ${item.title}`"
                tabindex="-1"
                class="avail-item__check"
                @update:model-value="toggleChecked(item.key)"
              />
              <v-icon :icon="item.icon" size="16" class="avail-item__icon" aria-hidden="true" />
              <span class="avail-item__text">
                <span class="avail-item__title">{{ item.title }}</span>
                <span class="avail-item__sub" :class="{ 'nd-mono': item.mono }">{{
                  item.subtitle
                }}</span>
              </span>
              <span v-if="item.inJob" class="nd-pill nd-pill--info avail-item__pill">{{
                item.inJob
              }}</span>
              <v-btn
                icon="mdi-plus"
                size="x-small"
                variant="tonal"
                class="avail-item__add"
                :aria-label="`Añadir ${item.title}`"
                title="Añadir a la secuencia"
                tabindex="-1"
                :data-test="`avail-add-${item.key}`"
                @click.stop="addItems([item])"
              />
            </li>
          </ul>
        </template>
      </div>
    </div>
    <footer class="step-browser__foot">
      <span class="step-browser__hint">{{ kindMeta.hint }}</span>
      <v-btn
        size="small"
        color="primary"
        variant="flat"
        prepend-icon="mdi-playlist-plus"
        :disabled="!checkedItems.length"
        data-test="browser-add"
        @click="addChecked"
      >
        Añadir{{ checkedItems.length ? ` (${checkedItems.length})` : '' }}
      </v-btn>
    </footer>
  </section>
</template>

<style scoped>
.step-browser {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.step-browser__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 14px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--nd-hairline);
}
.step-browser__title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--nd-fs-dense);
  font-weight: var(--nd-fw-heading);
}
.step-browser__title .v-icon {
  color: var(--nd-accent);
}
.step-browser__kinds {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 2px;
  border-radius: var(--nd-radius-pill);
  background: var(--nd-bg-sunken);
  border: 1px solid var(--nd-border);
}
.step-kind {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 11px;
  border-radius: var(--nd-radius-pill);
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
}
.step-kind:hover {
  color: var(--nd-text);
  background: var(--nd-hover);
}
.step-kind:focus-visible {
  outline: 2px solid rgba(var(--nd-accent-rgb), 0.6);
  outline-offset: 1px;
}
.step-kind--active {
  color: var(--nd-text);
  background: var(--nd-bg-raised);
  border-color: rgba(var(--nd-accent-rgb), 0.45);
  box-shadow: var(--nd-shadow-1);
}
.step-kind--active .v-icon {
  color: var(--nd-accent);
}
.step-browser__body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(200px, 34%) minmax(0, 1fr);
}
.step-browser__tree {
  min-height: 0;
  overflow-y: auto;
  padding: 8px 6px 8px 10px;
  border-right: 1px solid var(--nd-hairline);
}
.step-browser__filter {
  margin-bottom: 6px;
}
.browse-tree,
.browse-tree__children {
  list-style: none;
  margin: 0;
  padding: 0;
}
.browse-tree__children {
  padding-left: 22px;
}
.browse-node {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 26px;
  border-radius: var(--nd-radius-sm);
}
.browse-node__chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 22px;
  color: var(--nd-text-muted);
  background: none;
  border: 0;
  cursor: pointer;
  border-radius: var(--nd-radius-sm);
}
.browse-node__label {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 6px;
  font: inherit;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text);
  background: none;
  border: 0;
  border-radius: var(--nd-radius-sm);
  cursor: pointer;
  text-align: left;
}
.browse-node--db {
  width: 100%;
}
.browse-node__label:hover {
  background: var(--nd-hover);
}
.browse-node__label:focus-visible,
.browse-node__chevron:focus-visible {
  outline: 2px solid rgba(var(--nd-accent-rgb), 0.6);
  outline-offset: -2px;
}
.browse-node--selected > .browse-node__label,
.browse-node--selected.browse-node__label {
  background: var(--nd-selected);
  box-shadow: inset 2px 0 0 var(--nd-accent);
}
.browse-node__icon {
  color: var(--nd-text-2);
  flex: none;
}
.browse-node__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.browse-node__env {
  margin-left: auto;
  flex: none;
  height: 16px;
  padding: 0 6px;
}
.browse-node__count {
  margin-left: auto;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.browse-node__error {
  padding: 4px 6px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-error);
}
.step-browser__items {
  min-height: 0;
  overflow-y: auto;
  padding: 6px 12px 10px;
}
.step-browser__group {
  margin: 8px 0 6px;
  font-size: var(--nd-fs-xs);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--nd-text-muted);
}
.step-browser__placeholder {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 18px 4px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.step-browser__muted {
  margin: 4px 2px 8px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.avail-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.avail-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 3px 6px 3px 2px;
  border-radius: var(--nd-radius-control);
  border: 1px solid transparent;
  cursor: grab;
  outline: none;
  user-select: none;
}
.avail-item:hover {
  background: var(--nd-hover);
  border-color: var(--nd-border);
}
.avail-item:focus-visible {
  box-shadow: 0 0 0 2px rgba(var(--nd-accent-rgb), 0.55);
}
.avail-item--checked {
  background: var(--nd-selected);
  border-color: rgba(var(--nd-accent-rgb), 0.4);
}
.avail-item__check {
  flex: none;
}
.avail-item__icon {
  color: var(--nd-text-2);
  flex: none;
}
.avail-item__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.avail-item__title {
  font-size: var(--nd-fs-dense);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.avail-item__sub {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.avail-item__pill {
  flex: none;
}
.avail-item__add {
  flex: none;
  opacity: 0;
}
.avail-item:hover .avail-item__add,
.avail-item:focus-visible .avail-item__add,
.avail-item--checked .avail-item__add {
  opacity: 1;
}
.step-browser__foot {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 12px;
  border-top: 1px solid var(--nd-hairline);
}
.step-browser__hint {
  flex: 1;
  min-width: 0;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
</style>
