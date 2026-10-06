<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { BackupMeta, RestoreResult } from '@shared/types'
import { api, newOperationId } from '@renderer/api'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useBackupsStore } from '@renderer/stores/backups'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useTreeStore } from '@renderer/stores/tree'
import { useUiStore } from '@renderer/stores/ui'
import { formatBytes, formatDate, formatDuration, formatNumber } from '@renderer/utils/format'
import OperationProgress from '@renderer/components/backups/OperationProgress.vue'
import SourcePill from '@renderer/components/backups/SourcePill.vue'
import {
  environmentLabel,
  environmentPillClass,
  findLocalConnection
} from '@renderer/components/backups/backupHelpers'
import DialogHeader from './DialogHeader.vue'
import { useSchemaLoader } from '@renderer/components/backups/useSchemaLoader'

const ui = useUiStore()
const connections = useConnectionsStore()
const backups = useBackupsStore()
const tree = useTreeStore()
const notify = useNotify()
const schemaLoader = useSchemaLoader()

const meta = ref<BackupMeta | null>(null)
const metaLoading = ref(false)
const objects = ref<string[]>([])
const targetConnectionId = ref<string | null>(null)
const targetSchema = ref('')
const createSchema = ref(true)
const dropObjectsFirst = ref(true)
const includeStructure = ref(true)
const includeData = ref(true)
const continueOnError = ref(false)
const typedName = ref('')

const operationId = ref<string | null>(null)
const running = ref(false)
const cancelling = ref(false)
const error = ref('')
const result = ref<RestoreResult | null>(null)

const backup = computed(() => ui.restoreDialog.backup)
const open = computed({
  get: () => ui.restoreDialog.open,
  set: (value: boolean) => {
    if (!value && running.value) return
    ui.restoreDialog = { ...ui.restoreDialog, open: value }
  }
})

const connectionItems = computed(() =>
  connections.sorted.map((c) => ({
    title: c.name,
    value: c.id,
    subtitle: environmentLabel(c.environment),
    pill: environmentPillClass(c.environment)
  }))
)
const target = computed(() =>
  targetConnectionId.value ? connections.get(targetConnectionId.value) : undefined
)
const isProduction = computed(() => target.value?.environment === 'production')
const productionConfirmed = computed(
  () => !isProduction.value || typedName.value.trim() === target.value?.name
)
const objectItems = computed(() =>
  (meta.value?.objects ?? []).map((o) => ({ title: o.name, value: o.name, subtitle: o.type }))
)
const canRestore = computed(
  () =>
    !!backup.value &&
    !!target.value &&
    !!targetSchema.value.trim() &&
    (includeStructure.value || includeData.value) &&
    productionConfirmed.value &&
    !running.value
)

function defaultTarget(): string | null {
  const preferred = ui.restoreDialog.connectionId
  if (preferred && connections.get(preferred)) return preferred
  return findLocalConnection(connections.sorted)?.id ?? backup.value?.connectionId ?? null
}

async function loadMeta(): Promise<void> {
  meta.value = null
  if (!backup.value) return
  metaLoading.value = true
  try {
    meta.value = await backups.meta(backup.value.path)
    if (!targetSchema.value && meta.value.schema) targetSchema.value = meta.value.schema
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    metaLoading.value = false
  }
}

function reset(): void {
  objects.value = []
  targetConnectionId.value = defaultTarget()
  targetSchema.value = backup.value?.schema ?? ''
  createSchema.value = true
  dropObjectsFirst.value = true
  includeStructure.value = true
  includeData.value = true
  continueOnError.value = false
  typedName.value = ''
  operationId.value = null
  error.value = ''
  result.value = null
  cancelling.value = false
}

watch(
  () => ui.restoreDialog.open,
  (value) => {
    if (!value) return
    reset()
    void loadMeta()
    if (targetConnectionId.value) void schemaLoader.load(targetConnectionId.value)
  },
  { immediate: true }
)

function onTargetChange(id: string | null): void {
  targetConnectionId.value = id
  typedName.value = ''
  if (id) void schemaLoader.load(id)
}

async function restore(): Promise<void> {
  if (!canRestore.value || !backup.value || !target.value) return
  const cid = target.value.id
  const opId = newOperationId('restore')
  operationId.value = opId
  running.value = true
  error.value = ''
  result.value = null
  try {
    // Silent invoke: failures are shown inline below, not also in the global snackbar.
    result.value = await api.invokeSilent('backups:restore', opId, {
      backupPath: backup.value.path,
      connectionId: cid,
      targetSchema: targetSchema.value.trim(),
      createSchema: createSchema.value,
      dropObjectsFirst: dropObjectsFirst.value,
      includeStructure: includeStructure.value,
      includeData: includeData.value,
      objects: objects.value.length ? [...objects.value] : undefined,
      continueOnError: continueOnError.value,
      ...(isProduction.value ? { confirmProduction: true } : {})
    })
    const errors = result.value.errors.length
    if (errors) notify.warning(`Restauración terminada con ${errors} error(es)`)
    else notify.success(`Restaurado en ${target.value.name} · ${targetSchema.value}`)
    if (connections.isOpen(cid)) void tree.loadDatabases(cid, true).catch(() => undefined)
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
</script>

<template>
  <v-dialog v-model="open" max-width="720" :persistent="running" scrollable>
    <v-card
      data-test="restore-dialog"
      class="restore-dialog"
      :class="{ 'nd-danger-card': isProduction && !result }"
    >
      <DialogHeader
        icon="mdi-backup-restore"
        title="Restaurar copia de seguridad"
        :subtitle="target ? `Destino: ${target.name}` : undefined"
        :danger="isProduction"
      >
        <span v-if="target" class="nd-pill" :class="environmentPillClass(target.environment)">{{
          environmentLabel(target.environment)
        }}</span>
      </DialogHeader>
      <v-card-text v-if="backup" class="restore-dialog__body">
        <div class="restore-dialog__file" data-test="restore-backup-info">
          <v-icon icon="mdi-archive-outline" size="20" class="restore-dialog__file-icon" />
          <div class="restore-dialog__file-text">
            <div class="restore-dialog__file-name nd-ellipsis" :title="backup.path">
              {{ backup.fileName }}
            </div>
            <div class="restore-dialog__file-meta">
              <span
                >Esquema
                <span class="nd-mono">{{ meta?.schema ?? backup.schema ?? '—' }}</span></span
              >
              <span class="restore-dialog__sep">·</span>
              <span class="nd-mono">{{ formatDate(backup.createdAt) }}</span>
              <span class="restore-dialog__sep">·</span>
              <span class="nd-mono">{{ formatBytes(backup.sizeBytes) }}</span>
              <span v-if="backup.connectionId" class="restore-dialog__sep">·</span>
              <span v-if="backup.connectionId" class="nd-ellipsis"
                >origen: {{ connections.nameOf(backup.connectionId) }}</span
              >
            </div>
          </div>
          <SourcePill :source="backup.source" />
        </div>

        <template v-if="!result">
          <v-autocomplete
            v-model="objects"
            :items="objectItems"
            :loading="metaLoading"
            label="Objetos a restaurar"
            hint="Vacío = todos los objetos de la copia"
            persistent-hint
            multiple
            chips
            closable-chips
            clearable
            :disabled="running"
            class="mb-3"
            no-data-text="Sin objetos"
          />
          <v-row dense>
            <v-col cols="12" sm="6">
              <v-select
                :model-value="targetConnectionId"
                :items="connectionItems"
                label="Conexión de destino"
                :disabled="running"
                data-test="restore-target-connection"
                @update:model-value="onTargetChange"
              >
                <template #item="{ props: itemProps, item }">
                  <v-list-item v-bind="itemProps">
                    <template #append>
                      <span class="nd-pill" :class="item.raw.pill">{{ item.raw.subtitle }}</span>
                    </template>
                  </v-list-item>
                </template>
              </v-select>
            </v-col>
            <v-col cols="12" sm="6">
              <v-combobox
                v-model="targetSchema"
                :items="schemaLoader.of(targetConnectionId)"
                :loading="schemaLoader.isLoading(targetConnectionId)"
                label="Esquema de destino"
                :disabled="running"
                data-test="restore-target-schema"
              />
            </v-col>
          </v-row>
          <div class="nd-section-title restore-dialog__options-title">Opciones</div>
          <div class="restore-dialog__options">
            <v-checkbox
              v-model="createSchema"
              label="Crear si no existe"
              density="compact"
              hide-details
              :disabled="running"
            />
            <v-checkbox
              v-model="dropObjectsFirst"
              label="Eliminar objetos antes de crearlos"
              density="compact"
              hide-details
              :disabled="running"
            />
            <v-checkbox
              v-model="includeStructure"
              label="Estructura"
              density="compact"
              hide-details
              :disabled="running"
            />
            <v-checkbox
              v-model="includeData"
              label="Datos"
              density="compact"
              hide-details
              :disabled="running"
            />
            <v-checkbox
              v-model="continueOnError"
              label="Continuar en caso de error"
              density="compact"
              hide-details
              :disabled="running"
            />
          </div>
          <v-alert
            v-if="!includeStructure && !includeData"
            type="warning"
            variant="tonal"
            density="compact"
            class="mt-2"
          >
            Selecciona al menos estructura o datos.
          </v-alert>

          <v-alert
            v-if="isProduction"
            type="error"
            icon="mdi-shield-alert-outline"
            class="restore-dialog__danger mt-3"
            data-test="restore-production-warning"
          >
            <div class="restore-dialog__danger-title">Destino de PRODUCCIÓN</div>
            <div class="text-body-2">
              Vas a sobrescribir objetos en «{{ target?.name }}». Esta acción no se puede deshacer.
              Escribe el nombre de la conexión para habilitar «Restaurar».
            </div>
            <v-text-field
              v-model="typedName"
              :label="`Escribe «${target?.name}» para confirmar`"
              autocomplete="off"
              class="restore-dialog__confirm mt-2"
              :disabled="running"
              data-test="restore-confirm-name"
            />
          </v-alert>

          <OperationProgress
            v-if="running"
            class="mt-4"
            :operation-id="operationId"
            :label="`Restaurando en ${target?.name ?? ''} · ${targetSchema}…`"
            :cancelling="cancelling"
            @cancel="cancel"
          />
        </template>

        <template v-else>
          <v-alert
            :type="result.errors.length ? 'warning' : 'success'"
            variant="tonal"
            data-test="restore-result"
          >
            <div class="font-weight-medium">
              {{
                result.errors.length
                  ? 'Restauración terminada con errores'
                  : 'Restauración completada'
              }}
            </div>
            <div class="text-caption">
              <span class="nd-mono">{{ formatNumber(result.objectsRestored) }}</span> objetos ·
              <span class="nd-mono">{{ formatNumber(result.rowsInserted) }}</span> filas insertadas
              · <span class="nd-mono">{{ formatDuration(result.durationMs) }}</span>
            </div>
          </v-alert>
          <v-table
            v-if="result.errors.length"
            density="compact"
            class="restore-dialog__errors mt-2"
          >
            <thead>
              <tr>
                <th>Objeto</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(e, i) in result.errors" :key="i">
                <td>{{ e.object }}</td>
                <td class="text-caption text-error">{{ e.message }}</td>
              </tr>
            </tbody>
          </v-table>
        </template>

        <v-alert
          v-if="error"
          type="error"
          variant="tonal"
          density="compact"
          class="mt-3"
          data-test="restore-error"
          >{{ error }}</v-alert
        >
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn :disabled="running" @click="open = false">{{
          result ? 'Cerrar' : 'Cancelar'
        }}</v-btn>
        <v-btn
          v-if="!result"
          :color="isProduction ? 'error' : 'primary'"
          variant="flat"
          :prepend-icon="isProduction ? 'mdi-shield-alert-outline' : 'mdi-backup-restore'"
          :disabled="!canRestore"
          :loading="running"
          data-test="restore-submit"
          @click="restore"
        >
          Restaurar
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.restore-dialog__body {
  padding-top: 4px !important;
}
.restore-dialog__file {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
  padding: 10px 14px;
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border);
}
.restore-dialog__file-icon {
  flex: none;
  color: var(--nd-text-2);
}
.restore-dialog__file-text {
  flex: 1;
  min-width: 0;
}
.restore-dialog__file-name {
  font-weight: 600;
}
.restore-dialog__file-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  white-space: nowrap;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.restore-dialog__sep {
  color: var(--nd-text-muted);
}
.restore-dialog__options-title {
  margin-top: 14px;
  margin-bottom: 4px;
}
.restore-dialog__options {
  display: flex;
  flex-wrap: wrap;
  gap: 0 18px;
  padding: 6px 10px;
  border-radius: var(--nd-radius-control);
  background: var(--nd-bg-input);
  border: 1px solid var(--nd-hairline);
}
.restore-dialog__danger {
  box-shadow: 0 0 22px color-mix(in srgb, var(--nd-error) 18%, transparent);
}
.restore-dialog__danger-title {
  font-weight: 700;
  margin-bottom: 2px;
}
.restore-dialog__confirm :deep(input) {
  font-family: var(--nd-font-mono);
}
.restore-dialog__errors {
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-card);
  overflow: hidden;
}
</style>
