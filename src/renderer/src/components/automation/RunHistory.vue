<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { JobRun } from '@shared/types'
import { errorMessage } from '@renderer/composables/useNotify'
import { useJobsStore } from '@renderer/stores/jobs'
import { useProgressStore } from '@renderer/stores/progress'
import { describeProgress } from '@renderer/stores/progressText'
import { formatDate, formatDuration } from '@renderer/utils/format'
import EmptyState from '@renderer/components/common/EmptyState.vue'
import { revealInFinder } from '@renderer/components/backups/reveal'
import { TRIGGER_LABELS } from './runStatus'
import RunLogPanel from './RunLogPanel.vue'
import StatusPill from './StatusPill.vue'

const props = defineProps<{
  jobId: string | null
  jobName?: string
  /** Run whose log is shown by the parent (highlighted). */
  selectedRunId?: string | null
  /** The parent shows logs itself (`openLog`); otherwise a dialog is used. */
  inlineLog?: boolean
}>()
const emit = defineEmits<{ openLog: [run: JobRun] }>()

const jobs = useJobsStore()
const progress = useProgressStore()
const loading = ref(false)
const error = ref('')
const expanded = ref<string | null>(null)
const logOpen = ref(false)
const logRunId = ref<string | null>(null)
const cancelling = ref<Record<string, boolean>>({})

const runs = computed<JobRun[]>(() => (props.jobId ? jobs.runsOf(props.jobId) : []))
const dialogRun = computed(() =>
  logRunId.value ? (jobs.runs.find((r) => r.id === logRunId.value) ?? null) : null
)

async function reload(): Promise<void> {
  if (!props.jobId) return
  loading.value = true
  error.value = ''
  try {
    await jobs.loadRuns(props.jobId)
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}

function duration(run: JobRun): string {
  if (!run.finishedAt) return ''
  return formatDuration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime())
}

function isLive(run: JobRun): boolean {
  return run.status === 'running' || run.status === 'queued'
}

/** "Paso 2/3 · accounts · Tabla user (12/85)" while the run is active. */
function liveText(run: JobRun): string {
  const entry = progress.operations[run.id]
  if (!entry || entry.done) return run.status === 'queued' ? 'En cola…' : 'Iniciando…'
  const view = describeProgress(entry)
  return [view.subtitle, view.message].filter(Boolean).join(' · ')
}

function livePercent(run: JobRun): number | null {
  const entry = progress.operations[run.id]
  return entry && !entry.done ? describeProgress(entry).percent : null
}

function openLog(run: JobRun): void {
  if (props.inlineLog) {
    emit('openLog', run)
    return
  }
  logRunId.value = run.id
  logOpen.value = true
}

async function cancelRun(run: JobRun): Promise<void> {
  cancelling.value = { ...cancelling.value, [run.id]: true }
  try {
    await jobs.cancel(run.id)
  } catch {
    // api.invoke already reported the failure in the snackbar.
  } finally {
    cancelling.value = { ...cancelling.value, [run.id]: false }
  }
}

function toggle(run: JobRun): void {
  expanded.value = expanded.value === run.id ? null : run.id
}

watch(() => props.jobId, reload, { immediate: true })
</script>

<template>
  <section
    class="run-history d-flex flex-column"
    aria-label="Historial de ejecuciones"
    data-test="run-history"
  >
    <header class="run-history__head">
      <v-icon icon="mdi-history" size="16" class="run-history__head-icon" aria-hidden="true" />
      <span class="run-history__title">Historial</span>
      <span v-if="jobName" class="run-history__job nd-ellipsis" :title="jobName">{{
        jobName
      }}</span>
      <v-spacer />
      <v-btn
        icon="mdi-refresh"
        size="small"
        :disabled="!jobId"
        :loading="loading"
        aria-label="Actualizar historial"
        title="Actualizar historial"
        @click="reload"
      />
    </header>
    <v-alert v-if="error" type="error" class="mx-3 mb-2">{{ error }}</v-alert>
    <div class="run-history__list">
      <EmptyState
        v-if="!jobId"
        icon="mdi-history"
        title="Selecciona una tarea"
        description="Elige una tarea para ver sus ejecuciones."
      />
      <EmptyState
        v-else-if="!loading && !runs.length"
        icon="mdi-history"
        title="Sin ejecuciones"
        description="Usa «Ejecutar ahora» o programa la tarea."
      />
      <ol v-else class="timeline">
        <li
          v-for="run in runs"
          :key="run.id"
          class="timeline__item"
          :class="[
            `timeline__item--${run.status}`,
            {
              'timeline__item--open': expanded === run.id,
              'timeline__item--selected': selectedRunId === run.id
            }
          ]"
        >
          <span class="timeline__dot" aria-hidden="true" />
          <div
            class="timeline__card nd-transition"
            role="button"
            tabindex="0"
            :aria-expanded="expanded === run.id"
            @click="toggle(run)"
            @keydown.enter.self.prevent="toggle(run)"
            @keydown.space.self.prevent="toggle(run)"
          >
            <div class="timeline__main">
              <div class="timeline__row">
                <span class="timeline__date nd-mono nd-ellipsis">{{
                  formatDate(run.startedAt)
                }}</span>
                <StatusPill :status="run.status" class="timeline__pill" data-test="run-status" />
              </div>
              <div class="timeline__meta">
                <span>{{ TRIGGER_LABELS[run.trigger] ?? run.trigger }}</span>
                <template v-if="duration(run)">
                  <span class="timeline__sep">·</span>
                  <span class="nd-mono">{{ duration(run) }}</span>
                </template>
                <span class="timeline__sep">·</span>
                <span>{{ run.tasks.length }} paso(s)</span>
              </div>
              <div v-if="isLive(run)" class="timeline__live" data-test="run-live">
                <div class="timeline__live-info">
                  <span class="timeline__live-text nd-ellipsis" :title="liveText(run)">{{
                    liveText(run)
                  }}</span>
                  <span class="timeline__live-track" aria-hidden="true">
                    <span
                      class="timeline__live-bar"
                      :class="{ 'timeline__live-bar--indeterminate': livePercent(run) === null }"
                      :style="
                        livePercent(run) === null ? undefined : { width: `${livePercent(run)}%` }
                      "
                    />
                  </span>
                </div>
                <v-btn
                  size="x-small"
                  color="error"
                  variant="tonal"
                  prepend-icon="mdi-stop-circle-outline"
                  class="timeline__cancel"
                  :loading="cancelling[run.id]"
                  data-test="run-cancel"
                  @click.stop="cancelRun(run)"
                >
                  Cancelar
                </v-btn>
              </div>
            </div>
            <div class="timeline__actions">
              <v-btn
                icon="mdi-text-box-outline"
                size="x-small"
                variant="text"
                :class="{ 'timeline__log--active': selectedRunId === run.id }"
                aria-label="Ver registro"
                title="Ver registro"
                data-test="run-open-log"
                @click.stop="openLog(run)"
              />
              <v-icon
                :icon="expanded === run.id ? 'mdi-chevron-up' : 'mdi-chevron-down'"
                size="16"
                class="timeline__chevron"
                aria-hidden="true"
              />
            </div>
          </div>
          <ul v-if="expanded === run.id" class="timeline__steps" aria-label="Pasos de la ejecución">
            <li v-for="task in run.tasks" :key="task.taskId" class="timeline__step">
              <div class="timeline__step-row">
                <span class="timeline__step-name nd-ellipsis" :title="task.referenceName">{{
                  task.referenceName
                }}</span>
                <StatusPill :status="task.status" />
                <v-btn
                  v-if="task.outputPath"
                  icon="mdi-folder-open-outline"
                  size="x-small"
                  :title="`Mostrar en Finder: ${task.outputPath}`"
                  aria-label="Mostrar en Finder"
                  @click="revealInFinder(task.outputPath)"
                />
              </div>
              <div v-if="task.message" class="timeline__step-message">{{ task.message }}</div>
            </li>
          </ul>
        </li>
      </ol>
    </div>

    <v-dialog v-model="logOpen" max-width="980" scrollable>
      <v-card class="run-log-card">
        <div class="run-log-card__panel">
          <RunLogPanel :run="dialogRun" @close="logOpen = false" />
        </div>
      </v-card>
    </v-dialog>
  </section>
</template>

<style scoped>
.run-history {
  height: 100%;
  min-height: 0;
}
.run-history__head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 52px;
  padding: 0 10px 0 16px;
  border-bottom: 1px solid var(--nd-border);
}
.run-history__head-icon {
  color: var(--nd-text-muted);
}
.run-history__title {
  font-weight: var(--nd-fw-heading);
}
.run-history__job {
  color: var(--nd-text-2);
  font-size: var(--nd-fs-dense);
}
.run-history__list {
  flex: 1;
  overflow: auto;
}

/* Timeline: a hairline rail with one glowing status dot per run. */
.timeline {
  list-style: none;
  margin: 0;
  padding: 12px 12px 16px 14px;
  position: relative;
}
.timeline__item {
  position: relative;
  padding-left: 22px;
  --tone: var(--nd-text-2);
}
.timeline__item + .timeline__item {
  margin-top: 6px;
}
.timeline__item::before {
  content: '';
  position: absolute;
  left: 3.5px;
  top: 0;
  bottom: -6px;
  width: 1px;
  background: linear-gradient(
    180deg,
    rgba(var(--nd-accent-rgb), 0.35),
    rgba(var(--nd-violet-rgb), 0.25)
  );
}
.timeline__item:first-child::before {
  top: 16px;
}
.timeline__item:last-child::before {
  bottom: calc(100% - 16px);
}
.timeline__item--success {
  --tone: var(--nd-success);
}
.timeline__item--failed {
  --tone: var(--nd-error);
}
.timeline__item--cancelled {
  --tone: var(--nd-warning);
}
.timeline__item--running {
  --tone: var(--nd-info);
}
.timeline__dot {
  position: absolute;
  left: 0;
  top: 13px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--tone);
  box-shadow:
    0 0 0 3px var(--nd-bg-panel),
    0 0 8px var(--tone);
}
.timeline__card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 6px 6px 10px;
  border-radius: var(--nd-radius-control);
  border: 1px solid transparent;
  cursor: pointer;
}
.timeline__card:hover {
  background: var(--nd-hover);
}
.timeline__item--open > .timeline__card {
  background: var(--nd-selected);
  border-color: rgba(var(--nd-accent-rgb), 0.18);
}
.timeline__main {
  flex: 1 1 auto;
  min-width: 0;
}
.timeline__actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
}
.timeline__row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 24px;
}
.timeline__date {
  flex: 0 1 auto;
  min-width: 0;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text);
  white-space: nowrap;
}
.timeline__pill {
  flex: none;
}
/* Live progress of an active run, with its own Cancelar button (never over the status pill). */
.timeline__live {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  min-width: 0;
}
.timeline__live-info {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.timeline__live-text {
  font-size: var(--nd-fs-xs);
  color: var(--nd-info);
}
.timeline__live-track {
  position: relative;
  display: block;
  height: 3px;
  overflow: hidden;
  border-radius: var(--nd-radius-pill);
  background: var(--nd-hairline);
}
.timeline__live-bar {
  position: absolute;
  inset: 0 auto 0 0;
  width: 0;
  border-radius: inherit;
  background: var(--nd-accent-gradient-h);
  transition: width var(--nd-dur-fast, 0.15s) var(--nd-ease);
}
.timeline__live-bar--indeterminate {
  width: 35%;
  animation: timeline-live 1.2s var(--nd-ease) infinite;
}
@keyframes timeline-live {
  from {
    left: -35%;
  }
  to {
    left: 100%;
  }
}
.timeline__cancel {
  flex: none;
}
.timeline__item--selected > .timeline__card {
  border-color: rgba(var(--nd-accent-rgb), 0.35);
}
.timeline__log--active {
  color: var(--nd-accent) !important;
  background: var(--nd-selected);
}
.timeline__meta {
  display: flex;
  overflow: hidden;
  white-space: nowrap;
  align-items: center;
  gap: 5px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.timeline__sep {
  color: var(--nd-text-muted);
}
.timeline__chevron {
  margin: 0 4px 0 2px;
  color: var(--nd-text-muted);
}
.timeline__steps {
  list-style: none;
  margin: 6px 0 4px 10px;
  padding: 0;
  border-left: 1px dashed var(--nd-border-strong);
}
.timeline__step {
  padding: 4px 6px 4px 12px;
}
.timeline__step-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
}
.timeline__step-name {
  flex: 1;
  font-size: var(--nd-fs-dense);
}
.timeline__step-message {
  margin-top: 2px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  word-break: break-word;
}

/* Log viewer dialog (when the parent does not show the log inline). */
.run-log-card__panel {
  height: min(70vh, 640px);
}
</style>
