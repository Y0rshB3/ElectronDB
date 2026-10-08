<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  ImportSourceInfo,
  SqlDumpImportResult,
  SqlDumpInspection,
  SqlDumpMode
} from '@shared/importers'
import { api } from '@renderer/api'
import { useConfirm } from '@renderer/composables/useConfirm'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useSettingsStore } from '@renderer/stores/settings'
import { useTreeStore } from '@renderer/stores/tree'
import { formatBytes, formatDuration, formatNumber } from '@renderer/utils/format'
import {
  sqlImportConnections,
  findLocalConnection
} from '@renderer/components/backups/backupHelpers'
import { useSchemaLoader } from '@renderer/components/backups/useSchemaLoader'
import ImportLog from './ImportLog.vue'
import ImportTarget from './ImportTarget.vue'
import { useImportOperation } from './useImportOperation'
import {
  bytesProgress,
  describeCounts,
  dumpSummary,
  schemaFromFileName,
  schemaNameProblem
} from './importHelpers'

/**
 * One .sql / .sql.gz dump restored into a connection: pick the file, look at
 * what it contains, choose where it goes, follow the live log. Steps 2-4.
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

const inspecting = ref(false)
const inspection = ref<SqlDumpInspection | null>(null)
const targetConnectionId = ref<string | null>(null)
const typedName = ref('')
const mode = ref<SqlDumpMode>('intoSchema')
const targetSchema = ref('')
const createSchema = ref(true)
const replaceSchema = ref(false)
const safetyBackup = ref(true)
const continueOnError = ref(false)
const result = ref<SqlDumpImportResult | null>(null)
const error = ref('')

watch([inspecting, op.running], ([a, b]) => emit('busy', a || b))

const target = computed(() =>
  targetConnectionId.value ? connections.get(targetConnectionId.value) : undefined
)
const needsTyped = computed(() => settings.needsTypedConfirm(target.value?.environment))
const typedOk = computed(() => !needsTyped.value || typedName.value.trim() === target.value?.name)
const schemaItems = computed(() => schemaLoader.of(targetConnectionId.value))
const schemaExists = computed(() => schemaItems.value.includes(targetSchema.value.trim()))
const schemaProblem = computed(() => {
  if (mode.value === 'asFile' && !targetSchema.value.trim()) return null
  return schemaNameProblem(targetSchema.value)
})
const severalDatabases = computed(() => (inspection.value?.databases.length ?? 0) > 1)
const percent = computed(() =>
  op.total.value ? Math.min(100, Math.round((op.current.value / op.total.value) * 100)) : null
)
const canRun = computed(
  () =>
    !!inspection.value &&
    !!target.value &&
    !schemaProblem.value &&
    (mode.value === 'asFile' || !!targetSchema.value.trim()) &&
    typedOk.value &&
    !op.running.value
)

function defaultMode(i: SqlDumpInspection): SqlDumpMode {
  return i.databases.length > 1 ? 'asFile' : 'intoSchema'
}

async function inspect(path: string): Promise<void> {
  inspecting.value = true
  error.value = ''
  try {
    const i = await api.importers.inspectSqlDump(path)
    inspection.value = i
    mode.value = defaultMode(i)
    targetSchema.value =
      mode.value === 'intoSchema' ? (i.databases[0] ?? schemaFromFileName(i.fileName)) : ''
    targetConnectionId.value ??=
      findLocalConnection(sqlImportConnections(connections.sorted))?.id ?? null
    if (targetConnectionId.value) void schemaLoader.load(targetConnectionId.value)
    step.value = 3
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    inspecting.value = false
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
  if (file) await inspect(file)
}

watch(targetConnectionId, (id) => {
  if (id) void schemaLoader.load(id)
})
watch(mode, (value) => {
  if (value === 'asFile') replaceSchema.value = false
  else if (!targetSchema.value && inspection.value)
    targetSchema.value =
      inspection.value.databases[0] ?? schemaFromFileName(inspection.value.fileName)
})

async function run(): Promise<void> {
  if (!canRun.value || !inspection.value || !target.value) return
  const schema = targetSchema.value.trim()
  const replacing = mode.value === 'intoSchema' && replaceSchema.value && schemaExists.value
  if (replacing && !needsTyped.value) {
    const ok = await ask({
      title: `Vaciar «${schema}»`,
      message: [
        `«${schema}» se borrará en «${target.value.name}» y se creará de nuevo con el contenido de ${inspection.value.fileName}.`,
        safetyBackup.value
          ? 'Antes se guarda una copia previa (.nb3, etiqueta «previo-importacion»).'
          : 'SIN copia previa: los datos actuales se perderán.'
      ].join('\n\n'),
      confirmText: 'Vaciar e importar',
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
      api.importers.importSqlDump(id, {
        path: inspection.value!.path,
        connectionId: cid,
        mode: mode.value,
        targetSchema: schema || null,
        createSchema: createSchema.value,
        replaceSchema: mode.value === 'intoSchema' && replaceSchema.value,
        safetyBackup: safetyBackup.value,
        continueOnError: continueOnError.value,
        ...(needsTyped.value ? { confirmProduction: true } : {})
      })
    )
    if (result.value.errors.length)
      notify.warning(`Importación terminada con ${result.value.errors.length} error(es)`)
    else notify.success(`Importado en ${target.value?.name ?? ''}`)
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
      'Las sentencias que ya se ejecutaron se quedan en la base de datos: puede quedar importada solo en parte.',
    confirmText: 'Detener',
    color: 'error'
  })
  if (ok) await op.cancel()
}

async function showInFolder(path: string): Promise<void> {
  await api.app.showInFolder(path).catch(() => undefined)
}

defineExpose({ pick })
</script>

<template>
  <div class="dump-import">
    <!-- Step 2: file -->
    <template v-if="step === 2">
      <p class="text-body-2 mb-3">
        Volcados de mysqldump, phpMyAdmin, HeidiSQL, Adminer, MySQL Workbench, DBeaver, TablePlus o
        cualquier archivo de sentencias SQL. Se aceptan archivos comprimidos .sql.gz.
      </p>
      <v-btn
        color="primary"
        variant="flat"
        prepend-icon="mdi-file-outline"
        :loading="inspecting"
        data-test="import-file-pick"
        @click="pick"
        >Elegir archivo…</v-btn
      >
    </template>

    <!-- Step 3: what the file contains and where it goes -->
    <template v-else-if="step === 3 && inspection">
      <div class="dump-import__file" data-test="dump-inspection">
        <v-icon icon="mdi-file-document-outline" size="20" class="dump-import__file-icon" />
        <div class="dump-import__file-text">
          <div class="dump-import__file-name nd-ellipsis" :title="inspection.path">
            {{ inspection.fileName }}
          </div>
          <div class="dump-import__file-meta">
            <span class="nd-mono">{{ formatBytes(inspection.sizeBytes) }}</span>
            <span v-if="inspection.gzip">· comprimido</span>
            <span v-if="inspection.tool">· {{ inspection.tool }}</span>
            <span v-if="inspection.databases.length"
              >· {{ inspection.databases.length === 1 ? 'base de datos' : 'bases de datos' }}
              <span class="nd-mono">{{ inspection.databases.join(', ') }}</span></span
            >
          </div>
          <div class="dump-import__file-meta">
            {{ describeCounts(inspection.counts) || 'Sin objetos detectados' }}
            <template v-if="inspection.counts.inserts">
              · {{ formatNumber(inspection.counts.inserts) }} INSERT</template
            >
          </div>
        </div>
      </div>
      <v-alert
        v-for="(w, i) in inspection.warnings"
        :key="i"
        type="warning"
        variant="tonal"
        density="compact"
        class="mb-2"
        data-test="dump-warning"
        >{{ w }}</v-alert
      >

      <ImportTarget
        v-model:connection-id="targetConnectionId"
        v-model:typed-name="typedName"
        :disabled="op.running.value"
      />

      <v-radio-group
        v-model="mode"
        density="compact"
        hide-details
        class="mb-2"
        data-test="dump-mode"
      >
        <v-radio value="asFile" data-test="dump-mode-file">
          <template #label>
            <span>
              Respetar las bases de datos del archivo
              <span class="dump-import__hint">(sus USE y CREATE DATABASE deciden el destino)</span>
            </span>
          </template>
        </v-radio>
        <v-radio value="intoSchema" data-test="dump-mode-schema">
          <template #label>
            <span>
              Importar todo en
              <strong>{{ targetSchema.trim() || 'el esquema de destino' }}</strong>
            </span>
          </template>
        </v-radio>
      </v-radio-group>

      <v-combobox
        v-model="targetSchema"
        :items="schemaItems"
        :loading="schemaLoader.isLoading(targetConnectionId)"
        :label="
          mode === 'intoSchema'
            ? 'Esquema de destino'
            : 'Esquema para sentencias sin USE (opcional)'
        "
        :error-messages="schemaProblem ?? undefined"
        :hint="
          schemaExists
            ? 'Existe en el destino: los objetos del archivo se añaden o reemplazan según sus sentencias.'
            : targetSchema.trim()
              ? 'No existe: se creará.'
              : undefined
        "
        persistent-hint
        prepend-inner-icon="mdi-database-outline"
        class="mb-2"
        data-test="dump-schema"
      />
      <v-alert
        v-if="mode === 'intoSchema' && severalDatabases"
        type="warning"
        variant="tonal"
        density="compact"
        class="mb-2"
        data-test="dump-several-databases"
      >
        El archivo contiene {{ inspection.databases.length }} bases de datos ({{
          inspection.databases.join(', ')
        }}): todo irá a «{{ targetSchema.trim() || '…' }}». Se omiten sus CREATE DATABASE y los USE
        apuntan al destino; los nombres calificados (base.tabla) no se cambian.
      </v-alert>

      <div class="dump-import__options">
        <v-checkbox
          v-model="createSchema"
          label="Crear el esquema si no existe"
          density="compact"
          hide-details
        />
        <v-checkbox
          v-if="mode === 'intoSchema'"
          v-model="replaceSchema"
          density="compact"
          hide-details
          data-test="dump-replace"
        >
          <template #label>
            Vaciar «{{ targetSchema.trim() || 'destino' }}» antes de importar (se borra y se crea de
            nuevo)
          </template>
        </v-checkbox>
        <v-checkbox
          v-if="mode === 'intoSchema' && replaceSchema"
          v-model="safetyBackup"
          label="Guardar antes una copia previa (.nb3)"
          density="compact"
          hide-details
          class="ml-6"
          data-test="dump-safety"
        />
        <v-checkbox
          v-model="continueOnError"
          label="Continuar si una sentencia falla"
          density="compact"
          hide-details
          data-test="dump-continue"
        />
      </div>
    </template>

    <!-- Step 4: progress and result -->
    <template v-else-if="step === 4">
      <div v-if="op.running.value" class="dump-import__progress" data-test="dump-progress">
        <div class="dump-import__progress-head">
          <span class="dump-import__spinner" aria-hidden="true" />
          <span class="nd-ellipsis">{{ op.status.value || 'Importando…' }}</span>
          <v-spacer />
          <span v-if="percent !== null" class="nd-mono">{{ percent }}%</span>
          <v-btn
            size="small"
            color="error"
            variant="text"
            prepend-icon="mdi-stop-circle-outline"
            :loading="op.cancelling.value"
            data-test="dump-cancel"
            @click="cancel"
            >Cancelar</v-btn
          >
        </div>
        <div
          class="nd-progress dump-import__track"
          role="progressbar"
          aria-label="Progreso de la importación"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="percent ?? undefined"
        >
          <span :style="{ width: `${percent ?? 0}%` }" />
        </div>
        <div class="text-caption text-medium-emphasis mt-1 nd-mono">
          {{ bytesProgress(op.current.value, op.total.value) }}
        </div>
      </div>
      <v-alert
        v-else-if="result"
        :type="result.errors.length ? 'warning' : 'success'"
        variant="tonal"
        class="mb-3"
        data-test="dump-result"
      >
        <div class="font-weight-medium">
          {{
            result.errors.length
              ? `Terminado con ${result.errors.length} error(es)`
              : 'Importación completada'
          }}
          <span class="text-medium-emphasis">· {{ formatDuration(result.durationMs) }}</span>
        </div>
        <div class="text-body-2">{{ dumpSummary(result) }}</div>
        <div v-if="result.databases.length" class="text-body-2">
          {{ result.databases.length === 1 ? 'Base de datos' : 'Bases de datos' }}:
          <span class="nd-mono">{{ result.databases.join(', ') }}</span>
        </div>
        <div v-if="result.skipped" class="text-body-2">
          {{ result.skipped }} sentencia(s) omitida(s) (CREATE DATABASE del archivo).
        </div>
        <div v-if="result.safetyBackupPath" class="text-body-2 mt-1">
          Copia previa:
          <a href="#" class="nd-mono" @click.prevent="showInFolder(result.safetyBackupPath)">{{
            result.safetyBackupPath
          }}</a>
        </div>
      </v-alert>
      <div v-if="result?.errors.length" class="dump-import__errors mb-3" data-test="dump-errors">
        <div v-for="(e, i) in result.errors.slice(0, 50)" :key="i" class="dump-import__error">
          <span class="nd-mono dump-import__line">Línea {{ formatNumber(e.line) }}</span>
          <div class="dump-import__error-text">
            <div>{{ e.message }}</div>
            <div class="nd-mono nd-ellipsis dump-import__stmt" :title="e.statement">
              {{ e.statement }}
            </div>
          </div>
        </div>
        <div v-if="result.errors.length > 50" class="text-caption text-medium-emphasis">
          … y {{ result.errors.length - 50 }} más
        </div>
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

    <div class="dump-import__actions">
      <v-btn
        v-if="step < 4"
        prepend-icon="mdi-arrow-left"
        :disabled="inspecting"
        data-test="import-back"
        @click="step === 3 ? (step = 2) : emit('back')"
        >Atrás</v-btn
      >
      <v-btn
        v-else-if="!op.running.value"
        prepend-icon="mdi-arrow-left"
        data-test="dump-again"
        @click="step = 3"
        >Cambiar opciones</v-btn
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
        data-test="dump-run"
        @click="run"
        >Importar</v-btn
      >
    </div>
  </div>
</template>

<style scoped>
.dump-import__file {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  margin-bottom: 12px;
  border-radius: var(--nd-radius-card);
  border: 1px solid var(--nd-border);
  background: var(--nd-bg-input);
}
.dump-import__file-icon {
  color: var(--nd-accent);
  margin-top: 2px;
}
.dump-import__file-text {
  min-width: 0;
  flex: 1;
}
.dump-import__file-name {
  font-weight: var(--nd-fw-heading);
}
.dump-import__file-meta {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.dump-import__hint {
  color: var(--nd-text-muted);
  font-size: var(--nd-fs-xs);
}
.dump-import__options {
  display: flex;
  flex-direction: column;
}
.dump-import__progress {
  padding: 12px 14px;
  margin-bottom: 12px;
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-raised);
  border: 1px solid rgba(var(--nd-accent-rgb), 0.22);
}
.dump-import__progress-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  min-width: 0;
}
.dump-import__spinner {
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid rgba(var(--nd-accent-rgb), 0.25);
  border-top-color: var(--nd-accent);
  animation: dump-spin 0.9s linear infinite;
}
@keyframes dump-spin {
  to {
    transform: rotate(360deg);
  }
}
.dump-import__track span {
  transition: width var(--nd-dur) var(--nd-ease);
}
.dump-import__errors {
  max-height: 180px;
  overflow-y: auto;
  border: 1px solid rgba(var(--v-theme-error), 0.35);
  border-radius: var(--nd-radius-card);
  padding: 6px 10px;
}
.dump-import__error {
  display: flex;
  gap: 10px;
  font-size: var(--nd-fs-xs);
  padding: 3px 0;
}
.dump-import__line {
  flex: none;
  color: rgb(var(--v-theme-error));
}
.dump-import__error-text {
  min-width: 0;
  flex: 1;
}
.dump-import__stmt {
  color: var(--nd-text-muted);
}
.dump-import__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
}
</style>
