<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ImportSourceInfo, SqlFolderImportResult, SqlFolderPreview } from '@shared/importers'
import { api } from '@renderer/api'
import { useConfirm } from '@renderer/composables/useConfirm'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useSettingsStore } from '@renderer/stores/settings'
import { useTreeStore } from '@renderer/stores/tree'
import { formatBytes, formatDuration } from '@renderer/utils/format'
import {
  sqlImportConnections,
  findLocalConnection
} from '@renderer/components/backups/backupHelpers'
import { useSchemaLoader } from '@renderer/components/backups/useSchemaLoader'
import ImportLog from './ImportLog.vue'
import ImportTarget from './ImportTarget.vue'
import { useImportOperation } from './useImportOperation'
import { bytesProgress, dumpSummary, duplicateSchemas, schemaNameProblem } from './importHelpers'

/**
 * A folder with one dump per database, imported as a package (by default into
 * the local connection): each file name proposes its database, editable.
 */
const props = defineProps<{ source: ImportSourceInfo }>()
const step = defineModel<number>('step', { required: true })
const emit = defineEmits<{ back: []; close: []; busy: [value: boolean] }>()

const connections = useConnectionsStore()
const settings = useSettingsStore()
const tree = useTreeStore()
const notify = useNotify()
const { ask } = useConfirm()
const schemaLoader = useSchemaLoader()
const op = useImportOperation()

interface Row {
  path: string
  fileName: string
  sizeBytes: number
  schema: string
  selected: boolean
}

const loading = ref(false)
const preview = ref<SqlFolderPreview | null>(null)
const rows = ref<Row[]>([])
const targetConnectionId = ref<string | null>(null)
const typedName = ref('')
const replaceSchema = ref(true)
const safetyBackup = ref(true)
const continueOnError = ref(false)
const result = ref<SqlFolderImportResult | null>(null)
const error = ref('')

watch([loading, op.running], ([a, b]) => emit('busy', a || b))

const target = computed(() =>
  targetConnectionId.value ? connections.get(targetConnectionId.value) : undefined
)
const needsTyped = computed(() => settings.needsTypedConfirm(target.value?.environment))
const typedOk = computed(() => !needsTyped.value || typedName.value.trim() === target.value?.name)
const chosen = computed(() => rows.value.filter((r) => r.selected))
const duplicates = computed(() => duplicateSchemas(chosen.value.map((r) => r.schema)))
const existing = computed(() => new Set(schemaLoader.of(targetConnectionId.value)))
function rowProblem(row: Row): string | null {
  if (!row.selected) return null
  if (duplicates.value.has(row.schema.trim().toLowerCase())) return 'Nombre repetido'
  return schemaNameProblem(row.schema)
}
const canRun = computed(
  () =>
    !!target.value &&
    chosen.value.length > 0 &&
    chosen.value.every((r) => !rowProblem(r)) &&
    typedOk.value &&
    !op.running.value
)
const replacedCount = computed(
  () => chosen.value.filter((r) => existing.value.has(r.schema.trim())).length
)
const percent = computed(() =>
  op.total.value ? Math.min(100, Math.round((op.current.value / op.total.value) * 100)) : null
)

async function loadFolder(dir: string): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const p = await api.importers.previewSqlFolder(dir)
    preview.value = p
    rows.value = p.items.map((i) => ({ ...i, selected: true }))
    targetConnectionId.value ??= findLocalConnection(sqlImportConnections(connections.sorted))?.id ?? null
    if (targetConnectionId.value) void schemaLoader.load(targetConnectionId.value)
    step.value = 3
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}

async function pick(): Promise<void> {
  error.value = ''
  let dir: string | null = null
  try {
    dir = await api.importers.pick(props.source.id)
  } catch (err) {
    error.value = errorMessage(err)
    return
  }
  if (dir) await loadFolder(dir)
}

watch(targetConnectionId, (id) => {
  if (id) void schemaLoader.load(id)
})

async function run(): Promise<void> {
  if (!canRun.value || !preview.value || !target.value) return
  if (replaceSchema.value && replacedCount.value > 0 && !needsTyped.value) {
    const ok = await ask({
      title: `Reemplazar ${replacedCount.value} base(s) de datos`,
      message: [
        `En «${target.value.name}» se borrarán y se crearán de nuevo: ${chosen.value
          .filter((r) => existing.value.has(r.schema.trim()))
          .map((r) => r.schema.trim())
          .join(', ')}.`,
        safetyBackup.value
          ? 'Antes se guarda una copia previa (.nb3) de cada una.'
          : 'SIN copia previa: los datos actuales se perderán.'
      ].join('\n\n'),
      confirmText: 'Reemplazar e importar',
      color: 'warning'
    })
    if (!ok) return
  }
  const cid = target.value.id
  error.value = ''
  result.value = null
  step.value = 4
  try {
    result.value = await op.run((id) =>
      api.importers.importSqlFolder(id, {
        dir: preview.value!.dir,
        connectionId: cid,
        items: chosen.value.map((r) => ({ path: r.path, schema: r.schema.trim() })),
        replaceSchema: replaceSchema.value,
        safetyBackup: safetyBackup.value,
        continueOnError: continueOnError.value,
        ...(needsTyped.value ? { confirmProduction: true } : {})
      })
    )
    const failed = result.value.items.filter((i) => i.error || i.result?.errors.length).length
    if (failed) notify.warning(`Paquete importado con errores en ${failed} archivo(s)`)
    else notify.success(`Paquete importado en ${target.value?.name ?? ''}`)
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    if (connections.isOpen(cid)) void tree.loadDatabases(cid, true).catch(() => undefined)
  }
}

async function cancel(): Promise<void> {
  const ok = await ask({
    title: '¿Detener la importación?',
    message:
      'El archivo en curso puede quedar importado solo en parte y los siguientes no se importan.',
    confirmText: 'Detener',
    color: 'error'
  })
  if (ok) await op.cancel()
}

defineExpose({ pick })
</script>

<template>
  <div class="folder-import">
    <template v-if="step === 2">
      <p class="text-body-2 mb-3">
        Elige una carpeta con un volcado .sql o .sql.gz por base de datos. Cada archivo se importa
        en la base de datos que indica su nombre (puedes cambiarla).
      </p>
      <v-btn
        color="primary"
        variant="flat"
        prepend-icon="mdi-folder-open-outline"
        :loading="loading"
        data-test="import-folder-pick"
        @click="pick"
        >Elegir carpeta…</v-btn
      >
    </template>

    <template v-else-if="step === 3 && preview">
      <div class="text-caption text-medium-emphasis mb-2">
        <v-icon icon="mdi-folder-outline" size="14" />
        <code class="folder-import__path">{{ preview.dir }}</code>
      </div>
      <v-alert
        v-for="(w, i) in preview.warnings"
        :key="i"
        type="info"
        variant="tonal"
        density="compact"
        class="mb-2"
        >{{ w }}</v-alert
      >
      <ImportTarget
        v-model:connection-id="targetConnectionId"
        v-model:typed-name="typedName"
        :disabled="op.running.value"
      />
      <v-table density="compact" class="folder-import__table mb-2" data-test="folder-rows">
        <thead>
          <tr>
            <th style="width: 40px" />
            <th>Archivo</th>
            <th>Base de datos de destino</th>
            <th class="text-right">Tamaño</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.path" data-test="folder-row">
            <td>
              <v-checkbox-btn v-model="row.selected" :aria-label="`Importar ${row.fileName}`" />
            </td>
            <td class="folder-import__file nd-ellipsis" :title="row.path">{{ row.fileName }}</td>
            <td class="folder-import__schema">
              <v-text-field
                v-model="row.schema"
                density="compact"
                hide-details="auto"
                :disabled="!row.selected"
                :error-messages="rowProblem(row) ?? undefined"
                :aria-label="`Base de datos para ${row.fileName}`"
                data-test="folder-schema"
              >
                <template #append-inner>
                  <span
                    v-if="row.selected && existing.has(row.schema.trim())"
                    class="nd-pill"
                    title="Ya existe en el destino"
                    >existe</span
                  >
                </template>
              </v-text-field>
            </td>
            <td class="text-right nd-mono folder-import__size">
              {{ formatBytes(row.sizeBytes) }}
            </td>
          </tr>
        </tbody>
      </v-table>
      <div class="folder-import__options">
        <v-checkbox
          v-model="replaceSchema"
          density="compact"
          hide-details
          label="Reemplazar las bases de datos que ya existen (se borran y se crean de nuevo)"
          data-test="folder-replace"
        />
        <v-checkbox
          v-if="replaceSchema"
          v-model="safetyBackup"
          density="compact"
          hide-details
          class="ml-6"
          label="Guardar antes una copia previa (.nb3) de cada una"
        />
        <v-checkbox
          v-model="continueOnError"
          density="compact"
          hide-details
          label="Continuar si una sentencia o un archivo falla"
        />
      </div>
    </template>

    <template v-else-if="step === 4">
      <div v-if="op.running.value" class="folder-import__progress" data-test="folder-progress">
        <div class="folder-import__progress-head">
          <span class="nd-ellipsis">{{ op.status.value || 'Importando…' }}</span>
          <v-spacer />
          <span v-if="percent !== null" class="nd-mono">{{ percent }}%</span>
          <v-btn
            size="small"
            color="error"
            variant="text"
            prepend-icon="mdi-stop-circle-outline"
            :loading="op.cancelling.value"
            @click="cancel"
            >Cancelar</v-btn
          >
        </div>
        <div class="nd-progress" role="progressbar" aria-label="Progreso del paquete">
          <span :style="{ width: `${percent ?? 0}%` }" />
        </div>
        <div class="text-caption text-medium-emphasis mt-1 nd-mono">
          {{ bytesProgress(op.current.value, op.total.value) }}
        </div>
      </div>
      <div v-else-if="result" class="mb-3" data-test="folder-result">
        <div class="text-body-2 mb-2 text-medium-emphasis">
          {{ result.items.length }} archivo(s) · {{ formatDuration(result.durationMs) }}
        </div>
        <v-alert
          v-for="item in result.items"
          :key="item.path"
          :type="item.error || item.result?.errors.length ? 'warning' : 'success'"
          variant="tonal"
          density="compact"
          class="mb-1"
        >
          <span class="nd-mono">{{ item.schema }}</span> ·
          {{ item.error ?? (item.result ? dumpSummary(item.result) : 'No se importó') }}
          <template v-if="item.result?.errors.length">
            · primer error en la línea {{ item.result.errors[0].line }}:
            {{ item.result.errors[0].message }}</template
          >
        </v-alert>
      </div>
      <ImportLog :entries="op.log.value" />
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

    <div class="folder-import__actions">
      <v-btn
        v-if="step < 4"
        prepend-icon="mdi-arrow-left"
        :disabled="loading"
        data-test="import-back"
        @click="step === 3 ? (step = 2) : emit('back')"
        >Atrás</v-btn
      >
      <v-spacer />
      <v-btn :disabled="op.running.value" @click="emit('close')">{{
        step === 4 ? 'Cerrar' : 'Cancelar'
      }}</v-btn>
      <v-btn
        v-if="step === 3"
        color="primary"
        variant="flat"
        :disabled="!canRun"
        prepend-icon="mdi-database-import-outline"
        data-test="folder-run"
        @click="run"
        >Importar ({{ chosen.length }})</v-btn
      >
    </div>
  </div>
</template>

<style scoped>
.folder-import__path {
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  overflow-wrap: anywhere;
}
.folder-import__table {
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-card);
  overflow: hidden;
  background: var(--nd-bg-input);
}
.folder-import__file {
  max-width: 220px;
  font-size: var(--nd-fs-dense);
}
.folder-import__schema {
  min-width: 220px;
  padding-top: 4px !important;
  padding-bottom: 4px !important;
}
.folder-import__size {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  white-space: nowrap;
}
.folder-import__options {
  display: flex;
  flex-direction: column;
}
.folder-import__progress {
  padding: 12px 14px;
  margin-bottom: 12px;
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-raised);
  border: 1px solid rgba(var(--nd-accent-rgb), 0.22);
}
.folder-import__progress-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  min-width: 0;
}
.folder-import__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
}
</style>
