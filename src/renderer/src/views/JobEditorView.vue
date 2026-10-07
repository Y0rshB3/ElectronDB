<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { JobInput } from '@shared/types'
import { api } from '@renderer/api'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useJobsStore } from '@renderer/stores/jobs'
import { useTabsStore, type WorkspaceTab } from '@renderer/stores/tabs'
import EmptyState from '@renderer/components/common/EmptyState.vue'
import JobTasksEditor from '@renderer/components/automation/JobTasksEditor.vue'
import RunHistory from '@renderer/components/automation/RunHistory.vue'
import ScheduleBuilder from '@renderer/components/automation/ScheduleBuilder.vue'
import {
  buildJobInput,
  draftFromJob,
  emptyDraft,
  validateDraft,
  type JobDraft
} from '@renderer/components/automation/jobForm'
import {
  guardedRiskSignature,
  useJobProductionGuard
} from '@renderer/components/automation/jobGuard'
import { isMac } from '@renderer/utils/platform'

const props = defineProps<{ tab: WorkspaceTab }>()

const jobs = useJobsStore()
const tabs = useTabsStore()
const connections = useConnectionsStore()
const notify = useNotify()
const guard = useJobProductionGuard()

const initialJobId = typeof props.tab.payload?.jobId === 'string' ? props.tab.payload.jobId : null
const jobId = ref<string | null>(initialJobId)
const draft = ref<JobDraft>(emptyDraft())
const snapshot = ref('')
// Starts true so the tab is not flagged dirty before the first snapshot exists.
const loading = ref(true)
const loadError = ref('')
const saving = ref(false)
// launchd agents are macOS-only; elsewhere the in-app scheduler runs every job.
const launchAgentSupported = isMac()
const launchAgentOffMacHint = computed(
  () =>
    `Solo disponible en macOS (launchd). Con la app abierta la programación funciona igual. Para ejecutarla con la app cerrada, crea una tarea en el Programador de tareas de Windows o una línea de cron en Linux que lance la app con --run-job=${jobId.value ?? '<id>'} (guarda primero la tarea para obtener su id).`
)
const runningNow = ref(false)
const errors = ref<string[]>([])

const serialized = computed(() => JSON.stringify(buildJobInput(draft.value)))
const dirty = computed(() => !loading.value && serialized.value !== snapshot.value)
// Risk signature of the last saved state; scheduling changes that touch SQL tasks on guarded
// connections (production, Ajustes › Seguridad) are confirmed only when this changes.
let cleanRisk = ''

function riskOf(input: JobInput): string {
  return guardedRiskSignature(input.tasks, input.schedule, guard.lookup, guard.environments())
}

function markClean(): void {
  snapshot.value = serialized.value
  cleanRisk = riskOf(buildJobInput(draft.value))
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    if (!connections.loaded) await connections.load().catch(() => undefined)
    if (!jobId.value) {
      draft.value = emptyDraft()
      return
    }
    const job = jobs.get(jobId.value) ?? (await api.jobs.get(jobId.value))
    if (!job) {
      loadError.value = 'La tarea ya no existe. Puede que se haya eliminado desde otra pestaña.'
      return
    }
    draft.value = draftFromJob(job)
  } catch (err) {
    loadError.value = errorMessage(err)
  } finally {
    loading.value = false
    markClean()
  }
}

async function save(): Promise<boolean> {
  errors.value = validateDraft(draft.value, (id) => connections.get(id), guard.environments())
  if (errors.value.length) return false
  const input = buildJobInput(draft.value)
  const risk = riskOf(input)
  // Main re-checks this rule; the flag tells it the user just confirmed.
  let confirmed = false
  if (input.schedule.enabled && risk && risk !== cleanRisk) {
    if (!(await guard.confirm(input.name, input.tasks, 'schedule'))) return false
    confirmed = true
  }
  saving.value = true
  try {
    const saved = await jobs.save(input, confirmed ? { confirmProduction: true } : undefined)
    const wasNew = !jobId.value
    jobId.value = saved.id
    if (wasNew) rememberJobId(saved.id)
    draft.value = draftFromJob(saved)
    markClean()
    tabs.setTitle(props.tab.id, `${saved.name} (Automatización)`)
    notify.success(`Tarea «${saved.name}» guardada`)
    return true
  } catch (err) {
    // Validation errors from the main process are actionable Spanish messages.
    errors.value = [errorMessage(err)]
    return false
  } finally {
    saving.value = false
  }
}

/** Stores the new job id in the tab so AutomationView reuses this tab instead of opening another editor. */
function rememberJobId(id: string): void {
  const stored = tabs.tabs.find((t) => t.id === props.tab.id)
  if (stored) stored.payload = { ...stored.payload, jobId: id }
}

async function runNow(): Promise<void> {
  if (dirty.value || !jobId.value) {
    if (!(await save())) return
  }
  if (!jobId.value) return
  if (!(await guard.confirm(draft.value.name, draft.value.tasks, 'run'))) return
  runningNow.value = true
  try {
    await jobs.run(jobId.value, { confirmProduction: true })
    notify.info(`Ejecutando «${draft.value.name}»…`)
  } catch {
    // Reported by invoke().
  } finally {
    runningNow.value = false
  }
}

watch(dirty, (value) => tabs.setDirty(props.tab.id, value), { immediate: true })
onMounted(load)
</script>

<template>
  <div class="job-editor d-flex flex-column" data-test="job-editor">
    <v-toolbar
      density="compact"
      class="nd-viewbar"
      role="toolbar"
      aria-label="Acciones de la tarea"
    >
      <v-btn
        size="small"
        prepend-icon="mdi-content-save-outline"
        color="primary"
        variant="flat"
        :loading="saving"
        :disabled="loading || !!loadError"
        data-test="job-save"
        @click="save"
      >
        Guardar
      </v-btn>
      <v-btn
        size="small"
        prepend-icon="mdi-play"
        class="job-editor__run"
        :loading="runningNow"
        :disabled="loading || !!loadError || !draft.tasks.length"
        data-test="job-run"
        @click="runNow"
      >
        Ejecutar ahora
      </v-btn>
      <span v-if="dirty || draft.source" class="nd-viewbar__sep" aria-hidden="true" />
      <span v-if="dirty" class="nd-pill nd-pill--staging job-editor__pill">
        <span class="job-editor__dirty-dot" aria-hidden="true" />Cambios sin guardar
      </span>
      <span v-if="draft.source" class="nd-pill job-editor__pill">
        <v-icon icon="mdi-import" size="12" aria-hidden="true" />Importada de Navicat
      </span>
    </v-toolbar>
    <div
      v-if="loading"
      class="nd-progress job-editor__loading"
      role="progressbar"
      aria-label="Cargando tarea"
    >
      <span />
    </div>
    <EmptyState
      v-if="loadError"
      icon="mdi-alert-circle-outline"
      title="No se pudo cargar la tarea"
      :description="loadError"
    />
    <div v-else class="job-editor__body d-flex">
      <div class="job-editor__form">
        <div class="job-editor__inner">
          <v-alert v-if="errors.length" type="error" class="mb-3" data-test="job-errors">
            <div v-for="e in errors" :key="e">{{ e }}</div>
          </v-alert>

          <section class="je-card" aria-label="General">
            <header class="je-card__head">
              <span class="je-card__icon" aria-hidden="true"
                ><v-icon icon="mdi-robot-outline" size="16"
              /></span>
              <h3 class="je-card__title">General</h3>
            </header>
            <div class="je-general">
              <v-text-field
                v-model="draft.name"
                label="Nombre de la tarea"
                class="je-general__name"
                data-test="job-name"
              />
              <v-checkbox
                v-model="draft.continueOnError"
                label="Continuar en caso de error"
                density="compact"
                hide-details
                class="je-general__check"
              />
            </div>
          </section>

          <section class="je-card" aria-label="Pasos">
            <header class="je-card__head">
              <span class="je-card__icon" aria-hidden="true"
                ><v-icon icon="mdi-format-list-numbered" size="16"
              /></span>
              <h3 class="je-card__title">Pasos</h3>
              <span class="nd-pill">{{ draft.tasks.length }}</span>
            </header>
            <JobTasksEditor v-model="draft.tasks" />
          </section>

          <section class="je-card" aria-label="Programación">
            <header class="je-card__head">
              <span class="je-card__icon" aria-hidden="true"
                ><v-icon icon="mdi-calendar-clock" size="16"
              /></span>
              <h3 class="je-card__title">Programación</h3>
              <v-spacer />
              <v-switch
                v-model="draft.scheduleEnabled"
                label="Programación activada"
                color="primary"
                density="compact"
                hide-details
                class="je-card__switch"
                data-test="job-schedule-enabled"
              />
            </header>
            <ScheduleBuilder v-model="draft.schedule" :disabled="!draft.scheduleEnabled" />
            <div class="je-launchd" data-test="job-launch-agent">
              <v-switch
                v-if="launchAgentSupported"
                v-model="draft.launchAgent"
                :disabled="!draft.scheduleEnabled"
                label="Ejecutar aunque la app esté cerrada"
                hint="Instala un agente de launchd en ~/Library/LaunchAgents que lanza la tarea aunque Vortaq no esté abierto."
                persistent-hint
                color="primary"
                density="compact"
              />
              <v-tooltip v-else location="top" max-width="380" :text="launchAgentOffMacHint">
                <template #activator="{ props: tooltipProps }">
                  <div v-bind="tooltipProps" data-test="job-launch-agent-unsupported">
                    <v-switch
                      :model-value="false"
                      disabled
                      label="Ejecutar aunque la app esté cerrada"
                      hint="Solo en macOS. En Windows/Linux usa el Programador de tareas o cron con --run-job (pasa el ratón para ver cómo)."
                      persistent-hint
                      color="primary"
                      density="compact"
                    />
                  </div>
                </template>
              </v-tooltip>
            </div>
          </section>
        </div>
      </div>
      <div v-if="jobId" class="job-editor__history">
        <RunHistory :job-id="jobId" :job-name="draft.name" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.job-editor {
  height: 100%;
  min-height: 0;
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
.nd-viewbar__sep {
  flex: none;
  width: 1px;
  height: 20px;
  margin: 0 6px;
  background: var(--nd-border-strong);
}
.job-editor__run:not(.v-btn--disabled) :deep(.v-btn__prepend) {
  color: var(--nd-success);
}
.job-editor__pill {
  height: 22px;
  padding: 0 9px;
  margin-left: 4px;
}
.job-editor__dirty-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
}
.job-editor__loading {
  flex: none;
}
.job-editor__loading > span {
  width: 35%;
  animation: je-indeterminate 1.2s var(--nd-ease) infinite;
}
@keyframes je-indeterminate {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(300%);
  }
}
.job-editor__body {
  flex: 1;
  min-height: 0;
}
.job-editor__form {
  flex: 1;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
}
.job-editor__inner {
  max-width: 960px;
  padding: 16px 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.je-card {
  min-width: 0;
  padding: 14px 16px 16px;
  border-radius: var(--nd-radius-card);
  background: var(--nd-glass);
  -webkit-backdrop-filter: var(--nd-glass-blur);
  backdrop-filter: var(--nd-glass-blur);
  border: 1px solid var(--nd-border);
  box-shadow: var(--nd-shadow-inset);
}
.je-card__head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 30px;
  margin-bottom: 12px;
}
.je-card__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--nd-radius-control);
  color: var(--nd-accent);
  background: var(--nd-accent-gradient-soft);
  border: 1px solid rgba(var(--nd-accent-rgb), 0.2);
}
.je-card__title {
  margin: 0;
  font-size: var(--nd-fs-base);
  font-weight: var(--nd-fw-heading);
}
.je-card__switch {
  flex: none;
}
.je-general {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
}
.je-general__name {
  flex: 1 1 280px;
}
.je-general__check {
  flex: none;
}
.je-launchd {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--nd-hairline);
}
.job-editor__history {
  width: 340px;
  flex: 0 0 340px;
  overflow: hidden;
  border-left: 1px solid var(--nd-border);
  background: var(--nd-bg-panel);
}
</style>
