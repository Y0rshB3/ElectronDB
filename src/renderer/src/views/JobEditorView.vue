<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { engineOf } from '@shared/engines'
import type { JobInput, JobRun, JobTask } from '@shared/types'
import { api } from '@renderer/api'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useJobsStore } from '@renderer/stores/jobs'
import { useSettingsStore } from '@renderer/stores/settings'
import { useTabsStore, type WorkspaceTab } from '@renderer/stores/tabs'
import { ENVIRONMENT_LABELS } from '@renderer/utils/objectTypes'
import { formatDate } from '@renderer/utils/format'
import EmptyState from '@renderer/components/common/EmptyState.vue'
import CopyRestoreDialog from '@renderer/components/automation/CopyRestoreDialog.vue'
import JobStepBrowser from '@renderer/components/automation/JobStepBrowser.vue'
import JobStepList from '@renderer/components/automation/JobStepList.vue'
import JobStepSettings from '@renderer/components/automation/JobStepSettings.vue'
import RunHistory from '@renderer/components/automation/RunHistory.vue'
import RunLogPanel from '@renderer/components/automation/RunLogPanel.vue'
import ScheduleBuilder from '@renderer/components/automation/ScheduleBuilder.vue'
import StatusPill from '@renderer/components/automation/StatusPill.vue'
import {
  backupPasswordProblem,
  buildJobInput,
  draftFromJob,
  emptyDraft,
  encryptsBackups,
  problemsByTask,
  validateDraft,
  type JobDraft
} from '@renderer/components/automation/jobForm'
import {
  guardedRiskSignature,
  useJobProductionGuard
} from '@renderer/components/automation/jobGuard'
import {
  cronFromForm,
  describeSchedule,
  isValidCron
} from '@renderer/components/automation/schedule'
import { isMac } from '@renderer/utils/platform'

/**
 * Job editor: a header with the name, summary pills and actions; then four
 * sections. «Pasos» holds the step sequence, the «Añadir pasos» browser and
 * the settings panel of the selected step (docs/job-editor-design.md).
 */
const props = defineProps<{ tab: WorkspaceTab }>()

const jobs = useJobsStore()
const tabs = useTabsStore()
const connections = useConnectionsStore()
const settings = useSettingsStore()
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
/** A save was attempted: step problems are shown as errors. */
const strict = ref(false)

type Section = 'steps' | 'schedule' | 'options' | 'history'
const section = ref<Section>('steps')
const selectedStep = ref<string | null>(null)
/** «Añadir pasos» folded to its header, to give the sequence the whole height. */
const browserCollapsed = ref(false)
const passwordInput = ref<{ focus: () => void } | null>(null)

/** Connection names for the default names of unnamed steps («Copia de ventas (Staging)»). */
const stepNameOf = (id: string): string => connections.get(id)?.name ?? ''
const serialized = computed(() => JSON.stringify(buildJobInput(draft.value, stepNameOf)))
const dirty = computed(() => !loading.value && serialized.value !== snapshot.value)
// Risk signature of the last saved state; scheduling changes that touch SQL tasks on guarded
// connections (production, Ajustes › Seguridad) are confirmed only when this changes.
let cleanRisk = ''

function riskOf(input: JobInput): string {
  return guardedRiskSignature(input.tasks, input.schedule, guard.lookup, guard.environments())
}

function markClean(): void {
  snapshot.value = serialized.value
  cleanRisk = riskOf(buildJobInput(draft.value, stepNameOf))
}

const stepProblems = computed(() =>
  problemsByTask(draft.value.tasks, (id) => connections.get(id), settings.typedEnvironments)
)
const passwordProblem = computed(() => backupPasswordProblem(draft.value))
const cron = computed(() => cronFromForm(draft.value.schedule))
const scheduleInvalid = computed(() => draft.value.scheduleEnabled && !isValidCron(cron.value))

const runs = computed<JobRun[]>(() => (jobId.value ? jobs.runsOf(jobId.value) : []))
// Rollbacks recorded under the job are not its runs.
const lastRun = computed(() => (jobId.value ? (jobs.lastRunOf(jobId.value) ?? null) : null))

const sections = computed(() => [
  {
    value: 'steps' as const,
    label: 'Pasos',
    icon: 'mdi-format-list-numbered',
    count: draft.value.tasks.length as number | undefined,
    alert: strict.value && Object.keys(stepProblems.value).length > 0
  },
  {
    value: 'schedule' as const,
    label: 'Programación',
    icon: 'mdi-calendar-clock',
    count: undefined,
    alert: scheduleInvalid.value
  },
  {
    value: 'options' as const,
    label: 'Opciones',
    icon: 'mdi-tune-variant',
    count: undefined,
    alert: !!passwordProblem.value && (strict.value || encryptsBackups(draft.value.tasks))
  },
  {
    value: 'history' as const,
    label: 'Historial',
    icon: 'mdi-history',
    count: jobId.value ? runs.value.length : undefined,
    alert: false
  }
])

function onSectionKey(event: KeyboardEvent, index: number): void {
  const list = sections.value
  let next = -1
  if (event.key === 'ArrowRight') next = (index + 1) % list.length
  else if (event.key === 'ArrowLeft') next = (index - 1 + list.length) % list.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = list.length - 1
  if (next < 0) return
  event.preventDefault()
  const target = list[next].value
  const bar = (event.currentTarget as HTMLElement | null)?.parentElement
  section.value = target
  void nextTick(() =>
    bar?.querySelector<HTMLElement>(`[data-test="job-section-${target}"]`)?.focus()
  )
}

/* ---------- header summary ---------- */

const scheduleLabel = computed(() => {
  if (!draft.value.scheduleEnabled) return 'Sin programar'
  if (!isValidCron(cron.value)) return 'Programación no válida'
  return describeSchedule(cron.value)
})

const ENV_PILL: Record<string, string> = {
  production: 'nd-pill--production',
  staging: 'nd-pill--staging',
  local: 'nd-pill--local'
}

/** Connections the job touches (steps and restore sources). */
const touched = computed(() => {
  const ids = new Set<string>()
  for (const t of draft.value.tasks) {
    if (t.connectionId) ids.add(t.connectionId)
    if (t.restoreSource?.kind === 'latest' && t.restoreSource.connectionId)
      ids.add(t.restoreSource.connectionId)
  }
  return [...ids].flatMap((id) => {
    const c = connections.get(id)
    return c ? [c] : []
  })
})
const engineSummary = computed(() => {
  const seen = new Map<string, { label: string; icon: string }>()
  for (const c of touched.value) {
    const e = engineOf(c)
    if (!seen.has(e.id)) seen.set(e.id, { label: e.label, icon: e.icon })
  }
  return [...seen.values()]
})
const environmentSummary = computed(() => {
  const envs = new Set<string>(touched.value.map((c) => c.environment))
  return ['production', 'staging', 'local'].filter((e) => envs.has(e))
})

/* ---------- load / save / run ---------- */

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    if (!connections.loaded) await connections.load().catch(() => undefined)
    // Packages of the other automations: «Restaurar paquete» rows and the Restauración list.
    void jobs.loadPackages()
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
    // For the «última ejecución» pill; the Historial section reloads them.
    void jobs.loadRuns(job.id).catch(() => undefined)
  } catch (err) {
    loadError.value = errorMessage(err)
  } finally {
    loading.value = false
    markClean()
  }
}

async function save(): Promise<boolean> {
  strict.value = true
  errors.value = validateDraft(draft.value, (id) => connections.get(id), guard.environments())
  if (errors.value.length) {
    revealFirstProblem()
    return false
  }
  const input = buildJobInput(draft.value, stepNameOf)
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
    strict.value = false
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

/** After a failed check, show where the first problem is: its step, Opciones or Programación. */
function revealFirstProblem(): void {
  const first = draft.value.tasks.find((t) => stepProblems.value[t.id])
  if (first) {
    section.value = 'steps'
    selectedStep.value = first.id
  } else if (passwordProblem.value) section.value = 'options'
  else if (scheduleInvalid.value) section.value = 'schedule'
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
    const run = await jobs.run(jobId.value, { confirmProduction: true })
    // The run's live log is in Historial.
    if (run?.id) logRunId.value = run.id
    section.value = 'history'
    notify.info(`Ejecutando «${draft.value.name}»…`)
  } catch {
    // Reported by invoke().
  } finally {
    runningNow.value = false
  }
}

/* ---------- steps ---------- */

const stepList = ref<InstanceType<typeof JobStepList> | null>(null)
const stepSettings = ref<InstanceType<typeof JobStepSettings> | null>(null)
/** Polite announcement of added steps for screen readers. */
const announcement = ref('')

/** Appends steps from the browser; one step opens its settings, several do not. */
function addSteps(added: JobTask[]): void {
  if (!added.length) return
  draft.value = { ...draft.value, tasks: [...draft.value.tasks, ...added] }
  const total = draft.value.tasks.length
  announcement.value =
    added.length === 1
      ? `Paso ${total} añadido`
      : `${added.length} pasos añadidos (hasta el ${total})`
  if (added.length === 1) selectedStep.value = added[0].id
  void stepList.value?.revealRow(added[added.length - 1].id)
}

/** «Copiar y restaurar» dialog and the origin it proposes. */
const recipeOpen = ref(false)
const recipeSource = ref<string | null>(null)
function openRecipe(sourceId: string | null = null): void {
  recipeSource.value = sourceId
  recipeOpen.value = true
}

/** Intro on a row: the settings open and take the keyboard focus. */
async function openStep(id: string): Promise<void> {
  selectedStep.value = id
  await nextTick()
  stepSettings.value?.focus()
}

/** Closing the settings returns the focus to the step's row. */
function closeStep(): void {
  const id = selectedStep.value
  selectedStep.value = null
  if (id) void stepList.value?.revealRow(id, true)
}

// A removed step closes its settings.
watch(
  () => draft.value.tasks.map((t) => t.id).join(','),
  () => {
    if (selectedStep.value && !draft.value.tasks.some((t) => t.id === selectedStep.value))
      selectedStep.value = null
  }
)

async function openOptions(): Promise<void> {
  section.value = 'options'
  await nextTick()
  passwordInput.value?.focus()
}

/* ---------- history ---------- */

const logRunId = ref<string | null>(null)
const logRun = computed(() =>
  logRunId.value ? (jobs.runs.find((r) => r.id === logRunId.value) ?? null) : null
)
watch(section, (value) => {
  if (value === 'history' && !logRunId.value && lastRun.value) logRunId.value = lastRun.value.id
})

function openLastRun(): void {
  if (lastRun.value) logRunId.value = lastRun.value.id
  section.value = 'history'
}

watch(dirty, (value) => tabs.setDirty(props.tab.id, value), { immediate: true })
onMounted(load)
</script>

<template>
  <div class="job-editor d-flex flex-column" data-test="job-editor">
    <header class="je-head" role="group" aria-label="Tarea">
      <span class="je-head__badge" aria-hidden="true"
        ><v-icon icon="mdi-robot-outline" size="17"
      /></span>
      <div class="je-head__identity">
        <v-text-field
          v-model="draft.name"
          variant="plain"
          density="compact"
          hide-details
          placeholder="Nombre de la tarea"
          aria-label="Nombre de la tarea"
          class="je-head__name"
          :class="{ 'je-head__name--error': strict && !draft.name.trim() }"
          :disabled="loading || !!loadError"
          :aria-invalid="strict && !draft.name.trim() ? 'true' : undefined"
          data-test="job-name"
        />
        <div class="je-head__pills">
          <span v-if="dirty" class="nd-pill nd-pill--staging" data-test="job-dirty">
            <span class="je-head__dirty-dot" aria-hidden="true" />Cambios sin guardar
          </span>
          <span v-if="draft.source" class="nd-pill" data-test="job-source">
            <v-icon icon="mdi-import" size="12" aria-hidden="true" />Importada de Navicat
          </span>
          <span v-for="e in engineSummary" :key="e.label" class="nd-pill">
            <v-icon :icon="e.icon" size="12" aria-hidden="true" />{{ e.label }}
          </span>
          <span
            v-for="env in environmentSummary"
            :key="env"
            class="nd-pill"
            :class="ENV_PILL[env]"
            >{{ ENVIRONMENT_LABELS[env] }}</span
          >
        </div>
      </div>
      <div class="je-head__actions">
        <button
          type="button"
          class="je-head__chip nd-transition"
          :class="{
            'je-head__chip--on': draft.scheduleEnabled && !scheduleInvalid,
            'je-head__chip--error': scheduleInvalid
          }"
          :title="`Programación: ${scheduleLabel}`"
          :aria-label="`Programación: ${scheduleLabel}. Abrir la programación`"
          data-test="job-schedule-pill"
          @click="section = 'schedule'"
        >
          <v-icon
            :icon="draft.scheduleEnabled ? 'mdi-calendar-clock' : 'mdi-calendar-remove-outline'"
            size="14"
            aria-hidden="true"
          />
          <span class="je-head__chip-text">{{ scheduleLabel }}</span>
          <v-icon
            v-if="draft.scheduleEnabled && draft.launchAgent"
            icon="mdi-power-sleep"
            size="13"
            title="También con la app cerrada"
            aria-hidden="true"
          />
        </button>
        <button
          v-if="lastRun"
          type="button"
          class="je-head__chip je-head__chip--run nd-transition"
          :title="`Última ejecución: ${formatDate(lastRun.startedAt)}`"
          :aria-label="`Última ejecución del ${formatDate(lastRun.startedAt)}. Abrir el historial`"
          data-test="job-last-run"
          @click="openLastRun"
        >
          <StatusPill :status="lastRun.status" />
        </button>
        <v-btn
          size="small"
          prepend-icon="mdi-play"
          class="je-head__run"
          variant="tonal"
          :loading="runningNow"
          :disabled="loading || !!loadError || !draft.tasks.length"
          data-test="job-run"
          @click="runNow"
        >
          Ejecutar ahora
        </v-btn>
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
      </div>
    </header>
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
    <template v-else>
      <nav class="je-sections" role="tablist" aria-label="Secciones de la tarea">
        <button
          v-for="(s, i) in sections"
          :id="`je-tab-${tab.id}-${s.value}`"
          :key="s.value"
          type="button"
          role="tab"
          class="je-section nd-transition"
          :class="{ 'je-section--active': section === s.value }"
          :aria-selected="section === s.value"
          :aria-controls="
            section === s.value || s.value === 'steps' ? `je-panel-${tab.id}-${s.value}` : undefined
          "
          :tabindex="section === s.value ? 0 : -1"
          :data-test="`job-section-${s.value}`"
          @click="section = s.value"
          @keydown="onSectionKey($event, i)"
        >
          <v-icon :icon="s.icon" size="15" aria-hidden="true" />
          {{ s.label }}
          <span v-if="s.count !== undefined" class="je-section__count">{{ s.count }}</span>
          <span v-if="s.alert" class="je-section__alert" role="img" aria-label="con problemas" />
        </button>
      </nav>
      <v-alert
        v-if="errors.length"
        type="error"
        density="compact"
        closable
        class="je-errors"
        data-test="job-errors"
        @click:close="errors = []"
      >
        <div v-for="(e, i) in errors" :key="i">{{ e }}</div>
      </v-alert>

      <div
        v-show="section === 'steps'"
        :id="`je-panel-${tab.id}-steps`"
        class="je-steps"
        :class="{ 'je-steps--panel': !!selectedStep }"
        role="tabpanel"
        :aria-labelledby="`je-tab-${tab.id}-steps`"
      >
        <div class="je-steps__main">
          <section class="je-seq" aria-labelledby="je-seq-title">
            <header class="je-seq__head">
              <h3 id="je-seq-title" class="je-seq__title">Secuencia de pasos</h3>
              <span class="nd-pill">{{ draft.tasks.length }}</span>
              <span v-if="draft.tasks.length > 1" class="je-seq__hint"
                >Se ejecutan en este orden. Arrastra o usa Alt+↑/↓ para moverlos.</span
              >
            </header>
            <div class="je-seq__scroll">
              <JobStepList
                v-if="!loading"
                ref="stepList"
                v-model="draft.tasks"
                v-model:selected="selectedStep"
                :problems="stepProblems"
                :strict="strict"
                @open="openStep"
                @recipe="openRecipe()"
              />
              <span class="je-sr" aria-live="polite">{{ announcement }}</span>
            </div>
          </section>
          <div class="je-browser" :class="{ 'je-browser--collapsed': browserCollapsed }">
            <JobStepBrowser
              v-model:collapsed="browserCollapsed"
              :tasks="draft.tasks"
              :job-id="draft.id ?? null"
              @add="addSteps"
              @recipe="openRecipe"
            />
          </div>
          <CopyRestoreDialog
            v-model="recipeOpen"
            :tasks="draft.tasks"
            :proposed-source="recipeSource"
            @add="addSteps"
          />
        </div>
        <div v-if="selectedStep" class="je-steps__panel">
          <JobStepSettings
            ref="stepSettings"
            :key="selectedStep"
            v-model="draft.tasks"
            :task-id="selectedStep"
            :problems="stepProblems[selectedStep]"
            :password-ready="draft.hasBackupPassword || !!draft.backupPassword"
            :job-id="draft.id ?? null"
            @close="closeStep"
            @open-options="openOptions"
          />
        </div>
      </div>

      <div
        v-if="section === 'schedule'"
        :id="`je-panel-${tab.id}-schedule`"
        class="je-page"
        role="tabpanel"
        :aria-labelledby="`je-tab-${tab.id}-schedule`"
      >
        <section class="je-card" aria-label="Programación">
          <header class="je-card__head">
            <span class="je-card__icon" aria-hidden="true"
              ><v-icon icon="mdi-calendar-clock" size="16"
            /></span>
            <h3 class="je-card__title">Cuándo se ejecuta</h3>
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

      <div
        v-else-if="section === 'options'"
        :id="`je-panel-${tab.id}-options`"
        class="je-page"
        role="tabpanel"
        :aria-labelledby="`je-tab-${tab.id}-options`"
      >
        <section class="je-card" aria-label="Ejecución">
          <header class="je-card__head">
            <span class="je-card__icon" aria-hidden="true"
              ><v-icon icon="mdi-play-network-outline" size="16"
            /></span>
            <h3 class="je-card__title">Ejecución</h3>
          </header>
          <v-checkbox
            v-model="draft.continueOnError"
            label="Continuar en caso de error"
            density="compact"
            hide-details
            class="je-check"
            data-test="job-continue-on-error"
          />
          <p class="je-hint">
            Activado, un paso que falla no detiene la tarea: los siguientes se ejecutan igual y el
            historial marca el fallo. Desactivado, la tarea se detiene en el primer error.
          </p>
        </section>

        <section class="je-card" aria-label="Cifrado de las copias">
          <header class="je-card__head">
            <span class="je-card__icon" aria-hidden="true"
              ><v-icon icon="mdi-lock-outline" size="16"
            /></span>
            <h3 class="je-card__title">Contraseña de cifrado de las copias</h3>
            <span
              v-if="draft.hasBackupPassword && !draft.backupPassword"
              class="nd-pill nd-pill--info"
              data-test="job-backup-password-stored"
              >guardada</span
            >
          </header>
          <div
            v-if="encryptsBackups(draft.tasks) || draft.backupPassword"
            class="je-password"
            data-test="job-backup-password"
          >
            <div class="je-password__fields">
              <v-text-field
                ref="passwordInput"
                v-model="draft.backupPassword"
                type="password"
                :label="draft.hasBackupPassword ? 'Nueva contraseña (opcional)' : 'Contraseña'"
                autocomplete="new-password"
                density="compact"
                hide-details
                data-test="job-backup-password-input"
              />
              <v-text-field
                v-model="draft.backupPasswordAgain"
                type="password"
                label="Repite la contraseña"
                autocomplete="new-password"
                density="compact"
                hide-details
                :disabled="!draft.backupPassword"
                data-test="job-backup-password-again"
              />
            </div>
            <p
              v-if="passwordProblem && (strict || draft.backupPassword)"
              class="je-password__error"
              data-test="job-backup-password-problem"
            >
              {{ passwordProblem }}
            </p>
            <p class="je-hint">
              Una para todos los pasos cifrados de esta tarea. Se guarda cifrada en este equipo
              (como las contraseñas de las conexiones) para las ejecuciones programadas; nunca se
              escribe en el registro. Si la pierdes, las copias cifradas no se pueden recuperar.
            </p>
          </div>
          <p v-else class="je-hint" data-test="job-backup-password-none">
            Ningún paso cifra sus copias. Para cifrar, abre un paso de copia en .vqb y marca «Cifrar
            con contraseña»; la contraseña se escribe aquí.
          </p>
        </section>

        <section v-if="draft.source" class="je-card" aria-label="Origen" data-test="job-origin">
          <header class="je-card__head">
            <span class="je-card__icon" aria-hidden="true"
              ><v-icon icon="mdi-import" size="16"
            /></span>
            <h3 class="je-card__title">Origen</h3>
          </header>
          <p class="je-hint">
            Importada de Navicat desde «{{ draft.source.fileName }}» el
            {{ formatDate(draft.source.importedAt) }}. Los cambios se guardan solo en Vortaq.
          </p>
        </section>
      </div>

      <div
        v-else-if="section === 'history'"
        :id="`je-panel-${tab.id}-history`"
        class="je-history"
        role="tabpanel"
        :aria-labelledby="`je-tab-${tab.id}-history`"
      >
        <EmptyState
          v-if="!jobId"
          icon="mdi-history"
          title="Sin historial todavía"
          description="Guarda la tarea y ejecútala: cada ejecución aparecerá aquí con su registro."
        />
        <template v-else>
          <div class="je-history__list">
            <RunHistory
              :job-id="jobId"
              :job-name="draft.name"
              :selected-run-id="logRunId"
              inline-log
              @open-log="logRunId = $event.id"
            />
          </div>
          <div class="je-history__log">
            <RunLogPanel v-if="logRun" :run="logRun" @close="logRunId = null" />
            <EmptyState
              v-else
              icon="mdi-text-box-search-outline"
              title="Elige una ejecución"
              description="Su registro se muestra aquí."
              size="compact"
            />
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.job-editor {
  height: 100%;
  min-height: 0;
  container-type: inline-size;
  container-name: job-editor;
}
.je-head {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  min-height: 56px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--nd-border);
  background: var(--nd-bg-panel);
}
.je-head__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: var(--nd-radius-control);
  color: var(--nd-accent);
  background: var(--nd-accent-gradient-soft);
  border: 1px solid rgba(var(--nd-accent-rgb), 0.25);
}
.je-head__identity {
  min-width: 220px;
  flex: 1 1 260px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.je-head__name {
  max-width: 460px;
  min-width: 180px;
}
.je-head__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-left: auto;
}
.je-head__name :deep(.v-field) {
  border-radius: var(--nd-radius-sm);
  transition: background var(--nd-dur-fast) var(--nd-ease);
}
.je-head__name :deep(.v-field:hover),
.je-head__name :deep(.v-field--focused) {
  background: var(--nd-hover);
}
.je-head__name :deep(input) {
  min-height: 28px;
  padding: 2px 6px;
  font-size: var(--nd-fs-title);
  font-weight: var(--nd-fw-heading);
}
.je-head__name--error :deep(.v-field) {
  box-shadow: inset 0 -2px 0 var(--nd-error);
}
.je-head__pills {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding-left: 6px;
}
.je-head__dirty-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
}
.je-head__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 240px;
  height: 28px;
  padding: 0 10px;
  font: inherit;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
  background: var(--nd-bg-sunken);
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-pill);
  cursor: pointer;
  flex: none;
}
.je-head__chip:hover {
  border-color: var(--nd-border-strong);
  color: var(--nd-text);
}
.je-head__chip:focus-visible {
  outline: 2px solid rgba(var(--nd-accent-rgb), 0.6);
  outline-offset: 1px;
}
.je-head__chip--on {
  color: var(--nd-text);
  border-color: rgba(var(--nd-accent-rgb), 0.4);
}
.je-head__chip--on > .v-icon:first-child {
  color: var(--nd-accent);
}
.je-head__chip--error {
  color: var(--nd-error);
  border-color: color-mix(in srgb, var(--nd-error) 45%, transparent);
}
.je-head__chip--run {
  padding: 0 4px;
  background: none;
  border-color: transparent;
}
.je-head__chip-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.je-head__run:not(.v-btn--disabled) :deep(.v-btn__prepend) {
  color: var(--nd-success);
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
.je-sections {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 4px 14px 0;
  border-bottom: 1px solid var(--nd-border);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.je-section {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 34px;
  padding: 0 12px;
  font: inherit;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
  background: none;
  border: 0;
  border-radius: var(--nd-radius-control) var(--nd-radius-control) 0 0;
  cursor: pointer;
}
.je-section:hover {
  color: var(--nd-text);
  background: var(--nd-hover);
}
.je-section:focus-visible {
  outline: 2px solid rgba(var(--nd-accent-rgb), 0.6);
  outline-offset: -2px;
}
.je-section--active {
  color: var(--nd-text);
  font-weight: 600;
}
.je-section--active::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 0;
  height: 2px;
  border-radius: 2px;
  background: var(--nd-accent-gradient-h);
}
.je-section--active .v-icon {
  color: var(--nd-accent);
}
.je-section__count {
  min-width: 18px;
  height: 16px;
  padding: 0 5px;
  border-radius: var(--nd-radius-pill);
  font-size: var(--nd-fs-xs);
  font-weight: 600;
  line-height: 14px;
  text-align: center;
  background: var(--nd-hover);
  border: 1px solid var(--nd-border);
}
.je-section__alert {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--nd-error);
  box-shadow: 0 0 6px var(--nd-error);
}
.je-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.je-errors {
  flex: none;
  margin: 8px 14px 0;
}
.je-steps {
  position: relative;
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
}
.je-steps--panel {
  grid-template-columns: minmax(0, 1fr) 360px;
}
.je-steps__main {
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.je-seq {
  flex: 1 1 0;
  min-height: 150px;
  display: flex;
  flex-direction: column;
}
.je-seq__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px 4px;
}
.je-seq__title {
  margin: 0;
  font-size: var(--nd-fs-dense);
  font-weight: var(--nd-fw-heading);
}
.je-seq__hint {
  margin-left: auto;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.je-seq__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 4px;
}
.je-browser {
  flex: 0 0 auto;
  height: clamp(220px, 50%, 520px);
  border-top: 1px solid var(--nd-border);
  background: var(--nd-bg-panel);
}
.je-browser--collapsed {
  height: auto;
}
.je-steps__panel {
  min-height: 0;
  border-left: 1px solid var(--nd-border);
}
/* Narrow editors (1100px windows with the sidebar open): the settings float over the steps. */
@container job-editor (max-width: 980px) {
  .je-steps--panel {
    grid-template-columns: minmax(0, 1fr);
  }
  .je-steps__panel {
    position: absolute;
    z-index: 3;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(360px, 92%);
    box-shadow: var(--nd-shadow-2);
  }
  .je-seq__hint {
    display: none;
  }
}
.je-page {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.je-page > .je-card {
  max-width: 960px;
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
  margin-bottom: 10px;
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
.je-check {
  margin-left: -8px;
}
.je-hint {
  margin: 4px 0 0;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.je-launchd {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--nd-hairline);
}
.je-password {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.je-password__fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  max-width: 640px;
}
.je-password__error {
  margin: 0;
  font-size: var(--nd-fs-dense);
  color: var(--nd-error);
}
.je-history {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(300px, 380px) minmax(0, 1fr);
}
.je-history__list {
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid var(--nd-border);
  background: var(--nd-bg-panel);
}
.je-history__log {
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
@container job-editor (max-width: 640px) {
  .je-head__chip {
    max-width: 170px;
  }
}
@container job-editor (max-width: 760px) {
  .je-history {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
  }
}
</style>
