<script setup lang="ts">
import { computed, watch } from 'vue'
import { restoreSourceOf } from '@shared/restoreTask'
import {
  backupFamilyName,
  backupFamilyOf,
  jobBackupFormats,
  jobDatabaseLabel,
  supportsQuerySteps
} from '@shared/jobEngines'
import type { JobTask, JobTaskType } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useSettingsStore } from '@renderer/stores/settings'
import SqlEditor from '@renderer/components/common/SqlEditor.vue'
import EmptyState from '@renderer/components/common/EmptyState.vue'
import { useSchemaLoader } from '@renderer/components/backups/useSchemaLoader'
import { automationConnections, environmentLabel } from '@renderer/components/backups/backupHelpers'
import ReplaceContentToggle from '@renderer/components/backups/ReplaceContentToggle.vue'
import {
  TASK_ICONS,
  TASK_TYPES,
  defaultReferenceName,
  moveItem,
  newRestoreTask,
  newTask
} from './jobForm'

const tasks = defineModel<JobTask[]>({ required: true })

const connections = useConnectionsStore()
const settings = useSettingsStore()
const schemaLoader = useSchemaLoader()

const connectionItems = computed(() =>
  automationConnections(connections.sorted).map((c) => ({ title: c.name, value: c.id }))
)
/** Query steps run SQL on MySQL and MariaDB connections only. */
const queryConnectionItems = computed(() =>
  automationConnections(connections.sorted)
    .filter((c) => supportsQuerySteps(c))
    .map((c) => ({ title: c.name, value: c.id }))
)

const connectionOf = (id: string | null | undefined) => (id ? connections.get(id) : undefined)

/** Step types offered for a step: no query step on PostgreSQL, SQLite or MongoDB. */
function typeItems(task: JobTask): { value: JobTaskType; title: string; props?: object }[] {
  const connection = connectionOf(task.connectionId)
  return TASK_TYPES.map((t) =>
    t.value === 'runquery' && connection && !supportsQuerySteps(connection)
      ? { ...t, props: { disabled: true, subtitle: 'Solo MySQL y MariaDB' } }
      : t
  )
}

/** Formats a backup step of this connection can write (.nb3 and .sql: MySQL and MariaDB). */
function formatsOf(task: JobTask): string[] {
  const connection = connectionOf(task.connectionId)
  return connection ? jobBackupFormats(connection) : ['vqb', 'nb3', 'sql']
}

function databaseLabel(connectionId: string | null | undefined): string {
  return jobDatabaseLabel(connectionOf(connectionId) ?? null)
}

/** Engine of the copies a restore step reads (its source connection), when known. */
function sourceFamily(task: JobTask): ReturnType<typeof backupFamilyOf> | null {
  const from = restoreSourceOf(task, tasks.value)?.connectionId
  const connection = connectionOf(from)
  return connection ? backupFamilyOf(connection.engine) : null
}

function update(index: number, changes: Partial<JobTask>): void {
  const next = [...tasks.value]
  next[index] = { ...next[index], ...changes }
  tasks.value = next
}

/**
 * Restore targets: connections that need the typed name (production, and the
 * environments chosen in Ajustes › Seguridad) are listed but cannot be chosen.
 */
function targetItems(task: JobTask): { title: string; value: string; props: object }[] {
  // A copy only restores into a connection of its own engine (MySQL and MariaDB share one).
  const family = sourceFamily(task)
  return automationConnections(connections.sorted)
    .filter((c) => !family || backupFamilyOf(c.engine) === family)
    .map((c) => {
      const blocked = settings.needsTypedConfirm(c.environment)
      return {
        title: c.name,
        value: c.id,
        props: {
          disabled: blocked,
          subtitle: blocked
            ? `${environmentLabel(c.environment)}: pide escribir el nombre, no se puede restaurar desde una tarea`
            : environmentLabel(c.environment)
        }
      }
    })
}

function targetHint(task: JobTask): string | undefined {
  const family = sourceFamily(task)
  return family && family !== 'mysql'
    ? `Solo conexiones ${backupFamilyName(family)}: una copia se restaura en el mismo motor.`
    : undefined
}
const blockedHint = computed(() => {
  const names = settings.typedEnvironments.map((e) =>
    e === 'production' ? 'producción' : environmentLabel(e)
  )
  const list =
    names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}` : names[0]
  return `Desde una tarea no se puede restaurar en conexiones de ${list} (piden escribir el nombre).`
})

function changeType(index: number, type: JobTaskType): void {
  const current = tasks.value[index]
  const base =
    type === 'restoreschema'
      ? newRestoreTask(
          tasks.value.slice(0, index),
          automationConnections(connections.sorted),
          (c) => settings.needsTypedConfirm(c.environment)
        )
      : newTask(type, current.connectionId, current.schema)
  const replacement = { ...base, id: current.id, referenceName: current.referenceName }
  const next = [...tasks.value]
  next[index] = replacement
  tasks.value = next
}

/** «Origen» choices of a restore step: earlier backup steps, or the latest file on disk. */
function sourceItems(index: number): { title: string; value: string }[] {
  const items = tasks.value.slice(0, index).flatMap((t, i) =>
    t.type === 'backupschema'
      ? [
          {
            title: `Paso ${i + 1} · ${t.referenceName || defaultReferenceName(t)} (${t.connectionId ? connections.nameOf(t.connectionId) : '—'})${t.includeData === false ? ' · solo estructura' : ''}${t.format === 'sql' ? ' · .sql (no restaurable)' : t.format === 'vqb' ? ` · .vqb${t.encrypt ? ' cifrada' : ''}` : ''}`,
            value: `task:${t.id}`
          }
        ]
      : []
  )
  return [...items, { title: 'Última copia completa de una tarea de…', value: 'latest' }]
}

function sourceValue(task: JobTask): string | null {
  const source = task.restoreSource
  if (!source) return null
  if (source.kind === 'task') return source.taskId ? `task:${source.taskId}` : null
  return source.kind === 'latest' ? 'latest' : null
}

function changeSource(index: number, value: string | null): void {
  if (value === 'latest') {
    const current = tasks.value[index].restoreSource
    update(index, {
      restoreSource:
        current?.kind === 'latest' ? current : { kind: 'latest', connectionId: '', schema: '' }
    })
  } else if (value?.startsWith('task:')) {
    update(index, { restoreSource: { kind: 'task', taskId: value.slice(5) } })
  }
}

function latestOf(task: JobTask): { connectionId: string; schema: string } {
  const source = task.restoreSource
  return source?.kind === 'latest' ? source : { connectionId: '', schema: '' }
}

function changeLatest(index: number, changes: { connectionId?: string; schema?: string }): void {
  const base = latestOf(tasks.value[index])
  const next = { kind: 'latest' as const, ...base, ...changes }
  if (changes.connectionId !== undefined && changes.connectionId !== base.connectionId) {
    next.schema = ''
    if (changes.connectionId) void schemaLoader.load(changes.connectionId)
  }
  update(index, { restoreSource: next })
}

/** Placeholder of the target database: the source schema (same name). */
function targetPlaceholder(task: JobTask): string {
  const schema = restoreSourceOf(task, tasks.value)?.schema
  return schema ? `Mismo nombre (${schema})` : 'Mismo nombre que el origen'
}

function changeConnection(index: number, connectionId: string): void {
  const task = tasks.value[index]
  const changes: Partial<JobTask> = { connectionId, schema: '' }
  // PostgreSQL, SQLite and MongoDB copies are always .vqb.
  const connection = connectionOf(connectionId)
  if (task.type === 'backupschema' && connection) {
    const allowed = jobBackupFormats(connection)
    if (!allowed.includes(task.format ?? 'nb3')) changes.format = 'vqb'
  }
  update(index, changes)
  void schemaLoader.load(connectionId)
}

function add(type: JobTaskType): void {
  const last = tasks.value[tasks.value.length - 1]
  const task =
    type === 'restoreschema'
      ? newRestoreTask(tasks.value, automationConnections(connections.sorted), (c) =>
          settings.needsTypedConfirm(c.environment)
        )
      : newTask(type, last?.connectionId ?? '', '')
  tasks.value = [...tasks.value, task]
}

function remove(index: number): void {
  tasks.value = tasks.value.filter((_, i) => i !== index)
}

function move(index: number, delta: number): void {
  tasks.value = moveItem(tasks.value, index, index + delta)
}

function schemaItems(task: JobTask): string[] {
  return withCurrent(schemaLoader.of(task.connectionId), task.schema)
}

function withCurrent(list: string[], current: string | undefined): string[] {
  return current && !list.includes(current) ? [current, ...list] : list
}

// Preload schema lists only for connections that are already open: merely viewing a
// job must not connect to (possibly production / SSH) servers. Closed connections
// load their schemas when the user opens the schema dropdown.
watch(
  () => [
    ...new Set(
      tasks.value
        .flatMap((t) => [
          t.connectionId,
          t.restoreSource?.kind === 'latest' ? t.restoreSource.connectionId : ''
        ])
        .filter((id) => !!id && connections.isOpen(id))
    )
  ],
  (ids) => ids.forEach((id) => void schemaLoader.load(id)),
  { immediate: true }
)

function onSchemaMenu(connectionId: string, opened: boolean): void {
  if (opened && connectionId) void schemaLoader.load(connectionId)
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
            :icon="TASK_ICONS[task.type] ?? 'mdi-console-line'"
            size="18"
            class="task-card__type-icon"
            aria-hidden="true"
          />
        </div>
        <div class="task-card__body">
          <div class="task-card__fields">
            <v-select
              :model-value="task.type"
              :items="typeItems(task)"
              label="Tipo"
              class="task-card__type"
              @update:model-value="changeType(index, $event)"
            />
            <v-text-field
              :model-value="task.referenceName"
              label="Nombre de referencia"
              :placeholder="defaultReferenceName(task, tasks)"
              class="task-card__ref"
              @update:model-value="update(index, { referenceName: $event })"
            />
            <template v-if="task.type === 'restoreschema'">
              <v-select
                :model-value="sourceValue(task)"
                :items="sourceItems(index)"
                label="Origen (copia a restaurar)"
                :hint="
                  task.restoreSource?.kind === 'latest'
                    ? 'La copia con datos más reciente de ese esquema hecha por una tarea de Vortaq (nunca copias manuales, parciales, solo de estructura ni de Navicat).'
                    : undefined
                "
                persistent-hint
                prepend-inner-icon="mdi-archive-arrow-up-outline"
                class="task-card__wide"
                data-test="restore-source"
                @update:model-value="changeSource(index, $event)"
              />
              <template v-if="task.restoreSource?.kind === 'latest'">
                <v-select
                  :model-value="latestOf(task).connectionId || null"
                  :items="connectionItems"
                  label="Conexión de origen"
                  prepend-inner-icon="mdi-server-network"
                  no-data-text="No hay conexiones"
                  @update:model-value="changeLatest(index, { connectionId: $event ?? '' })"
                />
                <v-combobox
                  :model-value="latestOf(task).schema || null"
                  :items="
                    withCurrent(schemaLoader.of(latestOf(task).connectionId), latestOf(task).schema)
                  "
                  :loading="schemaLoader.isLoading(latestOf(task).connectionId)"
                  :disabled="!latestOf(task).connectionId"
                  :label="`${databaseLabel(latestOf(task).connectionId)} de origen`"
                  prepend-inner-icon="mdi-database-outline"
                  @update:menu="onSchemaMenu(latestOf(task).connectionId, $event)"
                  @update:model-value="changeLatest(index, { schema: $event ?? '' })"
                />
              </template>
              <v-select
                :model-value="task.connectionId || null"
                :items="targetItems(task)"
                :hint="targetHint(task)"
                :persistent-hint="!!targetHint(task)"
                label="Conexión de destino"
                prepend-inner-icon="mdi-server-network"
                no-data-text="No hay conexiones del mismo motor"
                data-test="restore-target"
                @update:model-value="changeConnection(index, $event)"
              />
              <v-combobox
                :model-value="task.schema || null"
                :items="schemaItems(task)"
                :loading="schemaLoader.isLoading(task.connectionId)"
                :disabled="!task.connectionId"
                :placeholder="targetPlaceholder(task)"
                persistent-placeholder
                label="Base de datos de destino"
                prepend-inner-icon="mdi-database-arrow-down-outline"
                clearable
                @update:menu="onSchemaMenu(task.connectionId, $event)"
                @update:model-value="update(index, { schema: $event ?? '' })"
              />
            </template>
            <v-select
              v-else
              :model-value="task.connectionId || null"
              :items="task.type === 'runquery' ? queryConnectionItems : connectionItems"
              label="Conexión"
              prepend-inner-icon="mdi-server-network"
              no-data-text="No hay conexiones"
              @update:model-value="changeConnection(index, $event)"
            />
            <v-combobox
              v-if="task.type !== 'restoreschema'"
              :model-value="task.schema || null"
              :items="schemaItems(task)"
              :loading="schemaLoader.isLoading(task.connectionId)"
              :disabled="!task.connectionId"
              :error-messages="
                schemaLoader.errorOf(task.connectionId)
                  ? [schemaLoader.errorOf(task.connectionId)!]
                  : []
              "
              :label="databaseLabel(task.connectionId)"
              prepend-inner-icon="mdi-database-outline"
              class="task-card__schema"
              @update:menu="onSchemaMenu(task.connectionId, $event)"
              @update:model-value="update(index, { schema: $event ?? '' })"
            />
          </div>
          <template v-if="task.type === 'backupschema'">
            <v-checkbox
              :model-value="task.includeData !== false"
              label="Incluir datos (no solo estructura)"
              density="compact"
              hide-details
              class="task-card__check"
              @update:model-value="update(index, { includeData: !!$event })"
            />
            <div class="task-card__format">
              <span class="task-card__format-label">Formato</span>
              <v-btn-toggle
                :model-value="task.format === 'sql' || task.format === 'vqb' ? task.format : 'nb3'"
                mandatory
                density="compact"
                variant="outlined"
                divided
                data-test="task-format"
                @update:model-value="
                  update(index, {
                    format: $event === 'sql' || $event === 'vqb' ? $event : undefined,
                    encrypt: $event === 'vqb' ? task.encrypt : undefined
                  })
                "
              >
                <v-btn value="vqb" size="small" data-test="task-format-vqb">.vqb</v-btn>
                <v-btn
                  v-if="formatsOf(task).includes('nb3')"
                  value="nb3"
                  size="small"
                  data-test="task-format-nb3"
                  >.nb3</v-btn
                >
                <v-btn
                  v-if="formatsOf(task).includes('sql')"
                  value="sql"
                  size="small"
                  data-test="task-format-sql"
                  >.sql</v-btn
                >
              </v-btn-toggle>
              <v-checkbox
                v-if="task.format === 'vqb'"
                :model-value="task.encrypt === true"
                label="Cifrar con contraseña"
                density="compact"
                hide-details
                class="task-card__check task-card__encrypt"
                data-test="task-encrypt"
                @update:model-value="update(index, { encrypt: $event ? true : undefined })"
              />
            </div>
            <p v-if="task.format === 'sql'" class="task-card__hint" data-test="task-format-hint">
              Para llevar la copia a otros gestores. Las restauraciones automáticas necesitan .nb3 o
              .vqb.
            </p>
            <p
              v-else-if="task.format === 'vqb' && task.encrypt"
              class="task-card__hint"
              data-test="task-encrypt-hint"
            >
              Se cifra con la contraseña de la tarea (más abajo); se guarda cifrada en este equipo
              para las ejecuciones programadas.
            </p>
          </template>
          <template v-else-if="task.type === 'restoreschema'">
            <ReplaceContentToggle
              :model-value="task.includeData !== false"
              class="task-card__content"
              data-test="restore-content"
              @update:model-value="update(index, { includeData: $event })"
            />
            <v-checkbox
              :model-value="task.safetyBackup !== false"
              label="Copia de seguridad previa del destino (recomendado)"
              density="compact"
              hide-details
              class="task-card__check"
              data-test="restore-safety"
              @update:model-value="update(index, { safetyBackup: !!$event })"
            />
            <p class="task-card__hint">
              La base de datos de destino se borra y se crea de nuevo con
              {{
                task.includeData === false
                  ? 'la estructura de la copia (tablas vacías).'
                  : 'el contenido de la copia.'
              }}
              {{ blockedHint }}
            </p>
          </template>
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
      <v-btn
        prepend-icon="mdi-backup-restore"
        variant="tonal"
        data-test="add-restore-task"
        @click="add('restoreschema')"
        >Añadir restauración</v-btn
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
.task-card__wide {
  grid-column: 1 / -1;
}
.task-card__hint {
  margin: 2px 0 0;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.task-card__check {
  margin-top: 6px;
  margin-left: -8px;
}
.task-card__format {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
}
.task-card__format-label {
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.task-card__content {
  margin-top: 10px;
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
