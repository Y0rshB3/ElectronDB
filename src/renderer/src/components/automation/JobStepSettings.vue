<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { restoreSourceOf } from '@shared/restoreTask'
import {
  ownPackageEntries,
  packageTargetName,
  restoresWholePackage,
  type PackageEntry
} from '@shared/restorePackage'
import { packageDate } from '@shared/backupPackages'
import { engineOf } from '@shared/engines'
import {
  backupFamilyName,
  backupFamilyOf,
  jobBackupFormats,
  jobDatabaseLabel,
  supportsQuerySteps
} from '@shared/jobEngines'
import type { ConnectionConfig, JobTask, JobTaskType } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useSettingsStore } from '@renderer/stores/settings'
import { useJobsStore } from '@renderer/stores/jobs'
import SqlEditor from '@renderer/components/common/SqlEditor.vue'
import { useSchemaLoader } from '@renderer/components/backups/useSchemaLoader'
import { automationConnections, environmentLabel } from '@renderer/components/backups/backupHelpers'
import ReplaceContentToggle from '@renderer/components/backups/ReplaceContentToggle.vue'
import {
  TASK_ICONS,
  TASK_TYPES,
  defaultReferenceName,
  hasAutoName,
  newPackageTask,
  newRestoreTask,
  newTask
} from './jobForm'

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
  /** The job being edited (never offered as «último paquete de otra tarea»). */
  jobId?: string | null
}>()
const emit = defineEmits<{ close: []; openOptions: [] }>()

const connections = useConnectionsStore()
const settings = useSettingsStore()
const jobs = useJobsStore()
const schemaLoader = useSchemaLoader()
const jobNameOf = (id: string): string | undefined => jobs.get(id)?.name

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
const stepNameOf = (id: string): string => connections.get(id)?.name ?? ''

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

/* ---------- «Restaurar paquete» ---------- */

/** Copies of the step's package as far as the editor knows them (another job: its latest package). */
const packageEntries = computed<PackageEntry[]>(() => {
  const t = task.value
  if (t?.type !== 'restorepackage') return []
  const source = t.packageSource
  if (!source || source.kind === 'own') return ownPackageEntries(t, tasks.value)
  const pkg = jobs.packageOf(source.jobId)
  if (pkg?.latest)
    return pkg.latest.copies.map((c) => ({
      schema: c.schema,
      connectionId: c.connectionId,
      structureOnly: c.structureOnly,
      path: c.path
    }))
  return (pkg?.steps ?? []).map((s) => ({
    schema: s.schema,
    connectionId: s.connectionId,
    structureOnly: !s.includeData
  }))
})

/** Databases listed in the panel: the package's, plus chosen ones it does not have (now). */
const packageRows = computed(() => {
  const t = task.value
  if (!t) return []
  const rows = packageEntries.value.map((e) => ({ ...e, missing: false }))
  for (const name of t.packageDatabases ?? [])
    if (!rows.some((r) => r.schema === name))
      rows.push({ schema: name, connectionId: null, structureOnly: false, missing: true })
  return rows
})

watch(
  () => task.value?.type === 'restorepackage',
  (isPackage) => {
    if (isPackage && !jobs.packagesLoaded) void jobs.loadPackages()
  },
  { immediate: true }
)

const packageSourceItems = computed(() => {
  const own = {
    title: 'Paquete de esta tarea',
    subtitle: 'Las copias de los pasos anteriores, recién hechas en la misma ejecución',
    value: 'own'
  }
  const current = task.value?.packageSource
  const others = jobs.packages
    .filter((p) => p.jobId !== props.jobId)
    .map((p) => ({
      title: `Último paquete de «${p.jobName}»`,
      subtitle: p.latest
        ? `${packageDate(p.latest.startedAt)} · ${p.latest.copies.length} ${p.latest.copies.length === 1 ? 'copia' : 'copias'}`
        : 'Aún no se ha ejecutado',
      value: `job:${p.jobId}`
    }))
  // A job that no longer exists (or not loaded yet) stays selectable under its saved name.
  if (current?.kind === 'job' && !others.some((o) => o.value === `job:${current.jobId}`))
    others.push({
      title: `Último paquete de «${jobNameOf(current.jobId) ?? current.jobName ?? 'tarea eliminada'}»`,
      subtitle: jobs.packagesLoaded ? 'No se encuentra la tarea ni sus copias' : 'Cargando…',
      value: `job:${current.jobId}`
    })
  return [own, ...others]
})

const packageSourceValue = computed(() => {
  const source = task.value?.packageSource
  if (!source) return null
  return source.kind === 'own' ? 'own' : `job:${source.jobId}`
})

function changePackageSource(value: string | null): void {
  if (!value) return
  if (value === 'own') update({ packageSource: { kind: 'own' }, packageDatabases: undefined })
  else {
    const jobId = value.slice(4)
    const name = jobs.packageOf(jobId)?.jobName ?? jobNameOf(jobId)
    update({
      packageSource: { kind: 'job', jobId, ...(name ? { jobName: name } : {}) },
      packageDatabases: undefined
    })
  }
}

/** One line under the package select: what it holds now. */
const packageInfo = computed(() => {
  const t = task.value
  if (t?.type !== 'restorepackage') return ''
  const n = packageEntries.value.length
  const copies = `${n} ${n === 1 ? 'copia' : 'copias'}`
  if (t.packageSource?.kind !== 'job')
    return n
      ? `${copies} de los pasos anteriores de esta tarea. Si añades más copias antes de este paso, también entran.`
      : 'Aún no hay pasos de copia antes de este paso: añádelos antes o elige el paquete de otra tarea.'
  const pkg = jobs.packageOf(t.packageSource.jobId)
  if (!pkg?.latest)
    return 'Esa tarea aún no ha hecho ningún paquete: se usará el de su próxima ejecución.'
  return `Ahora: ejecución del ${packageDate(pkg.latest.startedAt)}, ${copies}. En cada ejecución se busca otra vez su último paquete.`
})

const wholePackage = computed(() => (task.value ? restoresWholePackage(task.value) : true))

function changeWhole(value: string | null): void {
  if (value === 'all') update({ packageDatabases: undefined })
  else if (value === 'some' && wholePackage.value)
    update({ packageDatabases: packageEntries.value.map((e) => e.schema) })
}

function togglePackageDb(name: string, on: boolean): void {
  const current = task.value?.packageDatabases ?? []
  const next = on
    ? packageRows.value.map((r) => r.schema).filter((n) => n === name || current.includes(n))
    : current.filter((n) => n !== name)
  update({ packageDatabases: next })
}

function setPackageTarget(name: string, value: string | null): void {
  const targets = { ...(task.value?.packageTargets ?? {}) }
  const v = (value ?? '').trim()
  if (v && v !== `${name}${task.value?.packageSuffix?.trim() ?? ''}`) targets[name] = v
  else delete targets[name]
  update({ packageTargets: Object.keys(targets).length ? targets : undefined })
}

function setPackageSuffix(value: string | null): void {
  const v = (value ?? '').trim()
  update({ packageSuffix: v || undefined })
}

const safetyText = computed(() => {
  const name = connectionOf(task.value?.connectionId)?.name ?? 'el destino'
  return task.value?.safetyBackup !== false
    ? `Antes de reemplazar cada base de datos de ${name} se guarda una copia de lo que tenía (etiqueta «previo-rollback»), para poder deshacer la restauración.`
    : `Las bases de datos de ${name} se reemplazan directamente: lo que tenían se pierde.`
})

/** Engine of the copies a restore step reads (its source connection), when known. */
const sourceFamily = computed(() => {
  if (!task.value) return null
  if (task.value.type === 'restorepackage') {
    for (const e of packageEntries.value) {
      const c = connectionOf(e.connectionId)
      if (c) return backupFamilyOf(engineOf(c).id)
    }
    return null
  }
  const from = restoreSourceOf(task.value, tasks.value)?.connectionId
  const connection = connectionOf(from)
  return connection ? backupFamilyOf(connection.engine) : null
})

/** Changes that alter a step's default name («Copia de ventas (Staging)»…). */
const NAMING: (keyof JobTask)[] = [
  'connectionId',
  'schema',
  'restoreSource',
  'packageSource',
  'type'
]

function update(changes: Partial<JobTask>): void {
  if (index.value < 0) return
  const next = [...tasks.value]
  const current = next[index.value]
  // A name Vortaq gave the step follows its connection, database and source.
  if (
    !('referenceName' in changes) &&
    NAMING.some((k) => k in changes) &&
    (hasAutoName(current, tasks.value, stepNameOf) ||
      current.referenceName.trim() ===
        defaultReferenceName(current, tasks.value, stepNameOf, jobNameOf))
  )
    changes = { ...changes, referenceName: '' }
  next[index.value] = { ...current, ...changes }
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
  const before = tasks.value.slice(0, index.value)
  const blocked = (c: ConnectionConfig): boolean => settings.needsTypedConfirm(c.environment)
  const firstCopy = before.find((t) => t.type === 'backupschema' && connectionOf(t.connectionId))
  const base =
    type === 'restoreschema'
      ? newRestoreTask(before, automationConnections(connections.sorted), blocked)
      : type === 'restorepackage'
        ? newPackageTask(
            { kind: 'own' },
            automationConnections(connections.sorted),
            blocked,
            firstCopy ? backupFamilyOf(connectionOf(firstCopy.connectionId)!.engine) : null,
            undefined,
            before.filter((t) => t.type === 'backupschema').map((t) => t.connectionId)
          )
        : newTask(type, current.connectionId, current.schema)
  const next = [...tasks.value]
  next[index.value] = { ...base, id: current.id, referenceName: current.referenceName }
  tasks.value = next
}

/** «Copia de ventas (Staging)» already names its connection; other names get it appended. */
function withConnection(name: string, connection: string): string {
  return name.includes(`(${connection})`) ? name : `${name} (${connection})`
}

/** «Origen» choices of a restore step: earlier backup steps, or the latest file on disk. */
const sourceItems = computed(() => {
  const items = tasks.value.slice(0, Math.max(index.value, 0)).flatMap((t, i) =>
    t.type === 'backupschema'
      ? [
          {
            title: `Paso ${i + 1} · ${withConnection(t.referenceName || defaultReferenceName(t, tasks.value, stepNameOf), t.connectionId ? connections.nameOf(t.connectionId) : '—')}${t.includeData === false ? ' · solo estructura' : ''}${t.format === 'sql' ? ' · .sql (no restaurable)' : t.format === 'vqb' ? ` · .vqb${t.encrypt ? ' cifrada' : ''}` : ''}`,
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

const titleEl = ref<HTMLElement | null>(null)
/** Moves keyboard focus into the panel (opened with Intro from the sequence). */
function focus(): void {
  titleEl.value?.focus()
}
defineExpose({ focus })

/**
 * Esc closes the panel, but not while a menu, the SQL editor (autocomplete,
 * search) or another overlay is handling it.
 */
function onEscape(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (event.defaultPrevented || target?.closest('.cm-editor')) return
  if (document.querySelector('.v-overlay--active .v-list, .v-overlay--active .v-menu')) return
  event.stopPropagation()
  emit('close')
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
    @keydown.esc="onEscape"
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
        <h3 ref="titleEl" class="step-settings__title" tabindex="-1">Paso {{ index + 1 }}</h3>
        <span class="step-settings__sub">{{
          task.referenceName || defaultReferenceName(task, tasks, stepNameOf)
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
          :placeholder="defaultReferenceName(task, tasks, stepNameOf)"
          persistent-placeholder
          data-test="step-reference"
          @update:model-value="update({ referenceName: $event })"
        />
      </div>

      <template v-if="task.type === 'restorepackage'">
        <h4 class="step-settings__section">Paquete</h4>
        <div class="step-settings__group">
          <v-select
            :model-value="packageSourceValue"
            :items="packageSourceItems"
            label="Paquete a restaurar"
            :hint="packageInfo"
            persistent-hint
            prepend-inner-icon="mdi-package-variant-closed"
            data-test="package-source"
            @update:model-value="changePackageSource($event)"
          />
        </div>
        <h4 class="step-settings__section">Bases de datos</h4>
        <div class="step-settings__dbs-head">
          <v-btn-toggle
            :model-value="wholePackage ? 'all' : 'some'"
            mandatory
            divided
            density="compact"
            variant="outlined"
            class="step-settings__toggle"
            aria-label="Bases de datos del paquete"
            data-test="package-whole"
            @update:model-value="changeWhole($event)"
          >
            <v-btn value="all" data-test="package-whole-all">Todas</v-btn>
            <v-btn value="some" data-test="package-whole-some">Solo las marcadas</v-btn>
          </v-btn-toggle>
          <v-text-field
            :model-value="task.packageSuffix ?? ''"
            density="compact"
            hide-details
            label="Sufijo en destino"
            placeholder="sin sufijo"
            persistent-placeholder
            class="step-settings__suffix step-settings__mono"
            data-test="package-suffix"
            @update:model-value="setPackageSuffix($event)"
          />
        </div>
        <p class="step-settings__hint">
          {{
            wholePackage
              ? 'Todas las bases del paquete, también las que entren en él más adelante.'
              : 'Solo las marcadas; una base nueva en el paquete no se restaura hasta que la marques.'
          }}
          {{
            task.includeData !== false && packageRows.some((r) => r.structureOnly)
              ? 'Las copias solo de estructura no se restauran con datos.'
              : ''
          }}
        </p>
        <ul
          v-if="packageRows.length"
          class="step-settings__dbs"
          aria-label="Bases de datos del paquete"
          data-test="package-databases"
        >
          <li
            v-for="row in packageRows"
            :key="row.schema"
            class="step-settings__db"
            :class="{
              'step-settings__db--off':
                (!wholePackage && !task.packageDatabases?.includes(row.schema)) ||
                (task.includeData !== false && row.structureOnly)
            }"
            :data-test="`package-db-${row.schema}`"
          >
            <v-checkbox-btn
              :model-value="
                wholePackage
                  ? !(task.includeData !== false && row.structureOnly)
                  : !!task.packageDatabases?.includes(row.schema)
              "
              :disabled="wholePackage"
              density="compact"
              :aria-label="`Restaurar ${row.schema}`"
              @update:model-value="togglePackageDb(row.schema, !!$event)"
            />
            <span class="step-settings__db-name nd-mono" :title="row.schema">{{ row.schema }}</span>
            <v-icon icon="mdi-arrow-right" size="13" class="step-settings__db-arrow" />
            <v-text-field
              :model-value="task.packageTargets?.[row.schema] ?? ''"
              density="compact"
              hide-details
              :placeholder="packageTargetName({ ...task, packageTargets: {} }, row.schema)"
              persistent-placeholder
              :aria-label="`Base de datos de destino de ${row.schema}`"
              class="step-settings__db-target step-settings__mono"
              :data-test="`package-target-${row.schema}`"
              @update:model-value="setPackageTarget(row.schema, $event)"
            />
            <span v-if="row.missing" class="nd-pill nd-pill--staging step-settings__db-tag"
              >no está en el paquete</span
            >
            <span v-else-if="row.structureOnly" class="nd-pill step-settings__db-tag"
              >solo estructura</span
            >
          </li>
        </ul>
        <p v-else class="step-settings__hint">
          {{
            jobs.packagesLoaded || task.packageSource?.kind !== 'job'
              ? 'El paquete aún no tiene copias.'
              : 'Cargando el paquete…'
          }}
        </p>
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
            data-test="package-target"
            @update:model-value="update({ connectionId: $event ?? '' })"
          />
        </div>
        <ReplaceContentToggle
          :model-value="task.includeData !== false"
          class="step-settings__content"
          data-test="package-content"
          @update:model-value="update({ includeData: $event })"
        />
        <div class="step-settings__safety">
          <div id="package-safety-label" class="step-settings__format-label">
            Copia previa del destino
          </div>
          <v-btn-toggle
            :model-value="task.safetyBackup !== false"
            mandatory
            divided
            density="compact"
            variant="outlined"
            class="step-settings__toggle"
            aria-labelledby="package-safety-label"
            data-test="package-safety"
            @update:model-value="update({ safetyBackup: !!$event })"
          >
            <v-btn
              :value="true"
              prepend-icon="mdi-shield-check-outline"
              data-test="package-safety-on"
              >Con copia previa</v-btn
            >
            <v-btn :value="false" prepend-icon="mdi-flash-outline" data-test="package-safety-off"
              >Sin copia previa</v-btn
            >
          </v-btn-toggle>
          <p class="step-settings__hint" data-test="package-safety-hint">{{ safetyText }}</p>
        </div>
        <p class="step-settings__hint">
          Cada base de datos de destino se borra y se crea de nuevo con
          {{
            task.includeData === false
              ? 'la estructura de su copia (tablas vacías).'
              : 'el contenido de su copia.'
          }}
          Al ejecutarse, el paso se convierte en una restauración por base de datos (cada una con su
          línea en el registro). {{ blockedHint }}
        </p>
      </template>

      <template v-else-if="task.type === 'restoreschema'">
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
  outline: none;
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
  margin: 10px 0 6px;
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
.step-settings__toggle :deep(.v-btn) {
  text-transform: none;
  letter-spacing: 0;
}
.step-settings__dbs-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.step-settings__suffix {
  flex: 1;
  min-width: 120px;
}
.step-settings__mono :deep(input) {
  font-family: var(--nd-font-mono, ui-monospace, monospace);
}
.step-settings__dbs {
  flex: none;
  list-style: none;
  margin: 0;
  padding: 4px;
  max-height: 260px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-control);
  background: var(--nd-bg-sunken);
}
.step-settings__db {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding-right: 4px;
}
.step-settings__db > :deep(.v-selection-control) {
  flex: none;
}
.step-settings__db-target {
  flex: 1.3 1 0;
  min-width: 0;
}
.step-settings__db--off .step-settings__db-name,
.step-settings__db--off .step-settings__db-target {
  opacity: 0.55;
}
.step-settings__db-name {
  flex: 1 1 0;
  min-width: 0;
  font-size: var(--nd-fs-dense);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.step-settings__db-arrow {
  flex: none;
  color: var(--nd-text-muted);
}
.step-settings__db-tag {
  flex: none;
  white-space: nowrap;
}
.step-settings__safety {
  display: flex;
  flex-direction: column;
  gap: 4px;
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
