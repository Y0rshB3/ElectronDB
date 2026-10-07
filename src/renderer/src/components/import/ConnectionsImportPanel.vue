<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  ExistingConnectionMode,
  ImportConnectionItem,
  ImportConnectionsPreview,
  ImportConnectionsResult,
  ImportSourceInfo
} from '@shared/importers'
import { ENGINES } from '@shared/engines'
import { api } from '@renderer/api'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { environmentLabel, environmentPillClass } from '@renderer/components/backups/backupHelpers'
import {
  ROW_STATUS_LABEL,
  connectionRowStatus,
  defaultSelection,
  selectableKeys
} from './importHelpers'

/**
 * Connections file of another manager (.ncx, DBeaver data-sources.json,
 * MySQL Workbench connections.xml): pick or confirm the file, preview,
 * select, import. Steps 2-4 of the wizard.
 */
const props = defineProps<{ source: ImportSourceInfo }>()
const step = defineModel<number>('step', { required: true })
const emit = defineEmits<{ back: []; close: []; busy: [value: boolean] }>()

const connections = useConnectionsStore()
const notify = useNotify()

const path = ref<string | null>(null)
const preview = ref<ImportConnectionsPreview | null>(null)
const selected = ref<string[]>([])
const existingMode = ref<ExistingConnectionMode>('passwords')
const result = ref<ImportConnectionsResult | null>(null)
const loading = ref(false)
const importing = ref(false)
const error = ref('')

watch([loading, importing], ([a, b]) => emit('busy', a || b))

/** Icon of the engine Vortaq would create (a neutral one for unsupported types). */
function engineIcon(item: ImportConnectionItem): string {
  return item.engine ? ENGINES[item.engine].icon : 'mdi-database-off-outline'
}

const isNcx = computed(() => props.source.id === 'navicat-ncx')
const selectable = computed(() => selectableKeys(preview.value))
const allSelected = computed(
  () => selectable.value.length > 0 && selected.value.length === selectable.value.length
)
const selectedExisting = computed(
  () =>
    preview.value?.items.filter(
      (i) => selected.value.includes(i.key) && connectionRowStatus(i) === 'existing'
    ) ?? []
)
const fileHint = computed(() => {
  switch (props.source.id) {
    case 'navicat-ncx':
      return 'En Navicat: Archivo › Exportar conexiones… Marca «Export Password» si quieres traer también las contraseñas.'
    case 'dbeaver':
      return 'Vortaq lee data-sources.json del espacio de trabajo. Las contraseñas no se importan: DBeaver las guarda cifradas.'
    case 'workbench':
      return 'Vortaq lee connections.xml. Las contraseñas no se importan: MySQL Workbench las guarda en el llavero del sistema.'
    default:
      return ''
  }
})

async function loadPreview(file: string): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const p = await api.importers.previewConnections(props.source.id, file)
    path.value = file
    preview.value = p
    selected.value = defaultSelection(p)
    existingMode.value = p.containsPasswords ? 'passwords' : 'replace'
    step.value = 3
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}

async function pick(): Promise<void> {
  error.value = ''
  let file: string | null = null
  try {
    file = await api.importers.pick(props.source.id)
  } catch (err) {
    error.value = errorMessage(err)
    return
  }
  if (file) await loadPreview(file)
}

function toggleAll(value: boolean | null): void {
  selected.value = value ? [...selectable.value] : []
}

async function runImport(): Promise<void> {
  if (!path.value || !selected.value.length) return
  importing.value = true
  error.value = ''
  try {
    result.value = await api.importers.importConnections({
      source: props.source.id,
      path: path.value,
      keys: [...selected.value],
      existingMode: existingMode.value
    })
    step.value = 4
    await connections.load().catch(() => undefined)
    const n = result.value.created.length + result.value.updated.length
    notify.success(`Importadas ${n} ${n === 1 ? 'conexión' : 'conexiones'}`)
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    importing.value = false
  }
}

async function showFile(): Promise<void> {
  if (path.value) await api.app.showInFolder(path.value).catch(() => undefined)
}

defineExpose({ pick })
</script>

<template>
  <div class="conn-import">
    <!-- Step 2: file -->
    <template v-if="step === 2">
      <p v-if="fileHint" class="text-body-2 mb-3" data-test="import-file-hint">{{ fileHint }}</p>
      <v-alert
        v-if="source.detectedPath"
        type="info"
        variant="tonal"
        icon="mdi-file-search-outline"
        class="mb-3"
        data-test="import-file-detected"
      >
        <div>
          Se encontró el archivo de {{ source.label }} en
          <code class="conn-import__path">{{ source.detectedPath }}</code>
        </div>
        <div class="conn-import__question mt-2">¿Usar este archivo?</div>
        <div class="d-flex ga-2 mt-2">
          <v-btn
            color="primary"
            variant="flat"
            size="small"
            prepend-icon="mdi-check"
            :loading="loading"
            data-test="import-file-use"
            @click="loadPreview(source.detectedPath)"
            >Usar este archivo</v-btn
          >
          <v-btn
            variant="tonal"
            size="small"
            :disabled="loading"
            data-test="import-file-other"
            @click="pick"
            >Elegir otro…</v-btn
          >
        </div>
      </v-alert>
      <template v-else>
        <div v-if="source.defaultPathHint" class="text-caption text-medium-emphasis mb-2">
          Ubicación habitual:
          <code class="conn-import__path">{{ source.defaultPathHint }}</code>
        </div>
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-file-outline"
          :loading="loading"
          data-test="import-file-pick"
          @click="pick"
          >Elegir archivo…</v-btn
        >
      </template>
      <v-alert
        v-if="isNcx"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-4"
        data-test="import-ncx-passwords"
      >
        Un .ncx exportado con contraseñas permite recuperarlas. Vortaq solo las descifra del archivo
        que elijas aquí y las guarda en su almacén de credenciales. Bórralo después de importar.
      </v-alert>
    </template>

    <!-- Step 3: preview and selection -->
    <template v-else-if="step === 3 && preview">
      <div class="conn-import__file text-caption text-medium-emphasis mb-2">
        <v-icon icon="mdi-file-outline" size="14" />
        <code class="conn-import__path">{{ preview.path }}</code>
      </div>
      <v-alert
        v-for="(note, i) in preview.notes"
        :key="i"
        type="info"
        variant="tonal"
        density="compact"
        class="mb-2"
        data-test="import-note"
        >{{ note }}</v-alert
      >
      <div class="conn-import__section">
        <v-icon icon="mdi-lan" size="16" aria-hidden="true" />
        <span class="conn-import__section-title">Conexiones</span>
        <span class="nd-pill">{{ selected.length }}/{{ preview.items.length }}</span>
        <v-spacer />
        <v-checkbox
          :model-value="allSelected"
          label="Seleccionar todas"
          density="compact"
          hide-details
          :disabled="!selectable.length"
          @update:model-value="toggleAll"
        />
      </div>
      <v-table density="compact" class="conn-import__table" data-test="import-connection-rows">
        <tbody>
          <tr v-if="!preview.items.length">
            <td class="text-medium-emphasis">El archivo no contiene conexiones.</td>
          </tr>
          <tr
            v-for="item in preview.items"
            :key="item.key"
            :class="{ 'conn-import__row--disabled': connectionRowStatus(item) === 'unsupported' }"
            data-test="import-connection-row"
          >
            <td style="width: 40px">
              <v-checkbox-btn
                v-model="selected"
                :value="item.key"
                :disabled="connectionRowStatus(item) === 'unsupported'"
                :aria-label="`Importar conexión ${item.name}`"
              />
            </td>
            <td class="conn-import__name-cell">
              <div class="conn-import__name">
                <span
                  class="nd-dot"
                  :style="item.color ? { '--nd-dot': item.color } : undefined"
                  aria-hidden="true"
                />
                <span class="nd-ellipsis" :title="item.name">{{ item.name }}</span>
              </div>
              <div
                v-for="(w, i) in item.warnings"
                :key="i"
                class="conn-import__warning"
                data-test="import-row-warning"
              >
                <v-icon icon="mdi-alert-outline" size="12" /> {{ w }}
              </div>
              <div
                v-if="item.unsupportedReason"
                class="conn-import__warning"
                data-test="import-row-reason"
              >
                {{ item.unsupportedReason }}
              </div>
            </td>
            <td class="conn-import__nowrap">
              <span class="nd-pill" data-test="import-row-engine"
                ><v-icon :icon="engineIcon(item)" size="12" class="mr-1" />{{
                  item.engineLabel
                }}</span
              >
            </td>
            <td class="nd-mono conn-import__host">
              {{ item.host ? `${item.host}${item.port ? `:${item.port}` : ''}` : '—' }}
              <v-icon v-if="item.ssh" icon="mdi-lock-outline" size="x-small" title="Túnel SSH" />
              <v-icon v-if="item.ssl" icon="mdi-shield-lock-outline" size="x-small" title="SSL" />
            </td>
            <td class="conn-import__nowrap">
              <span class="nd-pill" :class="environmentPillClass(item.environment)">{{
                environmentLabel(item.environment)
              }}</span>
            </td>
            <td class="conn-import__nowrap conn-import__meta">
              <span
                v-if="item.hasPassword"
                class="nd-pill"
                title="El archivo incluye la contraseña"
                data-test="import-has-password"
                ><v-icon icon="mdi-key-outline" size="12" /> contraseña</span
              >
              <span class="nd-pill" :class="`conn-import__status--${connectionRowStatus(item)}`">{{
                ROW_STATUS_LABEL[connectionRowStatus(item)]
              }}</span>
            </td>
          </tr>
        </tbody>
      </v-table>
      <fieldset
        v-if="selectedExisting.length && preview.containsPasswords"
        class="conn-import__existing mt-3"
        data-test="import-existing-mode"
      >
        <legend class="conn-import__legend">
          {{ selectedExisting.length }}
          {{ selectedExisting.length === 1 ? 'conexión ya importada' : 'conexiones ya importadas' }}
        </legend>
        <v-radio-group v-model="existingMode" hide-details density="compact">
          <v-radio value="passwords" label="Actualizar solo la contraseña" />
          <v-radio value="replace" label="Reemplazar sus datos (host, usuario, SSH…)" />
        </v-radio-group>
      </fieldset>
      <div
        v-else-if="selectedExisting.length"
        class="text-caption text-medium-emphasis mt-2"
        data-test="import-existing-replace"
      >
        Las conexiones ya importadas se actualizan con los datos del archivo (se conservan su
        entorno, su carpeta de copias y sus contraseñas guardadas).
      </div>
    </template>

    <!-- Step 4: result -->
    <template v-else-if="step === 4 && result">
      <v-alert type="success" variant="tonal" data-test="import-connections-result">
        {{ result.created.length }}
        {{ result.created.length === 1 ? 'conexión nueva' : 'conexiones nuevas' }} y
        {{ result.updated.length }}
        {{ result.updated.length === 1 ? 'actualizada' : 'actualizadas' }}.
        <template v-if="result.passwordsSaved">
          {{ result.passwordsSaved }} con contraseña guardada.</template
        >
      </v-alert>
      <v-alert
        v-if="result.warnings.length"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-2"
      >
        <div v-for="(w, i) in result.warnings" :key="i" class="text-body-2">{{ w }}</div>
      </v-alert>
      <v-alert
        v-if="preview?.containsPasswords"
        type="warning"
        variant="tonal"
        class="mt-3"
        icon="mdi-delete-alert-outline"
        data-test="import-delete-file"
      >
        <div class="font-weight-medium">Borra el .ncx: contiene contraseñas.</div>
        <div class="text-body-2">
          Las contraseñas ya están en el almacén de credenciales de Vortaq. Cualquiera con el
          archivo puede recuperarlas.
        </div>
        <v-btn
          class="mt-2"
          size="small"
          variant="tonal"
          prepend-icon="mdi-folder-open-outline"
          @click="showFile"
          >Mostrar en la carpeta</v-btn
        >
      </v-alert>
      <v-alert
        v-else
        type="info"
        variant="tonal"
        density="compact"
        class="mt-3"
        data-test="import-type-passwords"
      >
        Escribe la contraseña de cada conexión al editarla (clic derecho → Editar conexión…), o
        márcala «Sin contraseña» si el servidor no la pide.
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

    <div class="conn-import__actions">
      <v-btn
        v-if="step < 4"
        prepend-icon="mdi-arrow-left"
        :disabled="loading || importing"
        data-test="import-back"
        @click="step === 3 ? (step = 2) : emit('back')"
        >Atrás</v-btn
      >
      <v-spacer />
      <v-btn :disabled="importing" @click="emit('close')">{{
        step === 4 ? 'Cerrar' : 'Cancelar'
      }}</v-btn>
      <v-btn
        v-if="step === 3"
        color="primary"
        variant="flat"
        :disabled="!selected.length || loading"
        :loading="importing"
        data-test="import-connections-run"
        @click="runImport"
        >Importar ({{ selected.length }})</v-btn
      >
    </div>
  </div>
</template>

<style scoped>
.conn-import__path {
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  overflow-wrap: anywhere;
}
.conn-import__question {
  font-weight: var(--nd-fw-heading);
}
.conn-import__file {
  display: flex;
  align-items: center;
  gap: 6px;
}
.conn-import__section {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
}
.conn-import__section-title {
  font-weight: var(--nd-fw-heading);
}
.conn-import__section :deep(.v-checkbox) {
  flex: none;
}
.conn-import__table {
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-card);
  overflow: hidden;
  background: var(--nd-bg-input);
}
.conn-import__row--disabled {
  opacity: 0.6;
}
.conn-import__name-cell {
  max-width: 0;
  width: 38%;
}
.conn-import__name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.conn-import__warning {
  font-size: var(--nd-fs-xs);
  color: rgb(var(--v-theme-warning));
  overflow-wrap: anywhere;
}
.conn-import__nowrap {
  white-space: nowrap;
}
.conn-import__host {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  white-space: nowrap;
}
.conn-import__meta {
  text-align: right;
}
.conn-import__meta .nd-pill + .nd-pill {
  margin-left: 4px;
}
.conn-import__status--existing {
  color: var(--nd-text-2);
}
.conn-import__status--unsupported {
  color: rgb(var(--v-theme-warning));
}
.conn-import__existing {
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-input);
  padding: 6px 12px 8px;
}
.conn-import__legend {
  padding: 0 4px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.conn-import__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
}
</style>
