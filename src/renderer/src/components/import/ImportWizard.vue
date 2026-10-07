<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ImportSourceInfo } from '@shared/importers'
import type { BackupFile } from '@shared/types'
import { api } from '@renderer/api'
import { errorMessage } from '@renderer/composables/useNotify'
import { useUiStore } from '@renderer/stores/ui'
import DialogHeader from '@renderer/components/dialogs/DialogHeader.vue'
import ConnectionsImportPanel from './ConnectionsImportPanel.vue'
import SqlDumpImportPanel from './SqlDumpImportPanel.vue'
import SqlFolderImportPanel from './SqlFolderImportPanel.vue'

/**
 * «Importar…»: one wizard for every source. Step 1 lists the sources; the
 * Navicat folder hands over to its own dialog (detection and confirmation),
 * a .nb3 copy to the restore dialog, everything else continues here.
 */
const ui = useUiStore()

const STEPS = [
  { value: 1, title: 'Origen' },
  { value: 2, title: 'Archivo' },
  { value: 3, title: 'Revisar' },
  { value: 4, title: 'Resultado' }
]

const step = ref(1)
const sources = ref<ImportSourceInfo[]>([])
const source = ref<ImportSourceInfo | null>(null)
const loading = ref(false)
const busy = ref(false)
const error = ref('')

const open = computed({
  get: () => ui.importWizard,
  set: (value: boolean) => {
    if (!value && busy.value) return
    ui.importWizard = value
  }
})

const groups = computed(() => [
  {
    title: 'Conexiones',
    items: sources.value.filter((s) => s.flow === 'connections' || s.flow === 'navicatFolder')
  },
  {
    title: 'Copias y volcados',
    items: sources.value.filter(
      (s) => s.flow === 'sqlDump' || s.flow === 'sqlFolder' || s.flow === 'nb3'
    )
  }
])

const subtitle = computed(() =>
  source.value ? source.value.label : 'Conexiones y copias de otros gestores de bases de datos'
)

async function loadSources(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    sources.value = await api.importers.sources()
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}

function reset(): void {
  step.value = 1
  source.value = null
  busy.value = false
  error.value = ''
}

async function choose(s: ImportSourceInfo): Promise<void> {
  error.value = ''
  if (s.flow === 'navicatFolder') {
    ui.importWizard = false
    ui.openImportDialog({ fromWizard: true })
    return
  }
  if (s.flow === 'nb3') {
    let path: string | null = null
    try {
      path = await api.importers.pick(s.id)
    } catch (err) {
      error.value = errorMessage(err)
      return
    }
    if (!path) return
    const fileName = path.split(/[\\/]/).pop() ?? path
    const file: BackupFile = {
      path,
      fileName,
      connectionId: null,
      schema: null,
      sizeBytes: 0,
      createdAt: '',
      modifiedAt: '',
      source: 'unknown',
      label: null
    }
    ui.importWizard = false
    ui.openRestoreDialog(file, null)
    return
  }
  source.value = s
  step.value = 2
}

function back(): void {
  source.value = null
  step.value = 1
}

watch(
  () => ui.importWizard,
  (value) => {
    if (!value) return
    reset()
    void loadSources()
  },
  { immediate: true }
)
</script>

<template>
  <v-dialog v-model="open" max-width="880" scrollable :persistent="busy">
    <v-card data-test="import-wizard">
      <DialogHeader icon="mdi-import" title="Importar" :subtitle="subtitle">
        <span class="text-caption text-medium-emphasis">Paso {{ step }} de 4</span>
      </DialogHeader>
      <ol class="wizard-stepper" aria-label="Pasos de la importación">
        <li
          v-for="(st, i) in STEPS"
          :key="st.value"
          class="wizard-stepper__step"
          :class="{
            'wizard-stepper__step--active': step === st.value,
            'wizard-stepper__step--done': step > st.value
          }"
          :aria-current="step === st.value ? 'step' : undefined"
        >
          <span class="wizard-stepper__dot" aria-hidden="true">
            <v-icon v-if="step > st.value" icon="mdi-check" size="13" />
            <template v-else>{{ st.value }}</template>
          </span>
          <span class="wizard-stepper__label">{{ st.title }}</span>
          <span v-if="i < STEPS.length - 1" class="wizard-stepper__line" aria-hidden="true" />
        </li>
      </ol>
      <v-card-text class="wizard__body">
        <template v-if="step === 1">
          <p class="text-body-2 mb-3">
            Elige de dónde vienen tus datos. Vortaq solo lee el archivo o la carpeta que elijas, sin
            modificarlos.
          </p>
          <div v-if="loading" class="wizard__loading" role="status">
            <v-progress-circular indeterminate size="16" width="2" /> Cargando orígenes…
          </div>
          <section v-for="g in groups" :key="g.title" class="wizard__group">
            <h3 class="wizard__group-title">{{ g.title }}</h3>
            <div class="wizard__sources">
              <button
                v-for="s in g.items"
                :key="s.id"
                type="button"
                class="wizard__source"
                :data-test="`import-source-${s.id}`"
                @click="choose(s)"
              >
                <span class="nd-icon-badge wizard__source-icon" aria-hidden="true">
                  <v-icon :icon="s.icon" size="18" />
                </span>
                <span class="wizard__source-text">
                  <span class="wizard__source-label">
                    {{ s.label }}
                    <span v-if="s.detectedPath" class="nd-pill wizard__found">encontrado</span>
                  </span>
                  <span class="wizard__source-desc">{{ s.description }}</span>
                </span>
                <v-icon icon="mdi-chevron-right" size="18" class="wizard__chevron" />
              </button>
            </div>
          </section>
          <v-alert
            v-if="error"
            type="error"
            variant="tonal"
            density="compact"
            class="mt-3"
            data-test="import-error"
            >{{ error }}</v-alert
          >
          <div class="wizard__actions">
            <v-spacer />
            <v-btn @click="open = false">Cancelar</v-btn>
          </div>
        </template>
        <ConnectionsImportPanel
          v-else-if="source?.flow === 'connections'"
          v-model:step="step"
          :source="source"
          @back="back"
          @close="open = false"
          @busy="busy = $event"
        />
        <SqlDumpImportPanel
          v-else-if="source?.flow === 'sqlDump'"
          v-model:step="step"
          :source="source"
          @back="back"
          @close="open = false"
          @busy="busy = $event"
        />
        <SqlFolderImportPanel
          v-else-if="source?.flow === 'sqlFolder'"
          v-model:step="step"
          :source="source"
          @back="back"
          @close="open = false"
          @busy="busy = $event"
        />
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.wizard__body {
  min-height: 320px;
  padding-top: 4px !important;
}
.wizard__loading {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
  margin-bottom: 12px;
}
.wizard__group + .wizard__group {
  margin-top: 14px;
}
.wizard__group-title {
  font-size: var(--nd-fs-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--nd-text-muted);
  margin: 0 0 6px;
}
.wizard__sources {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 8px;
}
.wizard__source {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-width: 0;
  padding: 10px 12px;
  text-align: left;
  color: inherit;
  border-radius: var(--nd-radius-card);
  border: 1px solid var(--nd-border);
  background: var(--nd-bg-input);
  cursor: pointer;
  transition:
    border-color var(--nd-dur) var(--nd-ease),
    background var(--nd-dur) var(--nd-ease);
}
.wizard__source:hover,
.wizard__source:focus-visible {
  border-color: rgba(var(--nd-accent-rgb), 0.55);
  background: var(--nd-bg-raised);
  outline: none;
}
.wizard__source-icon {
  flex: none;
}
.wizard__source-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.wizard__source-label {
  font-weight: var(--nd-fw-heading);
  display: flex;
  align-items: center;
  gap: 6px;
}
.wizard__source-desc {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.wizard__found {
  font-weight: 500;
}
.wizard__chevron {
  color: var(--nd-text-muted);
  flex: none;
}
.wizard__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
}

.wizard-stepper {
  display: flex;
  align-items: center;
  list-style: none;
  margin: 0 20px 12px;
  padding: 10px 14px;
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-sunken);
  border: 1px solid var(--nd-border);
}
.wizard-stepper__step {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  color: var(--nd-text-muted);
  font-size: var(--nd-fs-dense);
  font-weight: 500;
}
.wizard-stepper__step:last-child {
  flex: none;
}
.wizard-stepper__dot {
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
}
.wizard-stepper__step--active {
  color: var(--nd-text);
}
.wizard-stepper__step--active .wizard-stepper__dot {
  color: var(--nd-on-accent);
  background: var(--nd-accent-gradient);
  border-color: transparent;
  box-shadow: var(--nd-glow);
}
.wizard-stepper__step--done {
  color: var(--nd-text-2);
}
.wizard-stepper__step--done .wizard-stepper__dot {
  color: var(--nd-accent);
  background: var(--nd-accent-gradient-soft);
  border-color: rgba(var(--nd-accent-rgb), 0.4);
}
.wizard-stepper__label {
  white-space: nowrap;
}
.wizard-stepper__line {
  flex: 1;
  height: 1px;
  margin: 0 10px;
  background: var(--nd-border-strong);
}
.wizard-stepper__step--done .wizard-stepper__line {
  background: var(--nd-accent-gradient-h);
}
</style>
