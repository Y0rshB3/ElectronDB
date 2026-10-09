<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { engineOf } from '@shared/engines'
import { backupFamilyName, backupFamilyOf } from '@shared/jobEngines'
import {
  buildCopyRestoreSteps,
  copyRestoreProblems,
  type CopyRestoreRecipe
} from '@shared/jobRecipes'
import type { ConnectionConfig, JobTask } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useSettingsStore } from '@renderer/stores/settings'
import DialogHeader from '@renderer/components/dialogs/DialogHeader.vue'
import ReplaceContentToggle from '@renderer/components/backups/ReplaceContentToggle.vue'
import { useSchemaLoader } from '@renderer/components/backups/useSchemaLoader'
import {
  automationConnections,
  canBackup,
  environmentLabel,
  environmentPillClass
} from '@renderer/components/backups/backupHelpers'
import { newStepId, taskProblems } from './jobForm'
import { connectionsForKind, visibleDatabases } from './jobSteps'

/**
 * «Copiar y restaurar»: picks an origin connection and its databases (all by
 * default), a destination connection, the safety copy of the destination and
 * the content, and adds the matching steps to the job: every copy, then every
 * restore of «la copia del paso N». The origin connection is opened only when
 * the user picks it (or picked it already in «Añadir pasos»).
 */
const open = defineModel<boolean>({ default: false })
const props = defineProps<{
  /** Steps already in the job (the new ones go after them). */
  tasks: JobTask[]
  /** Connection selected in «Añadir pasos», proposed as origin. */
  proposedSource?: string | null
}>()
const emit = defineEmits<{ add: [tasks: JobTask[]] }>()

const connections = useConnectionsStore()
const settings = useSettingsStore()
const schemaLoader = useSchemaLoader()

const sourceId = ref<string | null>(null)
const targetId = ref<string | null>(null)
const checked = ref<string[]>([])
/** Destination names typed per database (the others take name + suffix). */
const targets = ref<Record<string, string>>({})
const suffix = ref('')
const safetyBackup = ref(true)
const includeData = ref(true)

const nameOf = (id: string): string => connections.get(id)?.name ?? ''
const blocked = (c: ConnectionConfig): boolean => settings.needsTypedConfirm(c.environment)

const sources = computed(() => connectionsForKind('backup', connections.sorted))
const source = computed(() => (sourceId.value ? (connections.get(sourceId.value) ?? null) : null))
const target = computed(() => (targetId.value ? (connections.get(targetId.value) ?? null) : null))
const family = computed(() => (source.value ? backupFamilyOf(engineOf(source.value).id) : null))

const sourceItems = computed(() =>
  sources.value.map((c) => ({
    title: c.name,
    value: c.id,
    subtitle: environmentLabel(c.environment),
    pill: environmentPillClass(c.environment)
  }))
)

/** Destinations of the origin's engine; those that need the typed name are listed but disabled. */
const targetItems = computed(() =>
  automationConnections(connections.sorted)
    .filter(
      (c) => canBackup(c) && (!family.value || backupFamilyOf(engineOf(c).id) === family.value)
    )
    .map((c) => ({
      title: c.name,
      value: c.id,
      subtitle: blocked(c)
        ? `${environmentLabel(c.environment)} · pide escribir el nombre: una tarea no puede restaurar aquí`
        : environmentLabel(c.environment),
      pill: environmentPillClass(c.environment),
      env: environmentLabel(c.environment),
      props: { disabled: blocked(c) }
    }))
)

/** First local destination of the origin's engine that is not the origin and needs no typed name. */
function defaultTarget(from: ConnectionConfig | null): string | null {
  const fam = from ? backupFamilyOf(engineOf(from).id) : null
  const usable = automationConnections(connections.sorted).filter(
    (c) =>
      canBackup(c) &&
      !blocked(c) &&
      c.id !== from?.id &&
      (!fam || backupFamilyOf(engineOf(c).id) === fam)
  )
  return (usable.find((c) => c.environment === 'local') ?? null)?.id ?? null
}

const databases = computed(() =>
  source.value ? visibleDatabases(source.value, schemaLoader.of(source.value.id)) : []
)

async function pickSource(id: string | null): Promise<void> {
  sourceId.value = id
  checked.value = []
  targets.value = {}
  const from = id ? (connections.get(id) ?? null) : null
  const current = target.value
  if (
    !current ||
    current.id === id ||
    (from && backupFamilyOf(engineOf(current).id) !== backupFamilyOf(engineOf(from).id))
  )
    targetId.value = defaultTarget(from)
  if (!from) return
  // Picking the origin is the user's action: it opens the connection to list its databases.
  await schemaLoader.load(from.id)
  if (sourceId.value === from.id) checked.value = [...databases.value]
}

watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    suffix.value = ''
    safetyBackup.value = true
    includeData.value = true
    targetId.value = null
    const proposed =
      props.proposedSource && sources.value.some((c) => c.id === props.proposedSource)
    void pickSource(proposed ? props.proposedSource! : null)
  },
  { immediate: true }
)

/* ---------- databases ---------- */

const allChecked = computed(
  () => databases.value.length > 0 && databases.value.every((d) => checked.value.includes(d))
)
const someChecked = computed(() => checked.value.length > 0 && !allChecked.value)

function toggleAll(): void {
  checked.value = allChecked.value ? [] : [...databases.value]
}

function toggle(name: string, on: boolean): void {
  checked.value = on
    ? databases.value.filter((d) => d === name || checked.value.includes(d))
    : checked.value.filter((d) => d !== name)
}

/** Default destination name: the origin's name plus the suffix. */
const defaultTargetName = (name: string): string => `${name}${suffix.value.trim()}`

/** Destination of a database: the typed name, or the default when the field is empty. */
function targetName(name: string): string {
  return targets.value[name] || defaultTargetName(name)
}

function setTarget(name: string, value: string | null): void {
  targets.value = { ...targets.value, [name]: (value ?? '').trim() }
}

/** A new suffix applies to every database again (typed names included). */
watch(suffix, () => (targets.value = {}))

/* ---------- steps ---------- */

const recipe = computed<CopyRestoreRecipe>(() => ({
  sourceConnectionId: sourceId.value ?? '',
  targetConnectionId: targetId.value ?? '',
  databases: databases.value
    .filter((d) => checked.value.includes(d))
    .map((name) => ({ name, target: targetName(name) })),
  safetyBackup: safetyBackup.value,
  includeData: includeData.value
}))

/** Steps the recipe would add, with stable ids so the problems do not flicker. */
const preview = computed(() => {
  let n = 0
  return buildCopyRestoreSteps(recipe.value, nameOf, () => `preview-${++n}`)
})

/** Problems of each restore step, by origin database (the job's own per-step rules). */
const rowProblems = computed<Record<string, string>>(() => {
  const all = [...props.tasks, ...preview.value]
  const out: Record<string, string> = {}
  preview.value.forEach((step, i) => {
    if (step.type !== 'restoreschema' || !targetId.value) return
    const problem = taskProblems(
      step,
      props.tasks.length + i,
      all,
      (id) => connections.get(id),
      settings.typedEnvironments
    )[0]
    const from = preview.value.find(
      (t) => step.restoreSource?.kind === 'task' && t.id === step.restoreSource.taskId
    )
    // «Paso 7: …» names a position the user has not seen yet: drop the prefix.
    if (problem && from) out[from.schema] = problem.replace(/^Paso \d+: /, '')
  })
  return out
})

const problems = computed(() => copyRestoreProblems(recipe.value))
const canAdd = computed(
  () =>
    !problems.value.length &&
    !Object.keys(rowProblems.value).length &&
    !!recipe.value.databases.length
)

const count = computed(() => recipe.value.databases.length)
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

const summary = computed(() => {
  const n = count.value
  if (!n || !source.value || !target.value) return ''
  return `Añadirá ${2 * n} pasos: ${n} ${plural(n, 'copia', 'copias')} de ${source.value.name} y, después, ${n} ${plural(n, 'restauración', 'restauraciones')} en ${target.value.name} ${safetyBackup.value ? 'con' : 'sin'} copia previa.`
})

const safetyText = computed(() => {
  const name = target.value?.name ?? 'el destino'
  return safetyBackup.value
    ? `Antes de reemplazar cada base de datos de ${name} se guarda una copia de lo que tenía (etiqueta «previo-rollback»), para poder deshacer la restauración.`
    : `Las bases de datos de ${name} se reemplazan directamente: lo que tenían se pierde.`
})

const targetHint = computed(() =>
  family.value && family.value !== 'mysql'
    ? `Solo conexiones ${backupFamilyName(family.value)} (el motor del origen).`
    : 'Las conexiones que piden escribir su nombre (producción…) aparecen desactivadas.'
)

function add(): void {
  if (!canAdd.value) return
  emit('add', buildCopyRestoreSteps(recipe.value, nameOf, newStepId))
  open.value = false
}
</script>

<template>
  <v-dialog v-model="open" max-width="780" scrollable>
    <v-card v-if="open" class="copy-restore" data-test="copy-restore-dialog">
      <DialogHeader
        icon="mdi-database-sync-outline"
        title="Copiar y restaurar"
        subtitle="Copia bases de datos de una conexión y las restaura en otra en cada ejecución"
      />
      <v-card-text class="copy-restore__body">
        <div class="copy-restore__route">
          <v-select
            :model-value="sourceId"
            :items="sourceItems"
            label="Origen: copiar de"
            prepend-inner-icon="mdi-database-export-outline"
            no-data-text="No hay conexiones que admitan copias"
            hide-details
            data-test="recipe-source"
            @update:model-value="pickSource($event)"
          >
            <template #item="{ props: itemProps, item }">
              <v-list-item v-bind="itemProps">
                <template #append>
                  <span class="nd-pill" :class="item.raw.pill">{{ item.raw.subtitle }}</span>
                </template>
              </v-list-item>
            </template>
          </v-select>
          <v-icon
            icon="mdi-arrow-right-thick"
            size="20"
            class="copy-restore__arrow"
            aria-hidden="true"
          />
          <v-select
            v-model="targetId"
            :items="targetItems"
            label="Destino: restaurar en"
            prepend-inner-icon="mdi-database-import-outline"
            no-data-text="No hay conexiones del mismo motor"
            hide-details
            data-test="recipe-target"
          >
            <template #item="{ props: itemProps, item }">
              <v-list-item v-bind="itemProps" :subtitle="undefined">
                <v-list-item-subtitle v-if="item.raw.props.disabled" class="copy-restore__blocked">
                  {{ item.raw.subtitle }}
                </v-list-item-subtitle>
                <template #append>
                  <span class="nd-pill" :class="item.raw.pill">{{ item.raw.env }}</span>
                </template>
              </v-list-item>
            </template>
          </v-select>
        </div>
        <p class="copy-restore__hint">{{ targetHint }}</p>

        <div class="copy-restore__dbs-head">
          <v-checkbox-btn
            :model-value="allChecked"
            :indeterminate="someChecked"
            :disabled="!databases.length"
            density="compact"
            aria-label="Seleccionar todas las bases de datos"
            data-test="recipe-select-all"
            @update:model-value="toggleAll"
          />
          <span class="copy-restore__dbs-title">
            {{ source ? `Bases de datos de ${source.name}` : 'Bases de datos' }}
          </span>
          <span v-if="databases.length" class="nd-pill" data-test="recipe-count"
            >{{ checked.length }}/{{ databases.length }}</span
          >
          <v-text-field
            v-model="suffix"
            density="compact"
            hide-details
            placeholder="sin sufijo"
            persistent-placeholder
            label="Sufijo en destino"
            class="copy-restore__suffix"
            :disabled="!databases.length"
            data-test="recipe-suffix"
          />
        </div>
        <div class="copy-restore__dbs" data-test="recipe-databases">
          <p v-if="!source" class="copy-restore__empty">
            <v-icon icon="mdi-gesture-tap" size="16" aria-hidden="true" />
            Elige la conexión de origen para ver sus bases de datos.
          </p>
          <p v-else-if="schemaLoader.isLoading(source.id)" class="copy-restore__empty">
            <v-progress-circular indeterminate size="14" width="2" /> Cargando bases de datos…
          </p>
          <p
            v-else-if="schemaLoader.errorOf(source.id)"
            class="copy-restore__empty copy-restore__error"
          >
            {{ schemaLoader.errorOf(source.id) }}
          </p>
          <p v-else-if="!databases.length" class="copy-restore__empty">
            {{ source.name }} no tiene bases de datos que copiar (las del sistema no se ofrecen).
          </p>
          <ul v-else class="copy-restore__list" aria-label="Bases de datos a copiar y restaurar">
            <li
              v-for="name in databases"
              :key="name"
              class="copy-restore__row"
              :class="{ 'copy-restore__row--off': !checked.includes(name) }"
              :data-test="`recipe-db-${name}`"
            >
              <v-checkbox-btn
                :model-value="checked.includes(name)"
                density="compact"
                :aria-label="`Copiar y restaurar ${name}`"
                @update:model-value="toggle(name, !!$event)"
              />
              <div class="copy-restore__row-main">
                <div class="copy-restore__row-route">
                  <span class="copy-restore__name nd-mono" :title="name">{{ name }}</span>
                  <v-icon icon="mdi-arrow-right" size="14" class="copy-restore__row-arrow" />
                  <v-text-field
                    :model-value="targets[name] ?? defaultTargetName(name)"
                    density="compact"
                    hide-details
                    :placeholder="defaultTargetName(name)"
                    :disabled="!checked.includes(name)"
                    :aria-label="`Base de datos de destino de ${name}`"
                    class="copy-restore__target nd-mono"
                    :data-test="`recipe-target-${name}`"
                    @update:model-value="setTarget(name, $event)"
                  />
                </div>
                <div
                  v-if="checked.includes(name) && rowProblems[name]"
                  class="copy-restore__problem"
                  data-test="recipe-row-problem"
                >
                  {{ rowProblems[name] }}
                </div>
              </div>
            </li>
          </ul>
        </div>

        <div class="copy-restore__options">
          <div class="copy-restore__option">
            <div id="recipe-safety-label" class="copy-restore__option-label">
              Copia previa del destino
            </div>
            <v-btn-toggle
              v-model="safetyBackup"
              mandatory
              divided
              density="compact"
              variant="outlined"
              class="copy-restore__toggle"
              aria-labelledby="recipe-safety-label"
              data-test="recipe-safety"
            >
              <v-btn
                :value="true"
                prepend-icon="mdi-shield-check-outline"
                data-test="recipe-safety-on"
                >Con copia previa</v-btn
              >
              <v-btn :value="false" prepend-icon="mdi-flash-outline" data-test="recipe-safety-off"
                >Sin copia previa</v-btn
              >
            </v-btn-toggle>
            <div class="copy-restore__option-hint" data-test="recipe-safety-hint">
              {{ safetyText }}
            </div>
          </div>
          <ReplaceContentToggle v-model="includeData" class="copy-restore__option" />
        </div>

        <ul
          v-if="problems.length && sourceId"
          class="copy-restore__problems"
          data-test="recipe-problems"
        >
          <li v-for="p in problems" :key="p">{{ p }}</li>
        </ul>
        <p v-if="summary" class="copy-restore__summary" data-test="recipe-summary">
          <v-icon icon="mdi-playlist-plus" size="16" aria-hidden="true" />{{ summary }}
        </p>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn data-test="recipe-cancel" @click="open = false">Cancelar</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-playlist-plus"
          :disabled="!canAdd"
          data-test="recipe-add"
          @click="add"
        >
          {{ count ? `Añadir ${2 * count} pasos` : 'Añadir pasos' }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.copy-restore__body {
  padding-top: 4px !important;
}
.copy-restore__route {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}
.copy-restore__arrow {
  color: var(--nd-accent);
}
.copy-restore__hint {
  margin: 6px 2px 12px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.copy-restore__blocked {
  white-space: normal;
}
.copy-restore__dbs-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.copy-restore__dbs-head :deep(.v-selection-control) {
  flex: none;
}
.copy-restore__dbs-title {
  font-size: var(--nd-fs-dense);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.copy-restore__suffix {
  margin-left: auto;
  flex: 0 0 170px;
}
.copy-restore__dbs {
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-raised);
}
.copy-restore__empty {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 14px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.copy-restore__error {
  color: var(--nd-error);
}
.copy-restore__list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.copy-restore__row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px 4px 4px;
}
.copy-restore__row + .copy-restore__row {
  border-top: 1px solid var(--nd-hairline);
}
.copy-restore__row :deep(.v-selection-control) {
  flex: none;
}
.copy-restore__row--off .copy-restore__name {
  opacity: 0.6;
}
.copy-restore__row-main {
  flex: 1;
  min-width: 0;
}
.copy-restore__row-route {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}
.copy-restore__name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.copy-restore__row-arrow {
  color: var(--nd-accent);
}
.copy-restore__problem {
  margin: 2px 0 2px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-error);
}
.copy-restore__options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 16px;
}
.copy-restore__option-label {
  margin-bottom: 4px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.copy-restore__toggle :deep(.v-btn) {
  text-transform: none;
}
.copy-restore__option-hint {
  margin-top: 4px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.copy-restore__problems {
  margin: 12px 0 0;
  padding-left: 18px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-error);
}
.copy-restore__summary {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 14px 0 0;
  padding: 8px 12px;
  border-radius: var(--nd-radius-control);
  background: rgba(var(--nd-accent-rgb), 0.08);
  font-size: var(--nd-fs-dense);
  color: var(--nd-text);
}
.copy-restore__summary .v-icon {
  color: var(--nd-accent);
  margin-top: 2px;
}
@media (max-width: 700px) {
  .copy-restore__options {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
