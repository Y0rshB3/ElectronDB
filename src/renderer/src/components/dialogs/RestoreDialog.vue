<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { BackupFile, BackupMeta, RestoreResult } from '@shared/types'
import { fileNameOf, structureOnlySummary } from '@shared/jobLog'
import { SAFETY_BACKUP_LABEL } from '@shared/restoreTask'
import { api, newOperationId } from '@renderer/api'
import { useConfirm } from '@renderer/composables/useConfirm'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useBackupsStore } from '@renderer/stores/backups'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useSettingsStore } from '@renderer/stores/settings'
import { useTreeStore } from '@renderer/stores/tree'
import { useUiStore } from '@renderer/stores/ui'
import { formatBytes, formatDate, formatDuration, formatNumber } from '@renderer/utils/format'
import OperationProgress from '@renderer/components/backups/OperationProgress.vue'
import SourcePill from '@renderer/components/backups/SourcePill.vue'
import {
  backupObjectName,
  environmentLabel,
  environmentPillClass,
  findLocalConnection,
  restoreTargets
} from '@renderer/components/backups/backupHelpers'
import BackupPasswordPrompt from '@renderer/components/backups/BackupPasswordPrompt.vue'
import ReplaceContentToggle from '@renderer/components/backups/ReplaceContentToggle.vue'
import { replaceContentNotice } from '@renderer/components/backups/replaceContent'
import DialogHeader from './DialogHeader.vue'
import { useSchemaLoader } from '@renderer/components/backups/useSchemaLoader'

const ui = useUiStore()
const connections = useConnectionsStore()
const settings = useSettingsStore()
const backups = useBackupsStore()
const tree = useTreeStore()
const notify = useNotify()
const schemaLoader = useSchemaLoader()
const { ask } = useConfirm()

/** Safety copies taken before a database was replaced ("…-previo-rollback[-N].nb3"). */
function isSafetyCopy(file: BackupFile | null): boolean {
  return !!file?.label && file.label.startsWith(SAFETY_BACKUP_LABEL)
}

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
/** «Reemplazar la base de datos completa»: DROP + CREATE, then every object of the copy. */
const replaceMode = ref(false)
const safetyBackup = ref(true)
/** Replace «Contenido»: true = «Estructura y datos» (default), false = «Solo estructura». */
const replaceIncludeData = ref(true)

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

/** Encrypted .vqb read without its password: objects and engine unknown until it is typed. */
const locked = computed(() => meta.value?.locked === true)
const encrypted = computed(() => meta.value?.encrypted === true || backup.value?.encrypted === true)
/** Same engine only: a .nb3 or MySQL .vqb into MySQL, a PostgreSQL .vqb into PostgreSQL. */
const candidates = computed(() => restoreTargets(connections.sorted, meta.value, backup.value))
const connectionItems = computed(() =>
  candidates.value.map((c) => ({
    title: c.name,
    value: c.id,
    subtitle: environmentLabel(c.environment),
    pill: environmentPillClass(c.environment)
  }))
)
const target = computed(() =>
  targetConnectionId.value ? connections.get(targetConnectionId.value) : undefined
)
const targetIsPg = computed(() => target.value?.engine === 'postgresql')
const schemaWord = computed(() =>
  targetIsPg.value || meta.value?.engine === 'postgresql' ? 'Base de datos' : 'Esquema'
)
/** Production, and the environments chosen in Ajustes › Seguridad, need the typed name. */
const needsTyped = computed(() => settings.needsTypedConfirm(target.value?.environment))
const typedTitle = computed(() =>
  target.value?.environment === 'production'
    ? 'Destino de PRODUCCIÓN'
    : `Destino de entorno ${target.value ? environmentLabel(target.value.environment).toUpperCase() : ''} · requiere confirmación`
)
const productionConfirmed = computed(
  () => !needsTyped.value || typedName.value.trim() === target.value?.name
)
const objectItems = computed(() =>
  (meta.value?.objects ?? []).map((o) => ({
    title: backupObjectName(o),
    value: backupObjectName(o),
    subtitle: o.type
  }))
)
const safetyCopy = computed(() => isSafetyCopy(backup.value))
const canRestore = computed(
  () =>
    !!backup.value &&
    !!target.value &&
    !locked.value &&
    !!targetSchema.value.trim() &&
    (replaceMode.value || includeStructure.value || includeData.value) &&
    productionConfirmed.value &&
    !running.value
)

function defaultTarget(): string | null {
  const preferred = ui.restoreDialog.connectionId
  const backupable = candidates.value
  if (preferred && backupable.some((c) => c.id === preferred)) return preferred
  // A safety copy goes back to the connection it was taken from.
  const own = backup.value?.connectionId
  if (isSafetyCopy(backup.value) && own && backupable.some((c) => c.id === own)) return own
  return findLocalConnection(backupable)?.id ?? own ?? null
}

async function loadMeta(): Promise<void> {
  meta.value = null
  if (!backup.value) return
  metaLoading.value = true
  try {
    meta.value = await backups.meta(backup.value.path)
    afterMeta()
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    metaLoading.value = false
  }
}

/** Fills what the manifest tells (schema; a target of the right engine). */
function afterMeta(): void {
  if (!meta.value) return
  if (!targetSchema.value && meta.value.schema) targetSchema.value = meta.value.schema
  if (targetConnectionId.value && !candidates.value.some((c) => c.id === targetConnectionId.value))
    onTargetChange(defaultTarget())
  else if (!targetConnectionId.value) onTargetChange(defaultTarget())
}

function onUnlocked(unlocked: BackupMeta): void {
  meta.value = unlocked
  error.value = ''
  afterMeta()
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
  replaceMode.value = ui.restoreDialog.replace === true || isSafetyCopy(backup.value)
  safetyBackup.value = true
  replaceIncludeData.value = true
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
  // Guarded targets already asked for the typed name inline; anything else confirms the DROP here.
  if (replaceMode.value && !needsTyped.value) {
    const ok = await ask({
      title: `Reemplazar «${targetSchema.value.trim()}»`,
      message: [
        replaceIncludeData.value
          ? `«${targetSchema.value.trim()}» se borrará en «${target.value.name}» y se creará de nuevo con todo lo que contiene ${backup.value.fileName}. Lo que no esté en la copia desaparece.`
          : `«${targetSchema.value.trim()}» se borrará en «${target.value.name}» y se creará de nuevo con la estructura de ${backup.value.fileName}. Lo que no esté en la copia desaparece.`,
        replaceContentNotice(replaceIncludeData.value),
        safetyBackup.value
          ? 'Antes se guarda una copia previa (etiqueta «previo-rollback»).'
          : 'SIN copia previa: los datos actuales se perderán.'
      ]
        .filter(Boolean)
        .join('\n\n'),
      confirmText: 'Reemplazar',
      color: 'warning'
    })
    if (!ok) return
  }
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
      includeData: replaceMode.value ? replaceIncludeData.value : includeData.value,
      objects: !replaceMode.value && objects.value.length ? [...objects.value] : undefined,
      continueOnError: continueOnError.value,
      ...(encrypted.value && backups.passwordOf(backup.value.path)
        ? { password: backups.passwordOf(backup.value.path) }
        : {}),
      ...(replaceMode.value ? { replaceSchema: true, safetyBackup: safetyBackup.value } : {}),
      ...(needsTyped.value ? { confirmProduction: true } : {})
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
  if (replaceMode.value) {
    const ok = await ask({
      title: '¿Detener la restauración?',
      message: `Si cancelas ahora, «${targetSchema.value.trim()}» puede quedar borrada o restaurada solo en parte.${result.value === null && safetyBackup.value ? ' Su copia previa (etiqueta «previo-rollback») permite volver al estado anterior.' : ''}`,
      confirmText: 'Detener',
      color: 'error'
    })
    if (!ok || !operationId.value) return
  }
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
      :class="{ 'nd-danger-card': needsTyped && !result }"
    >
      <DialogHeader
        icon="mdi-backup-restore"
        title="Restaurar copia de seguridad"
        :subtitle="target ? `Destino: ${target.name}` : undefined"
        :danger="needsTyped"
      >
        <span v-if="target" class="nd-pill" :class="environmentPillClass(target.environment)">{{
          environmentLabel(target.environment)
        }}</span>
      </DialogHeader>
      <v-card-text v-if="backup" class="restore-dialog__body">
        <div class="restore-dialog__file" data-test="restore-backup-info">
          <v-icon
            :icon="encrypted ? 'mdi-archive-lock-outline' : 'mdi-archive-outline'"
            size="20"
            class="restore-dialog__file-icon"
          />
          <div class="restore-dialog__file-text">
            <div class="restore-dialog__file-name nd-ellipsis" :title="backup.path">
              {{ backup.fileName }}
            </div>
            <div class="restore-dialog__file-meta">
              <span
                >{{ meta?.engine === 'postgresql' ? 'Base de datos' : 'Esquema' }}
                <span class="nd-mono">{{ meta?.schema || backup.schema || '—' }}</span></span
              >
              <span class="restore-dialog__sep">·</span>
              <span class="nd-mono">{{
                (meta?.format ?? backup.format) === 'vqb' ? '.vqb' : '.nb3'
              }}</span>
              <template v-if="backup.createdAt">
                <span class="restore-dialog__sep">·</span>
                <span class="nd-mono">{{ formatDate(backup.createdAt) }}</span>
              </template>
              <template v-if="backup.sizeBytes">
                <span class="restore-dialog__sep">·</span>
                <span class="nd-mono">{{ formatBytes(backup.sizeBytes) }}</span>
              </template>
              <span v-if="backup.connectionId" class="restore-dialog__sep">·</span>
              <span v-if="backup.connectionId" class="nd-ellipsis"
                >origen: {{ connections.nameOf(backup.connectionId) }}</span
              >
            </div>
          </div>
          <SourcePill :source="backup.source" />
        </div>

        <template v-if="!result">
          <BackupPasswordPrompt
            v-if="locked"
            :path="backup.path"
            message="Copia cifrada: escribe su contraseña para restaurarla. Se comprueba antes de tocar el destino."
            :disabled="running"
            class="mb-3"
            @unlocked="onUnlocked"
          />
          <v-alert
            v-if="safetyCopy"
            type="info"
            variant="tonal"
            density="compact"
            icon="mdi-undo-variant"
            class="mb-3"
            data-test="restore-safety-copy-info"
          >
            Esta es la copia previa de una restauración. Para deshacerla, usa «Reemplazar la base de
            datos completa» sobre la misma base de datos: quedará exactamente como estaba.
          </v-alert>
          <v-btn-toggle
            v-model="replaceMode"
            mandatory
            divided
            density="compact"
            variant="outlined"
            class="restore-dialog__mode mb-3"
            :disabled="running"
            data-test="restore-mode"
          >
            <v-btn
              :value="false"
              prepend-icon="mdi-format-list-checks"
              data-test="restore-mode-objects"
              >Restaurar objetos</v-btn
            >
            <v-btn
              :value="true"
              prepend-icon="mdi-database-sync-outline"
              data-test="restore-mode-replace"
              >Reemplazar la base de datos completa</v-btn
            >
          </v-btn-toggle>
          <v-autocomplete
            v-if="!replaceMode"
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
                :label="`${schemaWord} de destino`"
                :disabled="running"
                data-test="restore-target-schema"
              />
            </v-col>
          </v-row>
          <div class="nd-section-title restore-dialog__options-title">Opciones</div>
          <ReplaceContentToggle
            v-if="replaceMode"
            v-model="replaceIncludeData"
            :disabled="running"
            class="mb-2"
          />
          <div
            v-if="replaceMode"
            class="restore-dialog__options"
            data-test="restore-replace-options"
          >
            <v-checkbox
              v-model="safetyBackup"
              label="Copia de seguridad previa"
              density="compact"
              hide-details
              :disabled="running"
              data-test="restore-replace-safety"
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
            v-if="replaceMode"
            type="warning"
            variant="tonal"
            density="compact"
            class="mt-2"
            data-test="restore-replace-warning"
          >
            «{{ targetSchema || '?' }}» se borra en {{ target?.name ?? 'el destino' }} y se crea de
            nuevo con
            {{ replaceIncludeData ? 'todo lo que hay en la copia' : 'la estructura de la copia' }}:
            lo que no esté en la copia desaparece.
            <template v-if="!replaceIncludeData">{{ replaceContentNotice(false) }}</template>
            {{
              safetyBackup
                ? 'Antes se guarda una copia previa; si falla, no se toca nada.'
                : 'Sin copia previa, los datos actuales se perderán.'
            }}
          </v-alert>
          <div v-else class="restore-dialog__options">
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
            v-if="!replaceMode && !includeStructure && !includeData"
            type="warning"
            variant="tonal"
            density="compact"
            class="mt-2"
          >
            Selecciona al menos estructura o datos.
          </v-alert>

          <v-alert
            v-if="needsTyped"
            type="error"
            icon="mdi-shield-alert-outline"
            class="restore-dialog__danger mt-3"
            data-test="restore-production-warning"
          >
            <div class="restore-dialog__danger-title">{{ typedTitle }}</div>
            <div class="text-body-2">
              Vas a sobrescribir objetos en «{{ target?.name }}». Esta acción no se puede deshacer.
              Escribe el nombre de la conexión para habilitar «Restaurar».
              <template v-if="replaceMode && !replaceIncludeData">
                {{ replaceContentNotice(false) }}
              </template>
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
            <div v-if="result.structureOnly" class="text-caption" data-test="restore-result-mode">
              {{ structureOnlySummary(result.objectsRestored) }} ·
              <span class="nd-mono">{{ formatDuration(result.durationMs) }}</span>
            </div>
            <div v-else class="text-caption">
              <span class="nd-mono">{{ formatNumber(result.objectsRestored) }}</span> objetos ·
              <span class="nd-mono">{{ formatNumber(result.rowsInserted) }}</span> filas insertadas
              · <span class="nd-mono">{{ formatDuration(result.durationMs) }}</span>
            </div>
            <div
              v-if="result.safetyBackupPath"
              class="text-caption"
              :title="result.safetyBackupPath"
              data-test="restore-result-safety"
            >
              Copia previa: {{ fileNameOf(result.safetyBackupPath) }} (para volver atrás, restáurala
              con «Reemplazar la base de datos completa»)
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
          :color="needsTyped ? 'error' : 'primary'"
          variant="flat"
          :prepend-icon="needsTyped ? 'mdi-shield-alert-outline' : 'mdi-backup-restore'"
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
.restore-dialog__mode {
  width: 100%;
}
.restore-dialog__mode :deep(.v-btn) {
  flex: 1 1 0;
  text-transform: none;
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
