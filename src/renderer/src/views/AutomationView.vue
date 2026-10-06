<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { Job, JobRun } from '@shared/types'
import { api } from '@renderer/api'
import { useNotify } from '@renderer/composables/useNotify'
import { useWorkspace } from '@renderer/composables/useWorkspace'
import { useJobsStore } from '@renderer/stores/jobs'
import { useTabsStore, type WorkspaceTab } from '@renderer/stores/tabs'
import { useUiStore } from '@renderer/stores/ui'
import { formatDate } from '@renderer/utils/format'
import EmptyState from '@renderer/components/common/EmptyState.vue'
import RunHistory from '@renderer/components/automation/RunHistory.vue'
import RunLogPanel from '@renderer/components/automation/RunLogPanel.vue'
import StatusPill from '@renderer/components/automation/StatusPill.vue'
import { scheduleParts } from '@renderer/components/automation/schedule'
import { useJobProductionGuard } from '@renderer/components/automation/jobGuard'

defineProps<{ tab: WorkspaceTab }>()

type ScheduleStatus = { inApp: boolean; launchAgent: boolean; nextRun: string | null }

const jobs = useJobsStore()
const ui = useUiStore()
const ws = useWorkspace()
const notify = useNotify()
const tabs = useTabsStore()
const guard = useJobProductionGuard()

const selectedId = ref<string | null>(null)
const statuses = ref<Record<string, ScheduleStatus>>({})
const running = ref<Record<string, boolean>>({})

const selected = computed<Job | null>(() =>
  selectedId.value ? (jobs.get(selectedId.value) ?? null) : null
)
/** Run shown in the log panel (auto-selected by «Ejecutar ahora»). */
const logRunId = ref<string | null>(null)
const logRun = computed<JobRun | null>(() =>
  logRunId.value ? (jobs.runs.find((r) => r.id === logRunId.value) ?? null) : null
)

function openLog(run: JobRun): void {
  logRunId.value = run.id
}

// Name takes the remaining width (truncated with a tooltip); every other column is
// fixed and never wraps. Dates use a short form here, the full one is in the tooltip.
const headers = [
  { title: 'Nombre', key: 'name', minWidth: '160px', cellProps: { class: 'jobs-grid__name' } },
  { title: 'Tareas', key: 'tasks', align: 'end' as const, width: 64, sortable: false },
  {
    title: 'Programación',
    key: 'schedule',
    width: 200,
    sortable: false,
    cellProps: { class: 'jobs-grid__schedule' }
  },
  { title: 'Próxima ejecución', key: 'nextRun', width: 128, sortable: false, nowrap: true },
  { title: 'Última ejecución', key: 'lastRunAt', width: 128, nowrap: true },
  { title: 'Estado', key: 'status', width: 112, sortable: false, nowrap: true }
]

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

/** Compact date for the grid: «6 oct 03:00» this year, «2025-10-06» otherwise. */
function shortDate(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (date.getFullYear() !== new Date().getFullYear())
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function nextRunOf(job: Job): string | null {
  return job.schedule.enabled ? (statuses.value[job.id]?.nextRun ?? null) : null
}

async function loadStatuses(): Promise<void> {
  const entries = await Promise.all(
    jobs.jobs.map(
      async (job) => [job.id, await api.jobs.scheduleStatus(job.id).catch(() => null)] as const
    )
  )
  const next: Record<string, ScheduleStatus> = {}
  for (const [id, status] of entries) if (status) next[id] = status
  statuses.value = next
}

async function reload(): Promise<void> {
  try {
    await jobs.load()
  } catch {
    return
  }
  await loadStatuses()
}

function onRowClick(_e: unknown, row: { item: Job }): void {
  if (selectedId.value === row.item.id) return
  selectedId.value = row.item.id
  // Follow the selection: show the active run of that job, if any.
  const active = jobs.runningByJob.get(row.item.id)
  logRunId.value = active?.id ?? null
}

/** Reuses an editor tab already showing this job (including one that created it). */
function openEditor(job: Job): void {
  const existing = tabs.tabs.find((t) => t.kind === 'jobEditor' && t.payload?.jobId === job.id)
  if (existing) tabs.activate(existing.id)
  else ws.openJobEditor(job.id, job.name)
}

function onRowDblClick(_e: unknown, row: { item: Job }): void {
  openEditor(row.item)
}

function edit(): void {
  if (selected.value) openEditor(selected.value)
}

async function remove(): Promise<void> {
  const job = selected.value
  if (!job) return
  const ok = await ui.ask({
    title: 'Eliminar tarea de automatización',
    message: `Se eliminará «${job.name}» y su programación (incluido el agente de launchd si existe). Las copias ya creadas no se borran.`,
    confirmText: 'Eliminar',
    color: 'error'
  })
  if (!ok) return
  try {
    await jobs.remove(job.id)
    selectedId.value = null
    notify.success(`Tarea «${job.name}» eliminada`)
  } catch {
    // Reported by invoke().
  }
}

async function runNow(): Promise<void> {
  const job = selected.value
  if (!job) return
  if (!(await guard.confirm(job.name, job.tasks, 'run'))) return
  running.value = { ...running.value, [job.id]: true }
  try {
    const run = await jobs.run(job.id, { confirmProduction: true })
    // Navicat behaviour: the log opens and fills in while the run progresses (it replaces
    // the old «Ejecutando…» toast, which covered the end of the log).
    logRunId.value = run.id
  } catch {
    // Reported by invoke().
  } finally {
    running.value = { ...running.value, [job.id]: false }
  }
}

// Live run updates arrive through the global event:jobRun listener (useAppBootstrap).
onMounted(reload)

// Refresh next-run info when jobs are saved elsewhere (editor tabs).
watch(
  () => jobs.jobs.map((j) => `${j.id}:${j.updatedAt}:${j.lastRunAt}`).join('|'),
  () => void loadStatuses()
)
</script>

<template>
  <div class="automation-view d-flex flex-column" data-test="automation-view">
    <v-toolbar
      density="compact"
      class="nd-viewbar"
      role="toolbar"
      aria-label="Acciones de automatización"
    >
      <v-btn
        size="small"
        prepend-icon="mdi-plus"
        color="primary"
        variant="flat"
        data-test="jobs-new"
        @click="ws.openJobEditor(null)"
        >Nuevo</v-btn
      >
      <span class="nd-viewbar__sep" aria-hidden="true" />
      <v-btn
        size="small"
        prepend-icon="mdi-pencil-outline"
        :disabled="!selected"
        data-test="jobs-edit"
        @click="edit"
        >Editar</v-btn
      >
      <v-btn
        size="small"
        prepend-icon="mdi-play"
        class="automation-view__run"
        :disabled="!selected || jobs.runningByJob.has(selected.id)"
        :loading="selected ? running[selected.id] : false"
        data-test="jobs-run"
        @click="runNow"
      >
        Ejecutar ahora
      </v-btn>
      <v-btn
        size="small"
        prepend-icon="mdi-delete-outline"
        class="automation-view__delete"
        :disabled="!selected"
        data-test="jobs-delete"
        @click="remove"
        >Eliminar</v-btn
      >
      <span class="nd-viewbar__sep" aria-hidden="true" />
      <v-btn size="small" prepend-icon="mdi-import" @click="ui.importDialog = true"
        >Importar de Navicat</v-btn
      >
      <v-spacer />
      <v-btn
        icon="mdi-refresh"
        size="small"
        variant="text"
        :loading="jobs.loading"
        aria-label="Actualizar"
        title="Actualizar"
        @click="reload"
      />
    </v-toolbar>
    <div
      class="automation-view__body"
      :class="{ 'automation-view__body--log': !!logRun }"
      data-test="automation-body"
    >
      <div class="automation-view__jobs">
        <EmptyState
          v-if="jobs.loaded && !jobs.jobs.length"
          icon="mdi-robot-outline"
          title="No hay tareas de automatización"
          description="Crea una tarea para hacer copias de seguridad programadas o importa las de Navicat."
        >
          <div class="d-flex ga-2 justify-center">
            <v-btn
              color="primary"
              variant="flat"
              prepend-icon="mdi-plus"
              @click="ws.openJobEditor(null)"
              >Nueva tarea</v-btn
            >
            <v-btn variant="tonal" prepend-icon="mdi-import" @click="ui.importDialog = true"
              >Importar de Navicat</v-btn
            >
          </div>
        </EmptyState>
        <v-data-table
          v-else
          :headers="headers"
          :items="jobs.sorted"
          :loading="jobs.loading"
          item-value="id"
          density="compact"
          :items-per-page="-1"
          hide-default-footer
          hover
          fixed-header
          class="jobs-grid"
          loading-text="Cargando tareas…"
          :row-props="({ item }) => ({ class: item.id === selectedId ? 'bg-surface-variant' : '' })"
          @click:row="onRowClick"
          @dblclick:row="onRowDblClick"
        >
          <template #[`item.name`]="{ item }">
            <div class="jobs-grid__name-inner">
              <v-icon
                :icon="item.schedule.enabled ? 'mdi-robot-outline' : 'mdi-robot-off-outline'"
                size="16"
                class="jobs-grid__icon"
                aria-hidden="true"
              />
              <span class="nd-ellipsis" :title="item.name">{{ item.name }}</span>
              <span
                v-if="item.source"
                class="nd-pill jobs-grid__navicat"
                title="Importada de Navicat"
                >Navicat</span
              >
            </div>
          </template>
          <template #[`item.tasks`]="{ item }">
            <span class="nd-num">{{ item.tasks.length }}</span>
          </template>
          <template #[`item.schedule`]="{ item }">
            <div
              class="jobs-grid__schedule-inner"
              :class="{ 'jobs-grid__schedule-inner--off': !item.schedule.enabled }"
              :title="item.schedule.enabled ? item.schedule.cron : undefined"
            >
              <span v-if="!item.schedule.enabled" class="nd-ellipsis">Sin programar</span>
              <span v-else class="nd-ellipsis"
                >{{ scheduleParts(item.schedule.cron).label
                }}<code v-if="scheduleParts(item.schedule.cron).cron" class="jobs-grid__cron">{{
                  scheduleParts(item.schedule.cron).cron
                }}</code></span
              >
              <span
                v-if="item.schedule.enabled && item.schedule.launchAgent"
                class="nd-pill nd-pill--info jobs-grid__launchd"
                title="Se ejecuta aunque la app esté cerrada (launchd)"
                >launchd</span
              >
            </div>
          </template>
          <template #[`item.nextRun`]="{ item }">
            <span
              v-if="nextRunOf(item)"
              class="nd-mono jobs-grid__date"
              :title="formatDate(nextRunOf(item))"
              >{{ shortDate(nextRunOf(item)) }}</span
            >
            <span v-else class="nd-muted">—</span>
          </template>
          <template #[`item.lastRunAt`]="{ item }">
            <span
              v-if="item.lastRunAt"
              class="nd-mono jobs-grid__date"
              :title="formatDate(item.lastRunAt)"
              >{{ shortDate(item.lastRunAt) }}</span
            >
            <span v-else class="nd-muted">Nunca</span>
          </template>
          <template #[`item.status`]="{ item }">
            <StatusPill v-if="jobs.lastRunOf(item.id)" :status="jobs.lastRunOf(item.id)!.status" />
            <span v-else class="nd-muted">—</span>
          </template>
        </v-data-table>
      </div>
      <div v-if="logRun" class="automation-view__log">
        <RunLogPanel :run="logRun" @close="logRunId = null" />
      </div>
      <div class="automation-view__history">
        <RunHistory
          :job-id="selectedId"
          :job-name="selected?.name"
          :selected-run-id="logRunId"
          inline-log
          @open-log="openLog"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.automation-view {
  height: 100%;
  min-height: 0;
  container-type: inline-size;
  container-name: automation;
}
.nd-viewbar {
  flex: 0 0 auto;
  padding: 0 12px;
  border-bottom: 1px solid var(--nd-border);
  overflow-x: auto;
}
.nd-viewbar :deep(.v-toolbar__content) {
  gap: 2px;
  height: 46px !important;
}
.nd-viewbar :deep(.v-toolbar__content > .v-btn) {
  flex: none;
}
/* Destructive action: neutral until hovered (red only on hover). */
.automation-view__delete.v-btn:not(.v-btn--disabled):hover,
.automation-view__delete.v-btn:not(.v-btn--disabled):focus-visible {
  color: var(--nd-error) !important;
  background: var(--nd-error-soft);
}
.nd-viewbar__sep {
  flex: none;
  width: 1px;
  height: 20px;
  margin: 0 6px;
  background: var(--nd-border-strong);
}
.automation-view__run:not(.v-btn--disabled) :deep(.v-btn__prepend) {
  color: var(--nd-success);
}
/* Grid: jobs over the run log on the left, history on the right. */
.automation-view__body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  grid-template-rows: minmax(0, 1fr);
  grid-template-areas: 'jobs history';
}
.automation-view__body--log {
  grid-template-rows: minmax(140px, 38%) minmax(0, 1fr);
  grid-template-areas:
    'jobs history'
    'log history';
}
.automation-view__jobs {
  grid-area: jobs;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
.automation-view__log {
  grid-area: log;
  min-width: 0;
  min-height: 0;
  border-top: 1px solid var(--nd-border);
}
.jobs-grid {
  height: 100%;
}
.jobs-grid :deep(.jobs-grid__name) {
  max-width: 0;
  width: 100%;
}
.jobs-grid :deep(.jobs-grid__schedule) {
  max-width: 200px;
}
.jobs-grid__name-inner,
.jobs-grid__schedule-inner {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  white-space: nowrap;
}
.jobs-grid__name-inner {
  font-weight: 500;
}
.jobs-grid__icon {
  flex: none;
  color: var(--nd-text-muted);
}
.jobs-grid__navicat,
.jobs-grid__launchd {
  flex: none;
  height: 17px;
  font-size: 10.5px;
}
.jobs-grid__schedule-inner {
  color: var(--nd-text);
}
.jobs-grid__cron {
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
  background: none;
  padding: 0;
}
.jobs-grid__schedule-inner--off {
  color: var(--nd-text-muted);
}
.jobs-grid__date {
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
  white-space: nowrap;
}
.automation-view__history {
  grid-area: history;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-left: 1px solid var(--nd-border);
  background: var(--nd-bg-panel);
}
/* Narrow workspace: jobs on top (full width), log and history side by side below. */
@container automation (max-width: 1180px) {
  .automation-view__body {
    grid-template-columns: minmax(0, 1fr) 360px;
    grid-template-rows: minmax(120px, 45%) minmax(0, 1fr);
    grid-template-areas:
      'jobs jobs'
      'history history';
  }
  .automation-view__body--log {
    grid-template-rows: minmax(120px, 34%) minmax(0, 1fr);
    grid-template-areas:
      'jobs jobs'
      'log history';
  }
  .automation-view__history {
    border-top: 1px solid var(--nd-border);
  }
}
</style>
