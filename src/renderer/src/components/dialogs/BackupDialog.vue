<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { BackupFormat } from '@shared/importers'
import type { BackupCreateResult } from '@shared/types'
import { api, newOperationId } from '@renderer/api'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useBackupsStore } from '@renderer/stores/backups'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useTreeStore } from '@renderer/stores/tree'
import { useUiStore } from '@renderer/stores/ui'
import { formatBytes, formatDuration, formatNumber } from '@renderer/utils/format'
import PathPicker from '@renderer/components/common/PathPicker.vue'
import './pathField.css'
import { vPathTail } from './pathTail'
import { revealInFinder } from '@renderer/components/backups/reveal'
import OperationProgress from '@renderer/components/backups/OperationProgress.vue'
import { useSchemaLoader } from '@renderer/components/backups/useSchemaLoader'
import { backupConnections } from '@renderer/components/backups/backupHelpers'
import DialogHeader from './DialogHeader.vue'

const ui = useUiStore()
const connections = useConnectionsStore()
const backups = useBackupsStore()
const tree = useTreeStore()
const notify = useNotify()
const schemaLoader = useSchemaLoader()

const connectionId = ref<string | null>(null)
const schema = ref<string | null>(null)
const objects = ref<string[]>([])
const objectItems = ref<{ title: string; value: string; subtitle: string }[]>([])
const objectsLoading = ref(false)
const includeData = ref(true)
/** .nb3 (restorable copy) or plain .sql for other managers. */
const format = ref<BackupFormat>('nb3')
const includeStructure = ref(true)
const includeCreateDatabase = ref(false)
const gzip = ref(false)
const label = ref('')
const comment = ref('')
const targetDir = ref('')

const operationId = ref<string | null>(null)
const running = ref(false)
const cancelling = ref(false)
const error = ref('')
const result = ref<Pick<
  BackupCreateResult,
  'path' | 'sizeBytes' | 'objects' | 'rows' | 'durationMs'
> | null>(null)
const isSql = computed(() => format.value === 'sql')

const open = computed({
  get: () => ui.backupDialog.open,
  set: (value: boolean) => {
    if (!value && running.value) return
    ui.backupDialog = { ...ui.backupDialog, open: value }
  }
})

const connectionItems = computed(() =>
  backupConnections(connections.sorted).map((c) => ({ title: c.name, value: c.id }))
)
const connection = computed(() =>
  connectionId.value ? connections.get(connectionId.value) : undefined
)
const canStart = computed(
  () =>
    !!connectionId.value &&
    !!schema.value &&
    !running.value &&
    (!isSql.value || includeStructure.value || includeData.value)
)

function reset(): void {
  connectionId.value = ui.backupDialog.connectionId
  schema.value = ui.backupDialog.schema
  objects.value = []
  includeData.value = true
  format.value = ui.backupDialog.format === 'sql' ? 'sql' : 'nb3'
  includeStructure.value = true
  includeCreateDatabase.value = false
  gzip.value = false
  label.value = ''
  comment.value = ''
  targetDir.value = ''
  operationId.value = null
  error.value = ''
  result.value = null
  cancelling.value = false
}

// Incremented per request so a slow response for a previous schema is discarded.
let objectsRequest = 0

async function loadObjects(): Promise<void> {
  const request = ++objectsRequest
  objectItems.value = []
  objects.value = []
  const cid = connectionId.value
  const db = schema.value
  if (!cid || !db) {
    objectsLoading.value = false
    return
  }
  objectsLoading.value = true
  try {
    const [tables, views] = await Promise.all([
      api.invokeSilent('db:tables', cid, db),
      api.invokeSilent('db:views', cid, db).catch(() => [])
    ])
    if (request !== objectsRequest) return
    objectItems.value = [
      ...tables.map((t) => ({ title: t.name, value: t.name, subtitle: 'Tabla' })),
      ...views.map((v) => ({ title: v.name, value: v.name, subtitle: 'Vista' }))
    ]
  } catch (err) {
    if (request === objectsRequest) error.value = errorMessage(err)
  } finally {
    if (request === objectsRequest) objectsLoading.value = false
  }
}

async function start(): Promise<void> {
  if (!connectionId.value || !schema.value) return
  const cid = connectionId.value
  const opId = newOperationId('backup')
  operationId.value = opId
  running.value = true
  error.value = ''
  result.value = null
  try {
    if (isSql.value) {
      const exported = await api.backups.exportSql(opId, {
        connectionId: cid,
        schema: schema.value,
        includeStructure: includeStructure.value,
        includeData: includeData.value,
        includeCreateDatabase: includeCreateDatabase.value,
        gzip: gzip.value,
        objects: objects.value.length ? [...objects.value] : undefined,
        label: label.value.trim() || undefined,
        targetDir: targetDir.value.trim() || undefined
      })
      result.value = exported
      notify.success(`Exportación .sql creada en ${exported.path}`, {
        label: 'Mostrar en Finder',
        handler: () => revealInFinder(exported.path)
      })
      return
    }
    // Silent invoke: failures are shown inline below, not also in the global snackbar.
    result.value = await api.invokeSilent('backups:create', opId, {
      connectionId: cid,
      schema: schema.value,
      includeData: includeData.value,
      objects: objects.value.length ? [...objects.value] : undefined,
      label: label.value.trim() || undefined,
      comment: comment.value.trim() || undefined,
      targetDir: targetDir.value.trim() || undefined
    })
    backups.invalidate(cid)
    if (tree.hasItems(cid, schema.value, 'backups'))
      void tree.loadGroup(cid, schema.value, 'backups', true).catch(() => undefined)
    // The dialog also stays open on its result view, which offers «Mostrar en Finder».
    const created = result.value!.path
    notify.success(`Copia de seguridad creada en ${created}`, {
      label: 'Mostrar en Finder',
      handler: () => revealInFinder(created)
    })
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    running.value = false
    cancelling.value = false
  }
}

async function cancel(): Promise<void> {
  if (!operationId.value) return
  cancelling.value = true
  try {
    await api.backups.cancel(operationId.value)
  } catch {
    cancelling.value = false
  }
}

watch(
  () => ui.backupDialog.open,
  (value) => {
    if (!value) return
    reset()
    if (connectionId.value) void schemaLoader.load(connectionId.value)
    void loadObjects()
  },
  { immediate: true }
)

function onConnectionChange(id: string | null): void {
  connectionId.value = id
  schema.value = null
  objectItems.value = []
  objects.value = []
  if (id) void schemaLoader.load(id)
}

function onSchemaChange(value: string | null): void {
  schema.value = value
  void loadObjects()
}
</script>

<template>
  <v-dialog v-model="open" max-width="640" :persistent="running">
    <v-card data-test="backup-dialog">
      <DialogHeader
        icon="mdi-archive-plus-outline"
        :title="isSql ? 'Exportar a .sql' : 'Nueva copia de seguridad'"
        :subtitle="
          isSql
            ? 'Archivo .sql que el cliente mysql y otros gestores pueden importar'
            : 'Archivo .nb3 compatible con Navicat'
        "
      />
      <v-card-text class="backup-dialog__body">
        <template v-if="!result">
          <div class="backup-dialog__format">
            <span class="backup-dialog__format-label">Formato</span>
            <v-btn-toggle
              v-model="format"
              mandatory
              density="compact"
              variant="outlined"
              divided
              :disabled="running"
              data-test="backup-format"
            >
              <v-btn value="nb3" size="small" data-test="backup-format-nb3">.nb3</v-btn>
              <v-btn value="sql" size="small" data-test="backup-format-sql">.sql</v-btn>
            </v-btn-toggle>
            <span class="backup-dialog__format-hint">{{
              isSql
                ? 'Para llevar la copia a otros gestores; Vortaq la importa con «Importar…».'
                : 'Copia restaurable desde Copias de seguridad y tareas.'
            }}</span>
          </div>
          <v-row dense>
            <v-col cols="12" sm="6">
              <v-select
                :model-value="connectionId"
                :items="connectionItems"
                label="Conexión"
                prepend-inner-icon="mdi-server-network"
                :disabled="running"
                data-test="backup-connection"
                @update:model-value="onConnectionChange"
              />
            </v-col>
            <v-col cols="12" sm="6">
              <v-autocomplete
                :model-value="schema"
                :items="schemaLoader.of(connectionId)"
                :loading="schemaLoader.isLoading(connectionId)"
                :error-messages="
                  schemaLoader.errorOf(connectionId) ? [schemaLoader.errorOf(connectionId)!] : []
                "
                label="Esquema"
                prepend-inner-icon="mdi-database-outline"
                :disabled="!connectionId || running"
                no-data-text="Sin esquemas"
                data-test="backup-schema"
                @update:model-value="onSchemaChange"
              />
            </v-col>
            <v-col cols="12">
              <v-autocomplete
                v-model="objects"
                :items="objectItems"
                :loading="objectsLoading"
                :disabled="!schema || running"
                label="Objetos"
                hint="Vacío = todos los objetos del esquema"
                persistent-hint
                multiple
                chips
                closable-chips
                clearable
                no-data-text="Sin objetos"
              />
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field
                v-model="label"
                label="Etiqueta"
                prepend-inner-icon="mdi-tag-outline"
                placeholder="p. ej. antes-migracion"
                :disabled="running"
                hint="Se añade al nombre del archivo"
                persistent-hint
              />
            </v-col>
            <v-col cols="12" sm="6" class="d-flex align-center">
              <v-checkbox
                v-model="includeData"
                label="Incluir datos"
                hide-details
                density="compact"
                :disabled="running"
                data-test="backup-include-data"
              />
            </v-col>
            <template v-if="isSql">
              <v-col cols="12" sm="6">
                <v-checkbox
                  v-model="includeStructure"
                  label="Incluir estructura (CREATE TABLE…)"
                  hide-details
                  density="compact"
                  :disabled="running"
                  data-test="backup-include-structure"
                />
              </v-col>
              <v-col cols="12" sm="6">
                <v-checkbox
                  v-model="includeCreateDatabase"
                  label="Incluir CREATE DATABASE"
                  hide-details
                  density="compact"
                  :disabled="running"
                  data-test="backup-create-database"
                />
              </v-col>
              <v-col cols="12" sm="6">
                <v-checkbox
                  v-model="gzip"
                  label="Comprimir (.sql.gz)"
                  hide-details
                  density="compact"
                  :disabled="running"
                  data-test="backup-gzip"
                />
              </v-col>
              <v-col v-if="!includeStructure && !includeData" cols="12">
                <p class="backup-dialog__warn" data-test="backup-nothing">
                  Elige incluir la estructura, los datos o ambos.
                </p>
              </v-col>
            </template>
            <v-col v-if="!isSql" cols="12">
              <v-textarea
                v-model="comment"
                label="Comentario"
                rows="2"
                auto-grow
                density="compact"
                variant="outlined"
                hide-details
                :disabled="running"
              />
            </v-col>
            <v-col cols="12">
              <PathPicker
                v-model="targetDir"
                v-path-tail="targetDir"
                :title="targetDir || undefined"
                class="nd-path-field"
                kind="directory"
                label="Carpeta de destino (opcional)"
                :hint="
                  connection?.backupDir
                    ? `Por defecto: ${connection.backupDir}/<esquema>`
                    : 'Por defecto: carpeta de copias de la conexión'
                "
                :disabled="running"
              />
            </v-col>
          </v-row>
          <OperationProgress
            v-if="running"
            class="mt-4"
            :operation-id="operationId"
            :label="isSql ? `Exportando ${schema} a .sql…` : `Creando copia de ${schema}…`"
            :cancelling="cancelling"
            @cancel="cancel"
          />
        </template>
        <template v-else>
          <v-alert
            type="success"
            icon="mdi-check-decagram-outline"
            class="backup-dialog__result"
            data-test="backup-result"
          >
            <div class="font-weight-medium">
              {{ isSql ? 'Exportación creada correctamente' : 'Copia creada correctamente' }}
            </div>
            <div class="backup-dialog__path nd-mono nd-ellipsis" :title="result.path">
              {{ result.path }}
            </div>
            <div class="backup-dialog__stats">
              <span
                ><strong class="nd-mono">{{ formatBytes(result.sizeBytes) }}</strong></span
              >
              <span
                ><strong class="nd-mono">{{ formatNumber(result.objects) }}</strong> objetos</span
              >
              <span
                ><strong class="nd-mono">{{ formatNumber(result.rows) }}</strong> filas</span
              >
              <span
                ><strong class="nd-mono">{{ formatDuration(result.durationMs) }}</strong></span
              >
            </div>
          </v-alert>
        </template>
        <v-alert
          v-if="error"
          type="error"
          variant="tonal"
          density="compact"
          class="mt-3"
          data-test="backup-error"
          >{{ error }}</v-alert
        >
      </v-card-text>
      <v-card-actions>
        <v-btn
          v-if="result"
          prepend-icon="mdi-folder-open-outline"
          data-test="backup-reveal"
          @click="revealInFinder(result.path)"
          >Mostrar en Finder</v-btn
        >
        <v-spacer />
        <v-btn :disabled="running" @click="open = false">{{
          result ? 'Cerrar' : 'Cancelar'
        }}</v-btn>
        <v-btn
          v-if="!result"
          color="primary"
          variant="flat"
          prepend-icon="mdi-archive-arrow-down-outline"
          :disabled="!canStart"
          :loading="running"
          data-test="backup-start"
          @click="start"
        >
          {{ isSql ? 'Exportar' : 'Iniciar copia' }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.backup-dialog__body {
  padding-top: 4px !important;
}
.backup-dialog__format {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  margin-bottom: 12px;
}
.backup-dialog__format-label {
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.backup-dialog__format-hint {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.backup-dialog__warn {
  margin: 0;
  font-size: var(--nd-fs-xs);
  color: rgb(var(--v-theme-error));
}
.backup-dialog__path {
  margin-top: 2px;
  font-size: var(--nd-fs-xs);
  opacity: 0.9;
}
.backup-dialog__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin-top: 6px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.backup-dialog__stats strong {
  color: var(--nd-text);
  font-weight: 600;
}
</style>
