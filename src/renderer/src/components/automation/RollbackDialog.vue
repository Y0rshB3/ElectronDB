<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { JobRun, RollbackPlan, RollbackPlanItem } from '@shared/types'
import { api } from '@renderer/api'
import { useConfirm } from '@renderer/composables/useConfirm'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useSettingsStore } from '@renderer/stores/settings'
import { useJobsStore } from '@renderer/stores/jobs'
import { formatBytes, formatDate } from '@renderer/utils/format'
import DialogHeader from '@renderer/components/dialogs/DialogHeader.vue'
import {
  environmentLabel,
  environmentPillClass,
  findLocalConnection
} from '@renderer/components/backups/backupHelpers'
import { UNDO_REPLACE_HOW } from '@shared/jobLog'
import {
  contentText,
  rollbackConfirmation,
  selectedByDefault,
  type RollbackDialogSource
} from './rollback'

/**
 * «Restaurar todo en Local»: restores every backup of a finished run (`run`)
 * or a package of backup files (`source`) into a target connection. Each
 * selected database is REPLACED (dropped and created again from the backup),
 * after an optional safety backup of the current one.
 */
const props = defineProps<{ run?: JobRun | null; source?: RollbackDialogSource | null }>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ started: [run: JobRun] }>()

const connections = useConnectionsStore()
const settings = useSettingsStore()
const jobs = useJobsStore()
const notify = useNotify()
const { confirmDestructive } = useConfirm()

const targetId = ref<string | null>(null)
const plan = ref<RollbackPlan | null>(null)
const loading = ref(false)
const error = ref('')
const selected = ref<string[]>([])
const safetyBackup = ref(true)
const starting = ref(false)
/** Answer of the latest plan request (target changes while one is loading). */
let planRequest = 0

const effective = computed<RollbackDialogSource | null>(
  () => props.source ?? (props.run ? { kind: 'run', runId: props.run.id } : null)
)
const isFiles = computed(() => effective.value?.kind === 'files')
const target = computed(() => (targetId.value ? connections.get(targetId.value) : undefined))
/** Production, and the environments chosen in Ajustes › Seguridad, need the typed name. */
const needsTyped = computed(() => settings.needsTypedConfirm(target.value?.environment))
const typedWarning = computed(() =>
  target.value?.environment === 'production'
    ? `«${target.value.name}» es una conexión de PRODUCCIÓN. Para continuar tendrás que escribir su nombre.`
    : `«${target.value?.name}» es una conexión de entorno ${target.value ? environmentLabel(target.value.environment) : ''} que requiere confirmación (Ajustes › Seguridad). Para continuar tendrás que escribir su nombre.`
)
const connectionItems = computed(() =>
  connections.sorted.map((c) => ({
    title: c.name,
    value: c.id,
    subtitle: environmentLabel(c.environment),
    pill: environmentPillClass(c.environment)
  }))
)
const items = computed<RollbackPlanItem[]>(() => plan.value?.items ?? [])
const chosen = computed(() => items.value.filter((i) => selected.value.includes(i.taskId)))
const duplicated = computed(() => {
  const seen = new Set<string>()
  for (const item of chosen.value) {
    if (seen.has(item.targetSchema)) return item.targetSchema
    seen.add(item.targetSchema)
  }
  return null
})
const replacedCount = computed(() => chosen.value.filter((i) => i.targetExists !== false).length)
const canStart = computed(
  () =>
    !!target.value &&
    !!plan.value &&
    chosen.value.length > 0 &&
    !duplicated.value &&
    !loading.value &&
    !starting.value
)

const subtitle = computed(() => {
  const source = effective.value
  if (source?.kind === 'files') {
    const n = source.backupPaths.length
    return `${plan.value?.jobName ?? source.title} · ${n} ${n === 1 ? 'copia' : 'copias'}`
  }
  return plan.value
    ? `${plan.value.jobName} · ejecución del ${formatDate(plan.value.runStartedAt)}`
    : undefined
})

/** First local connection; never a production one, even when it is the only choice. */
function defaultTarget(): string | null {
  return findLocalConnection(connections.sorted)?.id ?? null
}

/** Steps the opener asked to pre-check (a run source with `taskIds`); null = all. */
function requestedIds(): Set<string> | null {
  const source = effective.value
  return source?.kind === 'run' && source.taskIds?.length ? new Set(source.taskIds) : null
}

async function loadPlan(): Promise<void> {
  const source = effective.value
  if (!source) return
  const request = ++planRequest
  loading.value = true
  error.value = ''
  try {
    const next = await api.jobs.rollbackPlan(
      source.kind === 'run'
        ? source.runId
        : {
            source: 'files',
            backupPaths: [...source.backupPaths],
            sourceConnectionId: source.sourceConnectionId,
            title: source.title
          },
      targetId.value
    )
    if (request !== planRequest) return
    // Keep the user's choice across target changes; new plans start with every
    // database that can run selected (only the requested ones when the opener
    // picked some), except structure-only copies (they would leave the target
    // tables empty: the user has to opt in).
    const previous = plan.value ? new Set(selected.value) : null
    const requested = requestedIds()
    plan.value = next
    selected.value = next.items
      .filter(
        (i) =>
          !i.problem &&
          (previous
            ? previous.has(i.taskId)
            : selectedByDefault(i) && (!requested || requested.has(i.taskId)))
      )
      .map((i) => i.taskId)
  } catch (err) {
    if (request !== planRequest) return
    plan.value = null
    error.value = errorMessage(err)
  } finally {
    if (request === planRequest) loading.value = false
  }
}

function reset(): void {
  targetId.value = defaultTarget()
  plan.value = null
  selected.value = []
  safetyBackup.value = true
  error.value = ''
  starting.value = false
}

watch(
  open,
  (value) => {
    if (!value) return
    reset()
    void loadPlan()
  },
  { immediate: true }
)

function onTargetChange(id: string | null): void {
  targetId.value = id
  void loadPlan()
}

function toggle(item: RollbackPlanItem, value: boolean | null): void {
  const set = new Set(selected.value)
  if (value) set.add(item.taskId)
  else set.delete(item.taskId)
  selected.value = items.value.filter((i) => set.has(i.taskId)).map((i) => i.taskId)
}

function stateOf(item: RollbackPlanItem): { label: string; pill: string } {
  if (item.targetExists === true) return { label: 'Se reemplaza', pill: 'nd-pill--staging' }
  if (item.targetExists === false) return { label: 'Nueva', pill: 'nd-pill--info' }
  return { label: 'Sin comprobar', pill: '' }
}

async function start(): Promise<void> {
  const source = effective.value
  if (!canStart.value || !target.value || !plan.value || !source) return
  const text = rollbackConfirmation({
    jobName: plan.value.jobName,
    runDate: formatDate(plan.value.runStartedAt),
    targetName: target.value.name,
    items: chosen.value,
    safetyBackup: safetyBackup.value,
    ...(source.kind === 'files' ? { origin: `las copias de «${plan.value.jobName}»` } : {})
  })
  const ok = await confirmDestructive({
    connectionId: target.value.id,
    title: text.title,
    message: text.message,
    details: text.details,
    confirmText: replacedCount.value ? 'Reemplazar y restaurar' : 'Restaurar',
    alwaysAsk: true
  })
  if (!ok) return
  starting.value = true
  error.value = ''
  try {
    const run = await jobs.rollback(
      source.kind === 'run'
        ? {
            runId: source.runId,
            targetConnectionId: target.value.id,
            taskIds: chosen.value.map((i) => i.taskId),
            safetyBackup: safetyBackup.value
          }
        : {
            source: 'files',
            backupPaths: chosen.value.map((i) => i.backupPath),
            sourceConnectionId: source.sourceConnectionId,
            title: source.title,
            targetConnectionId: target.value.id,
            safetyBackup: safetyBackup.value
          },
      needsTyped.value ? { confirmProduction: true } : undefined
    )
    notify.info(`Restaurando ${chosen.value.length} base(s) de datos en «${target.value.name}»…`)
    open.value = false
    emit('started', run)
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    starting.value = false
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="760" :persistent="starting" scrollable>
    <v-card
      data-test="rollback-dialog"
      class="rollback-dialog"
      :class="{ 'nd-danger-card': needsTyped }"
    >
      <DialogHeader
        icon="mdi-backup-restore"
        :title="`${isFiles ? 'Restaurar paquete' : 'Restaurar todo'} en ${target?.name ?? 'Local'}`"
        :subtitle="subtitle"
        :danger="needsTyped"
      >
        <span v-if="target" class="nd-pill" :class="environmentPillClass(target.environment)">{{
          environmentLabel(target.environment)
        }}</span>
      </DialogHeader>
      <v-card-text class="rollback-dialog__body">
        <p class="rollback-dialog__intro">
          Cada base de datos marcada se <strong>reemplaza</strong>: se borra en el destino y se crea
          de nuevo con todos los objetos y datos de la copia, para que quede igual que en el momento
          del backup.
        </p>
        <v-select
          :model-value="targetId"
          :items="connectionItems"
          label="Conexión de destino"
          prepend-inner-icon="mdi-server-network"
          :disabled="starting"
          no-data-text="No hay conexiones"
          data-test="rollback-target"
          @update:model-value="onTargetChange"
        >
          <template #item="{ props: itemProps, item }">
            <v-list-item v-bind="itemProps">
              <template #append>
                <span class="nd-pill" :class="item.raw.pill">{{ item.raw.subtitle }}</span>
              </template>
            </v-list-item>
          </template>
        </v-select>

        <div class="nd-section-title rollback-dialog__title">
          {{ isFiles ? 'Bases de datos de las copias' : 'Bases de datos de la ejecución' }}
          <span v-if="items.length" class="nd-pill">{{ chosen.length }}/{{ items.length }}</span>
        </div>
        <div
          v-if="loading && !plan"
          class="nd-progress rollback-dialog__loading"
          role="progressbar"
          aria-label="Cargando copias"
        >
          <span />
        </div>
        <ul v-if="items.length" class="rollback-list" data-test="rollback-items">
          <li
            v-for="item in items"
            :key="item.taskId"
            class="rollback-item"
            :class="{ 'rollback-item--off': !selected.includes(item.taskId) || !!item.problem }"
            :data-test="`rollback-item-${item.taskId}`"
          >
            <v-checkbox-btn
              :model-value="selected.includes(item.taskId)"
              :disabled="!!item.problem || starting"
              density="compact"
              :aria-label="`Restaurar ${item.schema}`"
              data-test="rollback-item-check"
              @update:model-value="toggle(item, $event)"
            />
            <div class="rollback-item__main">
              <div class="rollback-item__route nd-mono">
                <span class="rollback-item__schema" :title="item.backupPath">{{
                  item.schema || '?'
                }}</span>
                <span class="rollback-item__from">({{ item.sourceConnectionName }})</span>
                <v-icon icon="mdi-arrow-right" size="14" class="rollback-item__arrow" />
                <span class="rollback-item__schema">{{ item.targetSchema || '?' }}</span>
                <span v-if="target" class="rollback-item__from">({{ target.name }})</span>
              </div>
              <div v-if="item.problem" class="rollback-item__problem" data-test="rollback-problem">
                {{ item.problem }}
              </div>
              <template v-else>
                <div class="rollback-item__meta nd-ellipsis" :title="item.backupPath">
                  <span
                    v-if="contentText(item)"
                    class="rollback-item__content"
                    data-test="rollback-item-content"
                    >{{ contentText(item) }}</span
                  >
                  <span v-if="contentText(item)" class="rollback-item__dot">·</span>
                  {{ item.backupPath.split('/').pop() }}
                </div>
                <div
                  v-if="item.warning"
                  class="rollback-item__warning"
                  data-test="rollback-item-warning"
                >
                  <v-icon icon="mdi-alert-outline" size="13" />
                  {{ item.warning }}
                </div>
              </template>
            </div>
            <span class="rollback-item__size nd-mono">{{ formatBytes(item.sizeBytes) }}</span>
            <span
              v-if="!item.problem"
              class="nd-pill rollback-item__state"
              :class="stateOf(item).pill"
              data-test="rollback-item-state"
              >{{ stateOf(item).label }}</span
            >
          </li>
        </ul>
        <v-alert
          v-if="plan?.targetError"
          type="warning"
          variant="tonal"
          density="compact"
          class="mt-2"
          >{{ plan.targetError }}. No se puede saber qué bases de datos existen; las que existan se
          reemplazarán.</v-alert
        >
        <v-alert
          v-if="duplicated"
          type="warning"
          variant="tonal"
          density="compact"
          class="mt-2"
          data-test="rollback-duplicated"
          >Hay más de una copia de «{{ duplicated }}» marcada; deja solo una.</v-alert
        >

        <v-checkbox
          v-model="safetyBackup"
          :label="`Copia de seguridad previa de ${target?.name ?? 'Local'}`"
          :hint="
            target
              ? `Antes de reemplazar cada base de datos existente se guarda una copia en ${target.backupDir || 'la carpeta de backups de la conexión'} (etiqueta «previo-rollback»). Si la copia falla, esa base de datos no se toca. Para deshacer: ${UNDO_REPLACE_HOW}.`
              : undefined
          "
          persistent-hint
          density="compact"
          :disabled="starting"
          class="mt-3"
          data-test="rollback-safety"
        />
        <v-alert
          v-if="!safetyBackup && replacedCount"
          type="warning"
          variant="tonal"
          density="compact"
          class="mt-2"
          data-test="rollback-no-safety"
        >
          Sin copia previa, los datos actuales de {{ replacedCount }} base(s) de datos se perderán.
        </v-alert>
        <v-alert
          v-if="needsTyped"
          type="error"
          icon="mdi-shield-alert-outline"
          class="mt-3"
          data-test="rollback-production-warning"
        >
          {{ typedWarning }}
        </v-alert>
        <v-alert
          v-if="error"
          type="error"
          variant="tonal"
          density="compact"
          class="mt-3"
          data-test="rollback-error"
          >{{ error }}</v-alert
        >
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn :disabled="starting" data-test="rollback-cancel" @click="open = false"
          >Cancelar</v-btn
        >
        <v-btn
          :color="needsTyped ? 'error' : 'primary'"
          variant="flat"
          :prepend-icon="needsTyped ? 'mdi-shield-alert-outline' : 'mdi-backup-restore'"
          :disabled="!canStart"
          :loading="starting"
          data-test="rollback-submit"
          @click="start"
        >
          Restaurar {{ chosen.length || '' }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.rollback-dialog__body {
  padding-top: 4px !important;
}
.rollback-dialog__intro {
  margin: 0 0 14px;
  color: var(--nd-text-2);
  font-size: var(--nd-fs-dense);
  line-height: 1.5;
}
.rollback-dialog__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0 6px;
}
.rollback-dialog__loading > span {
  width: 35%;
}
.rollback-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-card);
  overflow: hidden;
}
.rollback-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px 6px 4px;
  background: var(--nd-bg-raised);
}
.rollback-item + .rollback-item {
  border-top: 1px solid var(--nd-hairline);
}
/* Vuetify selection controls grow by default: keep the checkbox at its own width. */
.rollback-item :deep(.v-selection-control) {
  flex: none;
}
.rollback-item--off .rollback-item__main {
  opacity: 0.6;
}
.rollback-item__main {
  flex: 1;
  min-width: 0;
}
.rollback-item__route {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.rollback-item__schema {
  font-weight: 600;
  color: var(--nd-text);
}
.rollback-item__from {
  color: var(--nd-text-2);
  font-size: var(--nd-fs-xs);
}
.rollback-item__arrow {
  color: var(--nd-accent);
}
.rollback-item__meta {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.rollback-item__content {
  color: var(--nd-text-2);
}
.rollback-item__dot {
  margin: 0 4px;
}
.rollback-item__warning {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-warning);
}
.rollback-item__problem {
  font-size: var(--nd-fs-xs);
  color: var(--nd-error);
}
.rollback-item__size {
  flex: none;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.rollback-item__state {
  flex: none;
}
</style>
