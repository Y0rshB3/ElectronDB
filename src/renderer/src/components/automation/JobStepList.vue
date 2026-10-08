<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { engineOf } from '@shared/engines'
import type { JobTask } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { ENVIRONMENT_LABELS } from '@renderer/utils/objectTypes'
import { TASK_ICONS, defaultReferenceName, duplicateTask, moveItem } from './jobForm'
import { restoreSourceLabel } from './jobSteps'
import { ADD_DRAG_TYPE, STEP_DRAG_TYPE, endAddDrag, takeAddDrag } from './stepDrag'

/**
 * «Secuencia de pasos» of the job editor: one compact row per step, in run
 * order. Rows are reordered by dragging, with the row buttons or with
 * Alt+↑/↓; selecting a row opens its settings (parent). Steps dragged from
 * the «Añadir pasos» browser are inserted where they are dropped.
 */
const tasks = defineModel<JobTask[]>({ required: true })
const selected = defineModel<string | null>('selected', { default: null })
const props = defineProps<{
  problems?: Record<string, string[]>
  /** A save was attempted: problems are shown as errors instead of hints. */
  strict?: boolean
}>()
/** Intro on a row: the parent opens the settings and moves focus into them. */
const emit = defineEmits<{ open: [id: string] }>()

const connections = useConnectionsStore()
const listEl = ref<HTMLElement | null>(null)

const TYPE_LABELS: Record<JobTask['type'], string> = {
  backupschema: 'Copia',
  runquery: 'Consulta',
  restoreschema: 'Restauración'
}
const ENV_PILL: Record<string, string> = {
  production: 'nd-pill--production',
  staging: 'nd-pill--staging',
  local: 'nd-pill--local'
}

interface Row {
  task: JobTask
  index: number
  name: string
  connectionName: string
  engineIcon: string
  engineLabel: string
  environment: string | null
  database: string
  detail: string
  mono: boolean
  problem: string | null
}

const rows = computed<Row[]>(() =>
  tasks.value.map((task, index) => {
    const connection = task.connectionId ? connections.get(task.connectionId) : undefined
    const engine = connection ? engineOf(connection) : null
    let database = task.schema
    let detail = ''
    let mono = false
    if (task.type === 'backupschema') {
      const format = task.format === 'vqb' || task.format === 'sql' ? task.format : 'nb3'
      detail = [
        `.${format}`,
        format === 'vqb' && task.encrypt ? 'cifrada' : '',
        task.includeData === false ? 'solo estructura' : ''
      ]
        .filter(Boolean)
        .join(' · ')
    } else if (task.type === 'runquery') {
      const line = (task.sql ?? '')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('--'))
      detail = line ? (line.length > 80 ? `${line.slice(0, 80)}…` : line) : 'sin SQL'
      mono = !!line
    } else {
      const sourceSchema =
        task.restoreSource?.kind === 'latest'
          ? task.restoreSource.schema
          : tasks.value.find(
              (t) => task.restoreSource?.kind === 'task' && t.id === task.restoreSource.taskId
            )?.schema
      database = task.schema || (sourceSchema ? `${sourceSchema} (mismo nombre)` : '')
      detail = `desde ${restoreSourceLabel(task, tasks.value, (id) => connections.nameOf(id))}${
        task.includeData === false ? ' · solo estructura' : ''
      }${task.safetyBackup === false ? ' · sin copia previa' : ''}`
    }
    return {
      task,
      index,
      name: task.referenceName || defaultReferenceName(task, tasks.value),
      connectionName:
        connection?.name ?? (task.connectionId ? 'Conexión eliminada' : 'Sin conexión'),
      engineIcon: engine?.icon ?? 'mdi-help-circle-outline',
      engineLabel: engine?.label ?? '',
      environment: connection?.environment ?? null,
      database,
      detail,
      mono,
      problem: props.problems?.[task.id]?.[0] ?? null
    }
  })
)

function select(id: string): void {
  selected.value = selected.value === id ? selected.value : id
}

/** Scrolls a step into view (just added) and optionally focuses it. */
async function revealRow(id: string, focus = false): Promise<void> {
  await nextTick()
  const index = tasks.value.findIndex((t) => t.id === id)
  const el = listEl.value?.querySelector<HTMLElement>(`[data-row-index="${index}"]`)
  el?.scrollIntoView?.({ block: 'nearest' })
  if (focus) el?.focus()
}

async function focusRow(index: number): Promise<void> {
  await nextTick()
  const el = listEl.value?.querySelector<HTMLElement>(`[data-row-index="${index}"]`)
  el?.focus()
}

function move(index: number, delta: number): void {
  const to = index + delta
  if (to < 0 || to >= tasks.value.length) return
  tasks.value = moveItem(tasks.value, index, to)
  void focusRow(to)
}

function remove(index: number): void {
  const removed = tasks.value[index]
  tasks.value = tasks.value.filter((_, i) => i !== index)
  if (selected.value === removed?.id) selected.value = null
  if (tasks.value.length) void focusRow(Math.min(index, tasks.value.length - 1))
}

function duplicate(index: number): void {
  const copy = duplicateTask(tasks.value[index])
  const next = [...tasks.value]
  next.splice(index + 1, 0, copy)
  tasks.value = next
  selected.value = copy.id
  void focusRow(index + 1)
}

function onKeydown(event: KeyboardEvent, index: number): void {
  if (event.target !== event.currentTarget) return
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    move(index, event.key === 'ArrowUp' ? -1 : 1)
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    void focusRow(
      Math.max(0, Math.min(tasks.value.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)))
    )
  } else if (event.key === 'Enter' || event.key === ' ') {
    select(tasks.value[index].id)
    emit('open', tasks.value[index].id)
  } else if (event.key === 'Delete') {
    remove(index)
  } else return
  event.preventDefault()
}

/* ---------- drag and drop ---------- */

const dragId = ref<string | null>(null)
/** Insertion point shown while dragging: before the row with this index (length = at the end). */
const dropAt = ref<number | null>(null)

function onDragStart(event: DragEvent, task: JobTask): void {
  dragId.value = task.id
  event.dataTransfer?.setData(STEP_DRAG_TYPE, task.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function accepts(event: DragEvent): boolean {
  const types = event.dataTransfer?.types ?? []
  return types.includes(STEP_DRAG_TYPE) || types.includes(ADD_DRAG_TYPE)
}

function onRowDragOver(event: DragEvent, index: number): void {
  if (!accepts(event)) return
  event.preventDefault()
  const el = event.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  dropAt.value = event.clientY < rect.top + rect.height / 2 ? index : index + 1
  if (event.dataTransfer)
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes(STEP_DRAG_TYPE)
      ? 'move'
      : 'copy'
}

function onListDragOver(event: DragEvent): void {
  if (!accepts(event)) return
  event.preventDefault()
  if (event.target === event.currentTarget || !tasks.value.length) dropAt.value = tasks.value.length
}

function onDragLeave(event: DragEvent): void {
  const to = event.relatedTarget as Node | null
  if (!to || !(event.currentTarget as HTMLElement).contains(to)) dropAt.value = null
}

function onDrop(event: DragEvent): void {
  if (!accepts(event)) return
  event.preventDefault()
  const at = dropAt.value ?? tasks.value.length
  dropAt.value = null
  const movedId = event.dataTransfer?.getData(STEP_DRAG_TYPE) || dragId.value
  if (event.dataTransfer?.types.includes(STEP_DRAG_TYPE) && movedId) {
    const from = tasks.value.findIndex((t) => t.id === movedId)
    if (from >= 0) {
      const to = at > from ? at - 1 : at
      if (to !== from) tasks.value = moveItem(tasks.value, from, to)
    }
  } else {
    const added = takeAddDrag()
    if (added.length) {
      const next = [...tasks.value]
      next.splice(at, 0, ...added)
      tasks.value = next
      selected.value = added[added.length - 1].id
    }
  }
  dragId.value = null
}

function onDragEnd(): void {
  dragId.value = null
  dropAt.value = null
  endAddDrag()
}

defineExpose({ focusRow, revealRow })
</script>

<template>
  <div
    class="step-list"
    :class="{ 'step-list--dropping': dropAt !== null }"
    data-test="step-list"
    @dragover="onListDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div v-if="!tasks.length" class="step-list__empty" data-test="step-list-empty">
      <p class="step-list__empty-title">Esta tarea aún no tiene pasos</p>
      <ol class="step-list__howto">
        <li>
          <span class="step-list__howto-n" aria-hidden="true">1</span>
          <div>
            <strong>Elige qué añadir</strong>
            <span>Copia, consulta o restauración, en «Añadir pasos».</span>
          </div>
        </li>
        <li>
          <span class="step-list__howto-n" aria-hidden="true">2</span>
          <div>
            <strong>Busca en tus conexiones</strong>
            <span
              >Abre una conexión y una base de datos, y añade con doble clic o arrastrando
              aquí.</span
            >
          </div>
        </li>
        <li>
          <span class="step-list__howto-n" aria-hidden="true">3</span>
          <div>
            <strong>Ordena y programa</strong>
            <span
              >Arrastra los pasos para cambiar el orden y fija cuándo se ejecuta en
              «Programación».</span
            >
          </div>
        </li>
      </ol>
    </div>
    <ol v-else ref="listEl" class="step-list__rows" aria-label="Secuencia de pasos">
      <li
        v-for="row in rows"
        :key="row.task.id"
        class="step-row nd-transition"
        :class="{
          'step-row--selected': selected === row.task.id,
          'step-row--dragging': dragId === row.task.id,
          'step-row--problem': !!row.problem,
          'step-row--strict': strict && !!row.problem,
          'step-row--drop-before': dropAt === row.index,
          'step-row--drop-after': dropAt === row.index + 1 && row.index === tasks.length - 1
        }"
        tabindex="0"
        draggable="true"
        :aria-label="`Paso ${row.index + 1}, ${TYPE_LABELS[row.task.type]}: ${row.name}. ${row.detail}. ${row.connectionName}${row.database ? `, ${row.database}` : ''}${selected === row.task.id ? '. Seleccionado' : ''}${row.problem ? `. Problema: ${row.problem}` : ''}`"
        :aria-keyshortcuts="'Enter Alt+ArrowUp Alt+ArrowDown Delete'"
        :data-row-index="row.index"
        :data-test="`job-task-${row.index}`"
        @click="select(row.task.id)"
        @keydown="onKeydown($event, row.index)"
        @dragstart="onDragStart($event, row.task)"
        @dragend="onDragEnd"
        @dragover="onRowDragOver($event, row.index)"
      >
        <span class="step-row__grip" aria-hidden="true" title="Arrastra para reordenar"
          ><v-icon icon="mdi-drag-vertical" size="16"
        /></span>
        <span class="step-row__n nd-mono" aria-hidden="true">{{ row.index + 1 }}</span>
        <span class="step-row__type" :class="`step-row__type--${row.task.type}`">
          <v-icon :icon="TASK_ICONS[row.task.type]" size="15" aria-hidden="true" />
          <span>{{ TYPE_LABELS[row.task.type] }}</span>
        </span>
        <span class="step-row__main">
          <span class="step-row__name">{{ row.name }}</span>
          <span
            class="step-row__detail"
            :class="{ 'nd-mono': row.mono }"
            :title="row.detail"
            data-test="step-detail"
            >{{ row.detail }}</span
          >
        </span>
        <span class="step-row__where">
          <span class="step-row__conn">
            <v-icon :icon="row.engineIcon" size="13" :title="row.engineLabel" aria-hidden="true" />
            <span
              v-if="row.task.type === 'restoreschema'"
              class="step-row__arrow"
              aria-hidden="true"
              >→</span
            >
            <span class="step-row__conn-name">{{ row.connectionName }}</span>
            <span
              v-if="row.environment && row.environment !== 'other'"
              class="nd-pill step-row__env"
              :class="ENV_PILL[row.environment]"
              >{{ ENVIRONMENT_LABELS[row.environment] }}</span
            >
          </span>
          <span class="step-row__db">
            <v-icon icon="mdi-database-outline" size="12" aria-hidden="true" />
            {{ row.database || '—' }}
          </span>
        </span>
        <span
          v-if="row.problem"
          class="step-row__problem"
          :title="row.problem"
          data-test="step-problem"
        >
          <v-icon icon="mdi-alert-circle-outline" size="14" aria-hidden="true" />
          <span>{{ row.problem }}</span>
        </span>
        <span class="step-row__actions" @click.stop>
          <v-btn
            icon="mdi-arrow-up"
            size="x-small"
            variant="text"
            :disabled="row.index === 0"
            :aria-label="`Subir el paso ${row.index + 1}`"
            title="Subir (Alt+↑)"
            :data-test="`step-up-${row.index}`"
            @click="move(row.index, -1)"
          />
          <v-btn
            icon="mdi-arrow-down"
            size="x-small"
            variant="text"
            :disabled="row.index === tasks.length - 1"
            :aria-label="`Bajar el paso ${row.index + 1}`"
            title="Bajar (Alt+↓)"
            :data-test="`step-down-${row.index}`"
            @click="move(row.index, 1)"
          />
          <v-btn
            icon="mdi-content-copy"
            size="x-small"
            variant="text"
            :aria-label="`Duplicar el paso ${row.index + 1}`"
            title="Duplicar"
            :data-test="`step-duplicate-${row.index}`"
            @click="duplicate(row.index)"
          />
          <v-btn
            icon="mdi-delete-outline"
            size="x-small"
            variant="text"
            class="step-row__remove"
            :aria-label="`Quitar el paso ${row.index + 1}`"
            title="Quitar (Supr)"
            :data-test="`step-remove-${row.index}`"
            @click="remove(row.index)"
          />
        </span>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.step-list {
  container-type: inline-size;
  min-height: 100%;
  padding: 6px 10px 10px;
  border-radius: var(--nd-radius-card);
  outline: 1px dashed transparent;
  outline-offset: -4px;
  transition: outline-color var(--nd-dur-fast) var(--nd-ease);
}
.step-list--dropping {
  outline-color: rgba(var(--nd-accent-rgb), 0.5);
}
.step-list__rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.step-row {
  position: relative;
  display: grid;
  grid-template-columns: 14px 20px 112px minmax(0, 1fr) minmax(0, 0.9fr) auto;
  grid-template-areas: 'grip n type main where actions' '. . . problem problem problem';
  align-items: center;
  column-gap: 10px;
  min-height: 44px;
  padding: 5px 6px 5px 4px;
  border-radius: var(--nd-radius-control);
  border: 1px solid var(--nd-border);
  background: var(--nd-bg-raised);
  cursor: pointer;
  outline: none;
}
.step-row:hover {
  border-color: var(--nd-border-strong);
}
.step-row:focus-visible {
  box-shadow: 0 0 0 2px rgba(var(--nd-accent-rgb), 0.55);
}
.step-row--selected {
  border-color: rgba(var(--nd-accent-rgb), 0.6);
  background: var(--nd-selected);
}
.step-row--dragging {
  opacity: 0.45;
}
.step-row--drop-before::before,
.step-row--drop-after::after {
  content: '';
  position: absolute;
  left: 6px;
  right: 6px;
  height: 2px;
  border-radius: 2px;
  background: var(--nd-accent);
  box-shadow: 0 0 6px rgba(var(--nd-accent-rgb), 0.6);
}
.step-row--drop-before::before {
  top: -4px;
}
.step-row--drop-after::after {
  bottom: -4px;
}
.step-row__grip {
  grid-area: grip;
  display: inline-flex;
  color: var(--nd-text-muted);
  cursor: grab;
}
.step-row__n {
  grid-area: n;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  font-size: var(--nd-fs-xs);
  font-weight: 700;
  color: var(--nd-on-accent);
  background: var(--nd-accent-gradient);
}
.step-row__type {
  grid-area: type;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
  white-space: nowrap;
}
.step-row__type--backupschema .v-icon {
  color: var(--nd-accent);
}
.step-row__type--runquery .v-icon {
  color: var(--nd-cyan);
}
.step-row__type--restoreschema .v-icon {
  color: var(--nd-warning);
}
.step-row__main,
.step-row__where {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.step-row__main {
  grid-area: main;
}
.step-row__where {
  grid-area: where;
}
.step-row__name {
  font-size: var(--nd-fs-dense);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.step-row__detail,
.step-row__db {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.step-row__conn {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: var(--nd-fs-dense);
}
.step-row__conn .v-icon,
.step-row__db .v-icon {
  color: var(--nd-text-muted);
  flex: none;
}
.step-row__arrow {
  color: var(--nd-text-muted);
}
.step-row__conn-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.step-row__env {
  flex: none;
  height: 16px;
  padding: 0 6px;
}
.step-row__problem {
  grid-area: problem;
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  margin-top: 2px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-warning);
}
.step-row__problem span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.step-row--strict {
  border-color: color-mix(in srgb, var(--nd-error) 55%, transparent);
}
.step-row--strict .step-row__problem {
  color: var(--nd-error);
}
.step-row__actions {
  grid-area: actions;
  display: flex;
  gap: 0;
  opacity: 0;
  transition: opacity var(--nd-dur-fast) var(--nd-ease);
}
.step-row:hover .step-row__actions,
.step-row:focus-within .step-row__actions,
.step-row--selected .step-row__actions {
  opacity: 1;
}
.step-row__remove:not(.v-btn--disabled) {
  color: var(--nd-error);
}
@container (max-width: 640px) {
  .step-row {
    grid-template-columns: 14px 20px 16px minmax(0, 1fr) minmax(0, 0.8fr) auto;
  }
  .step-row__type span {
    display: none;
  }
}
.step-list__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 18px 12px;
  border: 1px dashed var(--nd-border-strong);
  border-radius: var(--nd-radius-card);
}
.step-list__empty-title {
  margin: 0;
  font-weight: var(--nd-fw-heading);
}
.step-list__howto {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  width: 100%;
  max-width: 820px;
}
.step-list__howto li {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  border-radius: var(--nd-radius-control);
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border);
}
.step-list__howto div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.step-list__howto strong {
  font-size: var(--nd-fs-dense);
  color: var(--nd-text);
}
.step-list__howto-n {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-size: var(--nd-fs-xs);
  font-weight: 700;
  color: var(--nd-accent);
  background: var(--nd-accent-gradient-soft);
  border: 1px solid rgba(var(--nd-accent-rgb), 0.3);
}
@container (max-width: 560px) {
  .step-list__howto {
    grid-template-columns: 1fr;
  }
}
</style>
