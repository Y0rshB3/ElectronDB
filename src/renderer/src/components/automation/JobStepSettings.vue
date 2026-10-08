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
import { useSchemaLoader } from '@renderer/components/backups/useSchemaLoader'
import { automationConnections, environmentLabel } from '@renderer/components/backups/backupHelpers'
import ReplaceContentToggle from '@renderer/components/backups/ReplaceContentToggle.vue'
import { TASK_ICONS, TASK_TYPES, defaultReferenceName, newRestoreTask, newTask } from './jobForm'

/**
 * Settings of the selected step of the job editor (side panel). Edits the
 * step inside `tasks` in place of the inline forms of earlier versions; every
 * option of those forms is here.
 */
const tasks = defineModel<JobTask[]>({ required: true })
const props = defineProps<{
  taskId: string
  problems?: string[]
  /** The job has a stored backup password, or one typed in Opciones. */
  passwordReady?: boolean
}>()
const emit = defineEmits<{ close: []; openOptions: [] }>()

const connections = useConnectionsStore()
const settings = useSettingsStore()
const schemaLoader = useSchemaLoader()

const index = computed(() => tasks.value.findIndex((t) => t.id === props.taskId))
const task = computed<JobTask | null>(() => tasks.value[index.value] ?? null)

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

/** Step types offered: no query step on PostgreSQL, SQLite or MongoDB. */
const typeItems = computed(() => {
  const connection = connectionOf(task.value?.connectionId)
  return TASK_TYPES.map((t) =>
    t.value === 'runquery' && connection && !supportsQuerySteps(connection)
      ? { ...t, props: { disabled: true, subtitle: 'Solo MySQL y MariaDB' } }
      : t
  )
})

/** Formats a backup step of this connection can write (.nb3 and .sql: MySQL and MariaDB). */
const formats = computed<string[]>(() => {
  const connection = connectionOf(task.value?.connectionId)
  return connection ? jobBackupFormats(connection) : ['vqb', 'nb3', 'sql']
})

function databaseLabel(connectionId: string | null | undefined): string {
  return jobDatabaseLabel(connectionOf(connectionId) ?? null)
}

/** Engine of the copies a restore step reads (its source connection), when known. */
const sourceFamily = computed(() => {
  if (!task.value) return null
  const from = restoreSourceOf(task.value, tasks.value)?.connectionId
  const connection = connectionOf(from)
  return connection ? backupFamilyOf(connection.engine) : null
})

function update(changes: Partial<JobTask>): void {
  if (index.value < 0) return
  const next = [...tasks.value]
  next[index.value] = { ...next[index.value], ...changes }
  tasks.value = next
}

/**
 * Restore targets: connections that need the typed name (production, and the
 * environments chosen in Ajustes › Seguridad) are listed but cannot be chosen.
 */
const targetItems = computed(() => {
  // A copy only restores into a connection of its own engine (MySQL and MariaDB share one).
  const family = sourceFamily.value
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
})

const targetHint = computed(() => {
  const family = sourceFamily.value
  return family && family !== 'mysql'
    ? `Solo conexiones ${backupFamilyName(family)} (el motor de la copia).`
    : undefined
})
const blockedHint = computed(() => {
  const names = settings.typedEnvironments.map((e) =>
    e === 'production' ? 'producción' : environmentLabel(e)
  )
  const list =
    names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}` : names[0]
  return `Desde una tarea no se puede restaurar en conexiones de ${list} (piden escribir el nombre).`
})

function changeType(type: JobTaskType): void {
  const current = task.value
  if (!current || current.type === type) return
  const base =
    type === 'restoreschema'
      ? newRestoreTask(
          tasks.value.slice(0, index.value),
          automationConnections(connections.sorted),
          (c) => settings.needsTypedConfirm(c.environment)
        )
      : newTask(type, current.connectionId, current.schema)
  const next = [...tasks.value]
  next[index.value] = { ...base, id: current.id, referenceName: current.referenceName }
  tasks.value = next
}

/** «Origen» choices of a restore step: earlier backup steps, or the latest file on disk. */
const sourceItems = computed(() => {
  const items = tasks.value.slice(0, Math.max(index.value, 0)).flatMap((t, i) =>
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
})

const sourceValue = computed(() => {
  const source = task.value?.restoreSource
  if (!source) return null
  if (source.kind === 'task') return source.taskId ? `task:${source.taskId}` : null
  return source.kind === 'latest' ? 'latest' : null
})

function changeSource(value: string | null): void {
  if (value === 'latest') {
    const current = task.value?.restoreSource
    update({
      restoreSource:
        current?.kind === 'latest' ? current : { kind: 'latest', connectionId: '', schema: '' }
    })
  } else if (value?.startsWith('task:')) {
    update({ restoreSource: { kind: 'task', taskId: value.slice(5) } })
  }
}

const latest = computed(() => {
  const source = task.value?.restoreSource
  return source?.kind === 'latest' ? source : { connectionId: '', schema: '' }
})

function changeLatest(changes: { connectionId?: string; schema?: string }): void {
  const base = latest.value
  const next = {
    kind: 'latest' as const,
    connectionId: base.connectionId,
    schema: base.schema,
    ...changes
  }
  if (changes.connectionId !== undefined && changes.connectionId !== base.connectionId) {
    next.schema = ''
    if (changes.connectionId) void schemaLoader.load(changes.connectionId)
  }
  update({ restoreSource: next })
}

/** Placeholder of the target database: the source schema (same name). */
const targetPlaceholder = computed(() => {
  const schema = task.value ? restoreSourceOf(task.value, tasks.value)?.schema : ''
  return schema ? `Mismo nombre (${schema})` : 'Mismo nombre que el origen'
})

function changeConnection(connectionId: string): void {
  const current = task.value
  if (!current) return
  const changes: Partial<JobTask> = { connectionId, schema: '' }
  // PostgreSQL, SQLite and MongoDB copies are always .vqb.
  const connection = connectionOf(connectionId)
  if (current.type === 'backupschema' && connection) {
    const allowed = jobBackupFormats(connection)
    if (!allowed.includes(current.format ?? 'nb3')) changes.format = 'vqb'
  }
  update(changes)
  void schemaLoader.load(connectionId)
}

function withCurrent(list: string[], current: string | undefined): string[] {
  return current && !list.includes(current) ? [current, ...list] : list
}

// Preload schema lists only for connections that are already open: merely viewing a
// step must not connect to (possibly production / SSH) servers. Closed connections
// load their schemas when the user opens the dropdown.
watch(
  () =>
    [
      task.value?.connectionId,
      task.value?.restoreSource?.kind === 'latest' ? task.value.restoreSource.connectionId : ''
    ].filter((id): id is string => !!id && connections.isOpen(id)),
  (ids) => ids.forEach((id) => void schemaLoader.load(id)),
  { immediate: true }
)

function onSchemaMenu(connectionId: string, opened: boolean): void {
  if (opened && connectionId) void schemaLoader.load(connectionId)
}

const formatValue = computed(() =>
  task.value?.format === 'sql' || task.value?.format === 'vqb' ? task.value.format : 'nb3'
)
</script>

<template>
  <aside
    v-if="task"
    class="step-settings"
    aria-label="Ajustes del paso"
    data-test="step-settings"
    @keydown.esc.stop="emit('close')"
  >
    <header class="step-settings__head">
      <span class="step-settings__badge nd-mono" aria-hidden="true">{{ index + 1 }}</span>
      <v-icon
        :icon="TASK_ICONS[task.type]"
        size="18"
        class="step-settings__icon"
        aria-hidden="true"
      />
      <div class="step-settings__heading">
        <h3 class="step-settings__title">Paso {{ index + 1 }}</h3>
        <span class="step-settings__sub">{{
          task.referenceName || defaultReferenceName(task, tasks)
        }}</span>
      </div>
      <v-btn
        icon="mdi-close"
        size="small"
        variant="text"
        aria-label="Cerrar los ajustes del paso"
        title="Cerrar (Esc)"
        data-test="step-settings-close"
        @click="emit('close')"
      />
    </header>

    <div class="step-settings__body">
      <div
        v-if="problems?.length"
        class="step-settings__problems"
        role="alert"
        data-test="step-settings-problems"
      >
        <v-icon icon="mdi-alert-circle-outline" size="16" aria-hidden="true" />
        <div>
          <div v-for="p in problems" :key="p">{{ p }}</div>
        </div>
      </div>

      <div class="step-settings__group">
        <v-select
          :model-value="task.type"
          :items="typeItems"
          label="Tipo"
          data-test="step-type"
          @update:model-value="changeType($event)"
        />
        <v-text-field
          :model-value="task.referenceName"
          label="Nombre de referencia"
          :placeholder="defaultReferenceName(task, tasks)"
          persistent-placeholder
          data-test="step-reference"
          @update:model-value="update({ referenceName: $event })"
        />
      </div>

      <template v-if="task.type === 'restoreschema'">
        <h4 class="step-settings__section">Origen</h4>
        <div class="step-settings__group">
          <v-select
            :model-value="sourceValue"
            :items="sourceItems"
            label="Copia a restaurar"
            :hint="
              task.restoreSource?.kind === 'latest'
                ? 'La copia con datos más reciente de esa base de datos hecha por una tarea de Vortaq (nunca copias manuales, parciales, solo de estructura ni de Navicat).'
                : undefined
            "
            persistent-hint
            prepend-inner-icon="mdi-archive-arrow-up-outline"
            data-test="restore-source"
            @update:model-value="changeSource($event)"
          />
          <template v-if="task.restoreSource?.kind === 'latest'">
            <v-select
              :model-value="latest.connectionId || null"
              :items="connectionItems"
              label="Conexión de origen"
              prepend-inner-icon="mdi-server-network"
              no-data-text="No hay conexiones"
              data-test="restore-latest-connection"
              @update:model-value="changeLatest({ connectionId: $event ?? '' })"
            />
            <v-combobox
              :model-value="latest.schema || null"
              :items="withCurrent(schemaLoader.of(latest.connectionId), latest.schema)"
              :loading="schemaLoader.isLoading(latest.connectionId)"
              :disabled="!latest.connectionId"
              :label="`${databaseLabel(latest.connectionId)} de origen`"
              prepend-inner-icon="mdi-database-outline"
              @update:menu="onSchemaMenu(latest.connectionId, $event)"
              @update:model-value="changeLatest({ schema: $event ?? '' })"
            />
          </template>
        </div>
        <h4 class="step-settings__section">Destino</h4>
        <div class="step-settings__group">
          <v-select
            :model-value="task.connectionId || null"
            :items="targetItems"
            :hint="targetHint"
            :persistent-hint="!!targetHint"
            label="Conexión de destino"
            prepend-inner-icon="mdi-server-network"
            no-data-text="No hay conexiones del mismo motor"
            data-test="restore-target"
            @update:model-value="changeConnection($event)"
          />
          <v-combobox
            :model-value="task.schema || null"
            :items="withCurrent(schemaLoader.of(task.connectionId), task.schema)"
            :loading="schemaLoader.isLoading(task.connectionId)"
            :disabled="!task.connectionId"
            :placeholder="targetPlaceholder"
            persistent-placeholder
            label="Base de datos de destino"
            prepend-inner-icon="mdi-database-arrow-down-outline"
            clearable
            data-test="restore-target-schema"
            @update:menu="onSchemaMenu(task.connectionId, $event)"
            @update:model-value="update({ schema: $event ?? '' })"
          />
        </div>
        <ReplaceContentToggle
          :model-value="task.includeData !== false"
          class="step-settings__content"
          data-test="restore-content"
          @update:model-value="update({ includeData: $event })"
        />
        <v-checkbox
          :model-value="task.safetyBackup !== false"
          label="Copia de seguridad previa del destino (recomendado)"
          density="compact"
          hide-details
          class="step-settings__check"
          data-test="restore-safety"
          @update:model-value="update({ safetyBackup: !!$event })"
        />
        <p class="step-settings__hint">
          La base de datos de destino se borra y se crea de nuevo con
          {{
            task.includeData === false
              ? 'la estructura de la copia (tablas vacías).'
              : 'el contenido de la copia.'
          }}
          {{ blockedHint }}
        </p>
      </template>

      <template v-else>
        <h4 class="step-settings__section">Dónde</h4>
        <div class="step-settings__group">
          <v-select
            :model-value="task.connectionId || null"
            :items="task.type === 'runquery' ? queryConnectionItems : connectionItems"
            label="Conexión"
            prepend-inner-icon="mdi-server-network"
            no-data-text="No hay conexiones"
            data-test="step-connection"
            @update:model-value="changeConnection($event)"
          />
          <v-combobox
            :model-value="task.schema || null"
            :items="withCurrent(schemaLoader.of(task.connectionId), task.schema)"
            :loading="schemaLoader.isLoading(task.connectionId)"
            :disabled="!task.connectionId"
            :error-messages="
              schemaLoader.errorOf(task.connectionId)
                ? [schemaLoader.errorOf(task.connectionId)!]
                : []
            "
            :label="databaseLabel(task.connectionId)"
            prepend-inner-icon="mdi-database-outline"
            data-test="step-schema"
            @update:menu="onSchemaMenu(task.connectionId, $event)"
            @update:model-value="update({ schema: $event ?? '' })"
          />
        </div>

        <template v-if="task.type === 'backupschema'">
          <h4 class="step-settings__section">Copia</h4>
          <div class="step-settings__format">
            <span id="step-format-label" class="step-settings__format-label">Formato</span>
            <v-btn-toggle
              :model-value="formatValue"
              mandatory
              density="compact"
              variant="outlined"
              divided
              aria-labelledby="step-format-label"
              data-test="task-format"
              @update:model-value="
                update({
                  format: $event === 'sql' || $event === 'vqb' ? $event : undefined,
                  encrypt: $event === 'vqb' ? task.encrypt : undefined
                })
              "
            >
              <v-btn value="vqb" size="small" data-test="task-format-vqb">.vqb</v-btn>
              <v-btn
                v-if="formats.includes('nb3')"
                value="nb3"
                size="small"
                data-test="task-format-nb3"
                >.nb3</v-btn
              >
              <v-btn
                v-if="formats.includes('sql')"
                value="sql"
                size="small"
                data-test="task-format-sql"
                >.sql</v-btn
              >
            </v-btn-toggle>
          </div>
          <v-checkbox
            :model-value="task.includeData !== false"
            label="Incluir datos (no solo estructura)"
            density="compact"
            hide-details
            class="step-settings__check"
            data-test="task-include-data"
            @update:model-value="update({ includeData: !!$event })"
          />
          <v-checkbox
            v-if="task.format === 'vqb'"
            :model-value="task.encrypt === true"
            label="Cifrar con contraseña"
            density="compact"
            hide-details
            class="step-settings__check"
            data-test="task-encrypt"
            @update:model-value="update({ encrypt: $event ? true : undefined })"
          />
          <p v-if="task.format === 'sql'" class="step-settings__hint" data-test="task-format-hint">
            Para llevar la copia a otros gestores. Las restauraciones automáticas necesitan .nb3 o
            .vqb.
          </p>
          <div
            v-else-if="task.format === 'vqb' && task.encrypt"
            class="step-settings__password"
            data-test="task-encrypt-hint"
          >
            <v-icon
              :icon="passwordReady ? 'mdi-lock-check-outline' : 'mdi-lock-alert-outline'"
              size="16"
              aria-hidden="true"
            />
            <span>
              {{
                passwordReady
                  ? 'Se cifra con la contraseña de la tarea, guardada cifrada en este equipo para las ejecuciones programadas.'
                  : 'Falta la contraseña de cifrado de la tarea.'
              }}
            </span>
            <v-btn
              size="x-small"
              variant="tonal"
              data-test="task-encrypt-options"
              @click="emit('openOptions')"
              >{{ passwordReady ? 'Cambiar' : 'Definir' }}</v-btn
            >
          </div>
        </template>

        <template v-else>
          <h4 class="step-settings__section">Consulta SQL</h4>
          <div class="step-settings__sql" data-test="step-sql">
            <SqlEditor
              :model-value="task.sql ?? ''"
              min-height="160px"
              @update:model-value="update({ sql: $event })"
            />
          </div>
        </template>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.step-settings {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: var(--nd-bg-panel);
}
.step-settings__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 8px 10px 14px;
  border-bottom: 1px solid var(--nd-border);
}
.step-settings__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-size: var(--nd-fs-xs);
  font-weight: 700;
  color: var(--nd-on-accent);
  background: var(--nd-accent-gradient);
}
.step-settings__icon {
  color: var(--nd-text-2);
}
.step-settings__heading {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.step-settings__title {
  margin: 0;
  font-size: var(--nd-fs-base);
  font-weight: var(--nd-fw-heading);
}
.step-settings__sub {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.step-settings__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.step-settings__problems {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--nd-radius-control);
  font-size: var(--nd-fs-dense);
  color: var(--nd-error);
  background: var(--nd-error-soft);
  border: 1px solid color-mix(in srgb, var(--nd-error) 30%, transparent);
}
.step-settings__problems .v-icon {
  margin-top: 2px;
}
.step-settings__section {
  margin: 8px 0 0;
  font-size: var(--nd-fs-xs);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--nd-text-muted);
}
.step-settings__group {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.step-settings__check {
  margin-left: -8px;
}
.step-settings__hint {
  margin: 2px 0 0;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.step-settings__format {
  display: flex;
  align-items: center;
  gap: 10px;
}
.step-settings__format-label {
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.step-settings__password {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--nd-radius-control);
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  background: rgba(var(--v-theme-warning), 0.06);
  border: 1px solid var(--nd-border);
}
.step-settings__password span {
  flex: 1;
}
.step-settings__content {
  margin-top: 4px;
}
.step-settings__sql {
  height: 220px;
  overflow: hidden;
  border-radius: var(--nd-radius-control);
  border: 1px solid var(--nd-border);
  background: var(--nd-bg-sunken);
}
</style>
