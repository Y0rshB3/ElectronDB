<script setup lang="ts">
import { computed, watch } from 'vue'
import type { JobTask, JobTaskType } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import SqlEditor from '@renderer/components/common/SqlEditor.vue'
import EmptyState from '@renderer/components/common/EmptyState.vue'
import { useSchemaLoader } from '@renderer/components/backups/useSchemaLoader'
import { TASK_TYPES, defaultReferenceName, moveItem, newTask } from './jobForm'

const tasks = defineModel<JobTask[]>({ required: true })

const connections = useConnectionsStore()
const schemaLoader = useSchemaLoader()

const connectionItems = computed(() =>
  connections.sorted.map((c) => ({ title: c.name, value: c.id }))
)

function update(index: number, changes: Partial<JobTask>): void {
  const next = [...tasks.value]
  next[index] = { ...next[index], ...changes }
  tasks.value = next
}

function changeType(index: number, type: JobTaskType): void {
  const current = tasks.value[index]
  const replacement = {
    ...newTask(type, current.connectionId, current.schema),
    id: current.id,
    referenceName: current.referenceName
  }
  const next = [...tasks.value]
  next[index] = replacement
  tasks.value = next
}

function changeConnection(index: number, connectionId: string): void {
  update(index, { connectionId, schema: '' })
  void schemaLoader.load(connectionId)
}

function add(type: JobTaskType): void {
  const last = tasks.value[tasks.value.length - 1]
  tasks.value = [...tasks.value, newTask(type, last?.connectionId ?? '', '')]
}

function remove(index: number): void {
  tasks.value = tasks.value.filter((_, i) => i !== index)
}

function move(index: number, delta: number): void {
  tasks.value = moveItem(tasks.value, index, index + delta)
}

function schemaItems(task: JobTask): string[] {
  const list = schemaLoader.of(task.connectionId)
  return task.schema && !list.includes(task.schema) ? [task.schema, ...list] : list
}

// Preload schema lists only for connections that are already open: merely viewing a
// job must not connect to (possibly production / SSH) servers. Closed connections
// load their schemas when the user opens the schema dropdown.
watch(
  () => [
    ...new Set(
      tasks.value.map((t) => t.connectionId).filter((id) => !!id && connections.isOpen(id))
    )
  ],
  (ids) => ids.forEach((id) => void schemaLoader.load(id)),
  { immediate: true }
)

function onSchemaMenu(task: JobTask, opened: boolean): void {
  if (opened && task.connectionId) void schemaLoader.load(task.connectionId)
}
</script>

<template>
  <div class="job-tasks" data-test="job-tasks">
    <EmptyState
      v-if="!tasks.length"
      icon="mdi-format-list-checks"
      title="Sin tareas"
      description="Añade una copia de seguridad o una consulta."
      class="job-tasks__empty"
    />
    <ol v-else class="job-tasks__list">
      <li
        v-for="(task, index) in tasks"
        :key="task.id"
        class="task-card nd-transition"
        :data-test="`job-task-${index}`"
      >
        <div class="task-card__lead">
          <span class="task-card__index nd-mono" aria-hidden="true">{{ index + 1 }}</span>
          <v-icon
            :icon="task.type === 'backupschema' ? 'mdi-archive-outline' : 'mdi-console-line'"
            size="18"
            class="task-card__type-icon"
            aria-hidden="true"
          />
        </div>
        <div class="task-card__body">
          <div class="task-card__fields">
            <v-select
              :model-value="task.type"
              :items="TASK_TYPES"
              label="Tipo"
              class="task-card__type"
              @update:model-value="changeType(index, $event)"
            />
            <v-text-field
              :model-value="task.referenceName"
              label="Nombre de referencia"
              :placeholder="defaultReferenceName(task)"
              class="task-card__ref"
              @update:model-value="update(index, { referenceName: $event })"
            />
            <v-select
              :model-value="task.connectionId || null"
              :items="connectionItems"
              label="Conexión"
              prepend-inner-icon="mdi-server-network"
              no-data-text="No hay conexiones"
              @update:model-value="changeConnection(index, $event)"
            />
            <v-combobox
              :model-value="task.schema || null"
              :items="schemaItems(task)"
              :loading="schemaLoader.isLoading(task.connectionId)"
              :disabled="!task.connectionId"
              :error-messages="
                schemaLoader.errorOf(task.connectionId)
                  ? [schemaLoader.errorOf(task.connectionId)!]
                  : []
              "
              label="Esquema"
              prepend-inner-icon="mdi-database-outline"
              class="task-card__schema"
              @update:menu="onSchemaMenu(task, $event)"
              @update:model-value="update(index, { schema: $event ?? '' })"
            />
          </div>
          <v-checkbox
            v-if="task.type === 'backupschema'"
            :model-value="task.includeData !== false"
            label="Incluir datos (no solo estructura)"
            density="compact"
            hide-details
            class="task-card__check"
            @update:model-value="update(index, { includeData: !!$event })"
          />
          <div v-else class="job-tasks__sql">
            <SqlEditor
              :model-value="task.sql ?? ''"
              min-height="100px"
              @update:model-value="update(index, { sql: $event })"
            />
          </div>
        </div>
        <div class="task-card__actions">
          <v-btn
            icon="mdi-arrow-up"
            size="small"
            :disabled="index === 0"
            aria-label="Subir tarea"
            title="Subir tarea"
            @click="move(index, -1)"
          />
          <v-btn
            icon="mdi-arrow-down"
            size="small"
            :disabled="index === tasks.length - 1"
            aria-label="Bajar tarea"
            title="Bajar tarea"
            @click="move(index, 1)"
          />
          <v-btn
            icon="mdi-delete-outline"
            size="small"
            color="error"
            variant="text"
            aria-label="Quitar tarea"
            title="Quitar tarea"
            @click="remove(index)"
          />
        </div>
      </li>
    </ol>
    <div class="job-tasks__add">
      <v-btn
        prepend-icon="mdi-archive-plus-outline"
        variant="tonal"
        data-test="add-backup-task"
        @click="add('backupschema')"
        >Añadir copia de seguridad</v-btn
      >
      <v-btn prepend-icon="mdi-database-search-outline" variant="tonal" @click="add('runquery')"
        >Añadir consulta</v-btn
      >
    </div>
  </div>
</template>

<style scoped>
.job-tasks__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.job-tasks__empty {
  height: auto;
  padding: 20px 16px;
  border: 1px dashed var(--nd-border-strong);
  border-radius: var(--nd-radius-card);
}
.task-card {
  padding: 12px 12px 12px 14px;
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border);
  box-shadow: var(--nd-shadow-inset);
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  column-gap: 12px;
  align-items: start;
}
.task-card:hover,
.task-card:focus-within {
  border-color: var(--nd-border-strong);
}
/* Leading column: step number above the type icon, centred on the first field row. */
.task-card__lead {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-top: 7px;
}
.task-card__index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-size: var(--nd-fs-xs);
  font-weight: 700;
  color: var(--nd-on-accent);
  background: var(--nd-accent-gradient);
  box-shadow: 0 0 10px rgba(var(--nd-accent-rgb), 0.3);
}
.task-card__type-icon {
  color: var(--nd-text-2);
}
.task-card__body {
  min-width: 0;
}
/* Shared 2-column grid: Tipo/Conexión and Nombre/Esquema share edges and widths. */
.task-card__fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px 10px;
}
.task-card__actions {
  display: flex;
  gap: 2px;
  padding-top: 2px;
}
.task-card__check {
  margin-top: 6px;
  margin-left: -8px;
}
.job-tasks__sql {
  height: 140px;
  margin-top: 10px;
  overflow: hidden;
  border-radius: var(--nd-radius-control);
  border: 1px solid var(--nd-border);
  background: var(--nd-bg-sunken);
}
.job-tasks__add {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
</style>
