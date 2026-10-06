<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  KeychainRecoveryResult,
  NavicatConnectionPreview,
  NavicatDetection,
  NavicatImportResult,
  NavicatJobPreview
} from '@shared/types'
import { api } from '@renderer/api'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useJobsStore } from '@renderer/stores/jobs'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore } from '@renderer/stores/ui'
import { environmentLabel, environmentPillClass } from '@renderer/components/backups/backupHelpers'
import { isMac } from '@renderer/utils/platform'
import DialogHeader from './DialogHeader.vue'

type Step = 1 | 2 | 3

const STEPS: { value: Step; title: string; icon: string }[] = [
  { value: 1, title: 'Detectar', icon: 'mdi-folder-search-outline' },
  { value: 2, title: 'Seleccionar', icon: 'mdi-format-list-checks' },
  { value: 3, title: 'Resultado', icon: 'mdi-check-decagram-outline' }
]

const ui = useUiStore()
const settingsStore = useSettingsStore()
const connections = useConnectionsStore()
const jobs = useJobsStore()
const notify = useNotify()
// Navicat's macOS folder and Keychain only exist on a Mac; elsewhere the folder
// must be copied from one and passwords are typed by hand.
const mac = isMac()
const rootPlaceholder = mac
  ? '~/Library/Application Support/PremiumSoft CyberTech/Navicat CC'
  : 'Carpeta «Navicat CC» copiada desde un Mac'

const step = ref<Step>(1)
const rootPath = ref('')
const detection = ref<NavicatDetection | null>(null)
const detecting = ref(false)
const previewing = ref(false)
const importing = ref(false)
const recovering = ref(false)
const error = ref('')
const connPreviews = ref<NavicatConnectionPreview[]>([])
const jobPreviews = ref<NavicatJobPreview[]>([])
const selectedConnections = ref<string[]>([])
const selectedJobs = ref<string[]>([])
const importResult = ref<NavicatImportResult | null>(null)
const recovery = ref<KeychainRecoveryResult | null>(null)

const open = computed({
  get: () => ui.importDialog,
  set: (value: boolean) => {
    if (!value && (importing.value || recovering.value)) return
    ui.importDialog = value
  }
})
const busy = computed(
  () => detecting.value || previewing.value || importing.value || recovering.value
)
const pathArg = computed(() => rootPath.value.trim() || null)
const allConnectionsSelected = computed(
  () =>
    connPreviews.value.length > 0 && selectedConnections.value.length === connPreviews.value.length
)
const allJobsSelected = computed(
  () => jobPreviews.value.length > 0 && selectedJobs.value.length === jobPreviews.value.length
)
const nothingSelected = computed(
  () => !selectedConnections.value.length && !selectedJobs.value.length
)

// Path the current detection belongs to; editing the path invalidates it so
// «Siguiente» cannot preview/import from a folder that was never detected.
let detectedPath: string | null = null
watch(pathArg, (value) => {
  if (detection.value && value !== detectedPath) detection.value = null
})

function reset(): void {
  step.value = 1
  rootPath.value = settingsStore.settings.navicatRootPath
  detection.value = null
  error.value = ''
  connPreviews.value = []
  jobPreviews.value = []
  selectedConnections.value = []
  selectedJobs.value = []
  importResult.value = null
  recovery.value = null
}

async function detect(requested = false): Promise<void> {
  // Outside macOS there is no default folder to probe: wait for a path.
  if (!pathArg.value && !mac) {
    detection.value = null
    error.value = requested
      ? 'Escribe la ruta de la carpeta «Navicat CC» copiada desde un Mac.'
      : ''
    return
  }
  detecting.value = true
  error.value = ''
  try {
    const result = await api.navicat.detect(pathArg.value)
    if (result.found && !rootPath.value) rootPath.value = result.rootPath
    detection.value = result
    detectedPath = pathArg.value
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    detecting.value = false
  }
}

async function goToPreview(): Promise<void> {
  previewing.value = true
  error.value = ''
  try {
    const [conns, jobList] = await Promise.all([
      api.navicat.previewConnections(pathArg.value),
      api.navicat.previewJobs(pathArg.value)
    ])
    connPreviews.value = conns
    jobPreviews.value = jobList
    // Preselect what has not been imported yet; re-importing updates existing items.
    selectedConnections.value = conns.filter((c) => !c.alreadyImported).map((c) => c.name)
    selectedJobs.value = jobList.filter((j) => !j.alreadyImported).map((j) => j.fileName)
    step.value = 2
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    previewing.value = false
  }
}

function toggleAllConnections(value: boolean | null): void {
  selectedConnections.value = value ? connPreviews.value.map((c) => c.name) : []
}

function toggleAllJobs(value: boolean | null): void {
  selectedJobs.value = value ? jobPreviews.value.map((j) => j.fileName) : []
}

async function runImport(): Promise<void> {
  importing.value = true
  error.value = ''
  try {
    importResult.value = await api.navicat.import(
      { connections: [...selectedConnections.value], jobs: [...selectedJobs.value] },
      pathArg.value
    )
    step.value = 3
    await Promise.all([
      connections.load().catch(() => undefined),
      jobs.load().catch(() => undefined)
    ])
    notify.success(
      `Importadas ${importResult.value.connections.length} conexiones y ${importResult.value.jobs.length} tareas`
    )
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    importing.value = false
  }
}

async function recoverPasswords(): Promise<void> {
  recovering.value = true
  error.value = ''
  try {
    recovery.value = await api.navicat.recoverPasswords()
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    recovering.value = false
  }
}

watch(
  () => ui.importDialog,
  (value) => {
    if (!value) return
    reset()
    void detect()
  },
  { immediate: true }
)
</script>

<template>
  <v-dialog v-model="open" max-width="860" scrollable :persistent="importing || recovering">
    <v-card data-test="import-dialog">
      <DialogHeader
        icon="mdi-import"
        title="Importar desde Navicat"
        subtitle="Conexiones, tareas de automatización y copias .nb3"
      >
        <span class="text-caption text-medium-emphasis">Paso {{ step }} de 3</span>
      </DialogHeader>
      <ol class="import-stepper" aria-label="Pasos de la importación">
        <li
          v-for="(st, i) in STEPS"
          :key="st.value"
          class="import-stepper__step"
          :class="{
            'import-stepper__step--active': step === st.value,
            'import-stepper__step--done': step > st.value
          }"
          :aria-current="step === st.value ? 'step' : undefined"
        >
          <span class="import-stepper__dot" aria-hidden="true">
            <v-icon v-if="step > st.value" icon="mdi-check" size="13" />
            <template v-else>{{ st.value }}</template>
          </span>
          <span class="import-stepper__label">{{ st.title }}</span>
          <span v-if="i < STEPS.length - 1" class="import-stepper__line" aria-hidden="true" />
        </li>
      </ol>
      <v-card-text class="import-dialog__body">
        <!-- Step 1: detection -->
        <template v-if="step === 1">
          <p class="text-body-2 mb-3">
            ElectronDB lee las conexiones, tareas de automatización y copias <code>.nb3</code> de
            Navicat sin modificarlas.
          </p>
          <v-alert
            v-if="!mac"
            type="info"
            variant="tonal"
            density="compact"
            class="mb-3"
            data-test="import-non-mac"
          >
            La importación lee la carpeta <code>Navicat CC</code> de Navicat para macOS (<code
              >~/Library/Application Support/PremiumSoft CyberTech/Navicat CC</code
            >). Cópiala desde un Mac a este equipo y escribe aquí su ruta. Todavía no se leen las
            conexiones que Navicat para Windows guarda en el Registro ni las de Navicat para Linux.
          </v-alert>
          <div class="d-flex ga-2 align-start">
            <v-text-field
              v-model="rootPath"
              label="Carpeta de datos de Navicat"
              :placeholder="rootPlaceholder"
              prepend-inner-icon="mdi-folder-outline"
              class="nd-mono-input"
              data-test="import-root"
            />
            <v-btn
              variant="tonal"
              prepend-icon="mdi-radar"
              class="import-dialog__detect"
              :loading="detecting"
              data-test="import-detect"
              @click="detect(true)"
              >Detectar</v-btn
            >
          </div>
          <v-alert
            v-if="detection && detection.found"
            type="success"
            variant="tonal"
            class="mt-3"
            data-test="import-detection"
          >
            <div>
              Navicat encontrado en <code>{{ detection.rootPath }}</code>
            </div>
            <div class="import-dialog__counts mt-2">
              <span class="import-dialog__count"
                ><strong class="nd-mono">{{ detection.connectionCount }}</strong> conexiones</span
              >
              <span class="import-dialog__count"
                ><strong class="nd-mono">{{ detection.jobCount }}</strong> tareas de
                automatización</span
              >
              <span class="import-dialog__count"
                ><strong class="nd-mono">{{ detection.backupCount }}</strong> copias de
                seguridad</span
              >
            </div>
          </v-alert>
          <v-alert v-else-if="detection" type="warning" variant="tonal" class="mt-3">
            No se encontraron datos de Navicat en esa carpeta. Revisa la ruta (normalmente en
            Application Support/PremiumSoft CyberTech/Navicat CC).
          </v-alert>
        </template>

        <!-- Step 2: selection -->
        <template v-else-if="step === 2">
          <div class="import-dialog__section">
            <v-icon icon="mdi-lan" size="16" aria-hidden="true" />
            <span class="import-dialog__section-title">Conexiones</span>
            <span class="nd-pill">{{ selectedConnections.length }}/{{ connPreviews.length }}</span>
            <v-spacer />
            <v-checkbox
              :model-value="allConnectionsSelected"
              label="Seleccionar todas"
              density="compact"
              hide-details
              :disabled="!connPreviews.length"
              @update:model-value="toggleAllConnections"
            />
          </div>
          <v-table
            density="compact"
            class="import-dialog__table mb-4"
            data-test="import-connections"
          >
            <tbody>
              <tr v-if="!connPreviews.length">
                <td class="text-medium-emphasis">No hay conexiones de MySQL en Navicat.</td>
              </tr>
              <tr v-for="c in connPreviews" :key="c.name">
                <td style="width: 40px">
                  <v-checkbox-btn
                    v-model="selectedConnections"
                    :value="c.name"
                    :aria-label="`Importar conexión ${c.name}`"
                  />
                </td>
                <td class="import-dialog__name-cell">
                  <div class="import-dialog__name">
                    <span
                      class="nd-dot"
                      :style="c.color ? { '--nd-dot': c.color } : undefined"
                      aria-hidden="true"
                    />
                    <span class="nd-ellipsis" :title="c.name">{{ c.name }}</span>
                    <span v-if="c.alreadyImported" class="nd-pill">ya importado</span>
                  </div>
                </td>
                <td class="import-dialog__nowrap">
                  <span class="nd-pill" :class="environmentPillClass(c.environment)">{{
                    environmentLabel(c.environment)
                  }}</span>
                </td>
                <td class="nd-mono import-dialog__host">
                  {{ c.host }}:{{ c.port }}
                  <v-icon
                    v-if="c.ssh.enabled"
                    icon="mdi-lock-outline"
                    size="x-small"
                    title="Túnel SSH"
                  />
                </td>
                <td class="import-dialog__meta">
                  <span class="nd-mono">{{ c.backupCount }}</span> copias
                </td>
              </tr>
            </tbody>
          </v-table>

          <div class="import-dialog__section">
            <v-icon icon="mdi-robot-outline" size="16" aria-hidden="true" />
            <span class="import-dialog__section-title">Tareas de automatización</span>
            <span class="nd-pill">{{ selectedJobs.length }}/{{ jobPreviews.length }}</span>
            <v-spacer />
            <v-checkbox
              :model-value="allJobsSelected"
              label="Seleccionar todas"
              density="compact"
              hide-details
              :disabled="!jobPreviews.length"
              @update:model-value="toggleAllJobs"
            />
          </div>
          <v-table density="compact" class="import-dialog__table" data-test="import-jobs">
            <tbody>
              <tr v-if="!jobPreviews.length">
                <td class="text-medium-emphasis">No hay tareas de automatización.</td>
              </tr>
              <tr v-for="j in jobPreviews" :key="j.fileName">
                <td style="width: 40px">
                  <v-checkbox-btn
                    v-model="selectedJobs"
                    :value="j.fileName"
                    :aria-label="`Importar tarea ${j.name}`"
                  />
                </td>
                <td class="import-dialog__name-cell">
                  <div class="import-dialog__name">
                    <span class="nd-ellipsis" :title="j.name">{{ j.name }}</span>
                    <span v-if="j.alreadyImported" class="nd-pill">ya importado</span>
                  </div>
                </td>
                <td class="import-dialog__targets">
                  <span
                    class="nd-ellipsis d-block"
                    :title="j.tasks.map((t) => `${t.server} · ${t.schema}`).join(', ')"
                    >{{ j.tasks.map((t) => `${t.server} · ${t.schema}`).join(', ') }}</span
                  >
                </td>
                <td class="import-dialog__meta">
                  <span class="nd-mono">{{ j.tasks.length }}</span> paso(s)
                </td>
              </tr>
            </tbody>
          </v-table>
        </template>

        <!-- Step 3: result + keychain recovery -->
        <template v-else-if="importResult">
          <v-alert type="success" variant="tonal" data-test="import-result">
            Importadas {{ importResult.connections.length }} conexiones y
            {{ importResult.jobs.length }} tareas de automatización.
          </v-alert>
          <v-alert
            v-if="importResult.warnings.length"
            type="warning"
            variant="tonal"
            density="compact"
            class="mt-2"
          >
            <div v-for="(w, i) in importResult.warnings" :key="i" class="text-body-2">{{ w }}</div>
          </v-alert>

          <v-card v-if="mac" variant="outlined" class="import-dialog__keychain mt-4">
            <v-card-text>
              <div class="import-dialog__section mb-2">
                <v-icon icon="mdi-key-chain-variant" size="16" aria-hidden="true" />
                <span class="import-dialog__section-title">Contraseñas</span>
              </div>
              <p class="text-body-2">
                Navicat no guarda las contraseñas en sus archivos. ElectronDB puede intentar leerlas
                del Llavero de macOS; el sistema puede pedirte permiso para cada elemento
                («Permitir» o «Permitir siempre»).
              </p>
              <v-btn
                class="mt-2"
                color="primary"
                variant="tonal"
                prepend-icon="mdi-key-chain"
                :loading="recovering"
                data-test="import-recover"
                @click="recoverPasswords"
              >
                Intentar recuperar contraseñas del Keychain de Navicat
              </v-btn>
              <template v-if="recovery">
                <v-alert
                  :type="recovery.recovered.length ? 'success' : 'info'"
                  variant="tonal"
                  density="compact"
                  class="mt-3"
                  data-test="import-recovery"
                >
                  Recuperadas {{ recovery.recovered.length }} de
                  {{ recovery.attempted }} contraseñas.
                  <ul v-if="recovery.recovered.length" class="ml-4">
                    <li v-for="r in recovery.recovered" :key="r.account">
                      {{ r.connectionName ?? 'Elemento sin conexión asociada' }}
                    </li>
                  </ul>
                </v-alert>
                <v-alert
                  v-if="recovery.warnings.length"
                  type="warning"
                  variant="tonal"
                  density="compact"
                  class="mt-2"
                >
                  <div v-for="(w, i) in recovery.warnings" :key="i" class="text-body-2">
                    {{ w }}
                  </div>
                </v-alert>
              </template>
              <p class="text-body-2 mt-3 text-medium-emphasis">
                Para las contraseñas que no se recuperen, edita cada conexión (clic derecho → Editar
                conexión…) y escríbela en «Contraseña».
              </p>
            </v-card-text>
          </v-card>
          <v-alert
            v-else
            type="info"
            variant="tonal"
            density="compact"
            class="mt-4"
            data-test="import-passwords-manual"
          >
            Navicat no guarda las contraseñas en sus archivos y fuera de macOS no hay Llavero del
            que recuperarlas. Edita cada conexión importada (clic derecho → Editar conexión…) y
            escribe la contraseña en «Contraseña».
          </v-alert>
        </template>

        <v-alert
          v-if="error"
          type="error"
          variant="tonal"
          density="compact"
          class="mt-3"
          data-test="import-error"
          >{{ error }}</v-alert
        >
      </v-card-text>
      <v-card-actions>
        <v-btn v-if="step === 2" prepend-icon="mdi-arrow-left" :disabled="busy" @click="step = 1"
          >Atrás</v-btn
        >
        <v-spacer />
        <v-btn :disabled="importing || recovering" @click="open = false">{{
          step === 3 ? 'Cerrar' : 'Cancelar'
        }}</v-btn>
        <v-btn
          v-if="step === 1"
          color="primary"
          variant="flat"
          :disabled="!detection?.found || busy"
          :loading="previewing"
          append-icon="mdi-arrow-right"
          data-test="import-next"
          @click="goToPreview"
        >
          Siguiente
        </v-btn>
        <v-btn
          v-if="step === 2"
          color="primary"
          variant="flat"
          :disabled="nothingSelected || busy"
          :loading="importing"
          data-test="import-run"
          @click="runImport"
        >
          Importar ({{ selectedConnections.length + selectedJobs.length }})
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.import-dialog__body {
  min-height: 300px;
  padding-top: 4px !important;
}
.import-dialog__body .nd-mono-input :deep(input) {
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
}
.import-dialog__detect {
  height: 34px !important;
}

/* Stepper */
.import-stepper {
  display: flex;
  align-items: center;
  list-style: none;
  margin: 0 20px 12px;
  padding: 10px 14px;
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-sunken);
  border: 1px solid var(--nd-border);
}
.import-stepper__step {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  color: var(--nd-text-muted);
  font-size: var(--nd-fs-dense);
  font-weight: 500;
}
.import-stepper__step:last-child {
  flex: none;
}
.import-stepper__dot {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  font-weight: 700;
  border: 1px solid var(--nd-border-strong);
  background: var(--nd-bg-raised);
  transition:
    background var(--nd-dur) var(--nd-ease),
    box-shadow var(--nd-dur) var(--nd-ease);
}
.import-stepper__step--active {
  color: var(--nd-text);
}
.import-stepper__step--active .import-stepper__dot {
  color: var(--nd-on-accent);
  background: var(--nd-accent-gradient);
  border-color: transparent;
  box-shadow: var(--nd-glow);
}
.import-stepper__step--done {
  color: var(--nd-text-2);
}
.import-stepper__step--done .import-stepper__dot {
  color: var(--nd-accent);
  background: var(--nd-accent-gradient-soft);
  border-color: rgba(var(--nd-accent-rgb), 0.4);
}
.import-stepper__label {
  white-space: nowrap;
}
.import-stepper__line {
  flex: 1;
  height: 1px;
  margin: 0 10px;
  background: var(--nd-border-strong);
}
.import-stepper__step--done .import-stepper__line {
  background: var(--nd-accent-gradient-h);
}

/* Detection + selection */
.import-dialog__counts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  font-size: var(--nd-fs-dense);
}
.import-dialog__count strong {
  font-weight: 700;
}
.import-dialog__section {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  margin-bottom: 2px;
}
.import-dialog__section .v-icon {
  color: var(--nd-text-muted);
}
.import-dialog__section-title {
  font-weight: var(--nd-fw-heading);
}
.import-dialog__section :deep(.v-checkbox) {
  flex: none;
  margin-left: auto;
}
.import-dialog__table {
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-card);
  overflow: hidden;
  background: var(--nd-bg-input);
}
.import-dialog__name-cell {
  max-width: 0;
  width: 45%;
}
.import-dialog__name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.import-dialog__nowrap {
  white-space: nowrap;
}
.import-dialog__host {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  white-space: nowrap;
}
.import-dialog__targets {
  max-width: 0;
  width: 35%;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.import-dialog__meta {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  text-align: right;
  white-space: nowrap;
}
.import-dialog__keychain {
  background: var(--nd-bg-raised);
}
</style>
