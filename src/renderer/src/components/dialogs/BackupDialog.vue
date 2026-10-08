<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { BackupFormat } from '@shared/importers'
import type { BackupCreateResult } from '@shared/types'
import { api, newOperationId } from '@renderer/api'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useBackupsStore } from '@renderer/stores/backups'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useSettingsStore } from '@renderer/stores/settings'
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
const settings = useSettingsStore()
const notify = useNotify()
const schemaLoader = useSchemaLoader()

const connectionId = ref<string | null>(null)
const schema = ref<string | null>(null)
const objects = ref<string[]>([])
const objectItems = ref<{ title: string; value: string; subtitle: string }[]>([])
const objectsLoading = ref(false)
const includeData = ref(true)
/**
 * .vqb (Vortaq's open format, default), .nb3 (Navicat) or plain .sql for other managers.
 * SQLite: .vqb or 'file', a copy of the database file itself (VACUUM INTO).
 */
const format = ref<BackupFormat | 'file'>('vqb')
/** «Cifrar con contraseña» (.vqb only). */
const encrypt = ref(false)
const password = ref('')
const passwordAgain = ref('')
const showPassword = ref(false)
/** Record the connection name in the .vqb manifest. */
const recordConnectionName = ref(true)
const MIN_PASSWORD = 8
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
const isVqb = computed(() => format.value === 'vqb')
/** SQLite «Copia del archivo» (VACUUM INTO). */
const isFile = computed(() => format.value === 'file')

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
/** PostgreSQL: whole-database .vqb backups only. */
const isPg = computed(() => connection.value?.engine === 'postgresql')
/** SQLite: whole-database .vqb backups, or a copy of the file (VACUUM INTO). */
const isSqlite = computed(() => connection.value?.engine === 'sqlite')
/** MongoDB: .vqb only, with an optional pick of collections and views. */
const isMongo = computed(() => connection.value?.engine === 'mongodb')
/** No object picker: the copy always holds the whole database. */
const wholeDatabase = computed(() => isPg.value || isSqlite.value)
/** Only .vqb is offered (no .nb3 / .sql). */
const vqbOnly = computed(() => wholeDatabase.value || isMongo.value)
const passwordProblem = computed(() => {
  if (!isVqb.value || !encrypt.value) return ''
  if (password.value.length < MIN_PASSWORD)
    return `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`
  if (passwordAgain.value !== password.value) return 'Las contraseñas no coinciden.'
  return ''
})
const canStart = computed(
  () =>
    !!connectionId.value &&
    !!schema.value &&
    !running.value &&
    (!isFile.value || schema.value === 'main') &&
    (!isSql.value || includeStructure.value || includeData.value) &&
    !passwordProblem.value
)
const subtitle = computed(() =>
  isFile.value
    ? 'Copia exacta del archivo SQLite (VACUUM INTO), lista para abrir'
    : isSql.value
      ? 'Archivo .sql que el cliente mysql y otros gestores pueden importar'
      : isVqb.value
        ? 'Archivo .vqb: formato abierto de Vortaq, con cifrado opcional'
        : 'Archivo .nb3 compatible con Navicat'
)
const formatHint = computed(() =>
  isFile.value
    ? 'La forma más rápida: un archivo .db consistente (incluye lo pendiente del WAL). Solo la base de datos principal.'
    : isSql.value
      ? 'Para llevar la copia a otros gestores; Vortaq la importa con «Importar…».'
      : isVqb.value
        ? isPg.value
          ? 'Las copias de PostgreSQL son siempre .vqb e incluyen la base de datos completa.'
          : isMongo.value
            ? 'Las copias de MongoDB son siempre .vqb: documentos en Extended JSON canónico (tipos BSON intactos), índices, validadores y vistas.'
            : isSqlite.value
              ? 'Copia .vqb de la base de datos completa, con el tipo de cada celda; restaurable en un archivo nuevo o sobre la conexión.'
              : 'Formato abierto y documentado; restaurable desde Copias de seguridad y tareas.'
        : 'Copia restaurable desde Copias de seguridad y tareas, legible por Navicat.'
)

/** Format the dialog opens with: the one asked for, else Ajustes' default (PostgreSQL: .vqb). */
function initialFormat(): BackupFormat {
  if (isPg.value || isSqlite.value || isMongo.value) return 'vqb'
  const asked = ui.backupDialog.format ?? settings.settings.defaultBackupFormat ?? 'vqb'
  return asked === 'sql' || asked === 'nb3' ? asked : 'vqb'
}

watch(format, (value) => {
  if (value !== 'vqb') encrypt.value = false
})

function reset(): void {
  connectionId.value = ui.backupDialog.connectionId
  schema.value = ui.backupDialog.schema
  objects.value = []
  includeData.value = true
  format.value = initialFormat()
  encrypt.value = false
  password.value = ''
  passwordAgain.value = ''
  showPassword.value = false
  recordConnectionName.value = true
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

/**
 * MariaDB servers only (P1b): a .nb3 leaves out system-versioned tables and
 * sequences, so the dialog names them before the copy starts. MySQL servers
 * never ask (the connection's runtime flavour comes from connections:open).
 */
const skippedWarning = ref<string | null>(null)
let skippedRequest = 0

async function loadSkippedWarning(): Promise<void> {
  const request = ++skippedRequest
  skippedWarning.value = null
  const cid = connectionId.value
  const db = schema.value
  if (!cid || !db || connections.serverInfo[cid]?.runtime?.flavor !== 'mariadb') return
  try {
    const warning = await api.invokeSilent('backups:skippedObjects', cid, db)
    if (request === skippedRequest) skippedWarning.value = warning
  } catch {
    // Best effort: the backup itself logs the same warning.
  }
}

async function loadObjects(): Promise<void> {
  const request = ++objectsRequest
  objectItems.value = []
  objects.value = []
  const cid = connectionId.value
  const db = schema.value
  // PostgreSQL and SQLite copy the whole database: no object picker.
  if (!cid || !db || wholeDatabase.value) {
    objectsLoading.value = false
    return
  }
  objectsLoading.value = true
  try {
    if (isMongo.value) {
      const collections = await api.invokeSilent('mongo:collections', cid, db)
      if (request !== objectsRequest) return
      objectItems.value = collections.map((c) => ({
        title: c.name,
        value: c.name,
        subtitle: c.type === 'view' ? 'Vista' : 'Colección'
      }))
      return
    }
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
    if (isFile.value) {
      await copyFile(cid)
      return
    }
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
      objects: !wholeDatabase.value && objects.value.length ? [...objects.value] : undefined,
      label: label.value.trim() || undefined,
      comment: comment.value.trim() || undefined,
      targetDir: targetDir.value.trim() || undefined,
      format: isVqb.value ? 'vqb' : 'nb3',
      ...(isVqb.value && encrypt.value ? { password: password.value } : {}),
      ...(isVqb.value && !recordConnectionName.value ? { omitConnectionName: true } : {})
    })
    password.value = ''
    passwordAgain.value = ''
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

/** «Copia del archivo»: VACUUM INTO a .db the user names (proposed in the backup folder). */
async function copyFile(cid: string): Promise<void> {
  const dir = targetDir.value.trim() || connection.value?.backupDir || ''
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const base = (label.value.trim() || connection.value?.name || 'copia').replace(
    /[\\/:*?"<>|]/g,
    '_'
  )
  const sep = dir.includes('\\') ? '\\' : '/'
  const name = `${base}-${stamp}.db`
  const path = await api.app.pickSaveFile(
    'Guardar la copia del archivo SQLite',
    dir ? `${dir.replace(/[\\/]$/, '')}${sep}${name}` : name,
    [{ name: 'Base de datos SQLite', extensions: ['db', 'sqlite', 'sqlite3'] }]
  )
  if (!path) return
  const copied = await api.invokeSilent('sqlite:copyFile', cid, path)
  result.value = {
    path: copied.path,
    sizeBytes: copied.sizeBytes,
    objects: 0,
    rows: 0,
    durationMs: copied.durationMs
  }
  notify.success(`Copia del archivo creada en ${copied.path}`, {
    label: 'Mostrar en Finder',
    handler: () => revealInFinder(copied.path)
  })
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
    void loadSkippedWarning()
  },
  { immediate: true }
)

function onConnectionChange(id: string | null): void {
  connectionId.value = id
  if (isPg.value || isMongo.value || (isSqlite.value && format.value !== 'file'))
    format.value = 'vqb'
  else if (format.value === 'file' && !isSqlite.value) format.value = 'vqb'
  schema.value = null
  objectItems.value = []
  objects.value = []
  skippedWarning.value = null
  if (id) void schemaLoader.load(id)
}

function onSchemaChange(value: string | null): void {
  schema.value = value
  void loadObjects()
  void loadSkippedWarning()
}
</script>

<template>
  <v-dialog v-model="open" max-width="640" :persistent="running">
    <v-card data-test="backup-dialog">
      <DialogHeader
        icon="mdi-archive-plus-outline"
        :title="isSql ? 'Exportar a .sql' : 'Nueva copia de seguridad'"
        :subtitle="subtitle"
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
              <v-btn value="vqb" size="small" data-test="backup-format-vqb">.vqb</v-btn>
              <v-btn v-if="!vqbOnly" value="nb3" size="small" data-test="backup-format-nb3"
                >.nb3</v-btn
              >
              <v-btn v-if="!vqbOnly" value="sql" size="small" data-test="backup-format-sql"
                >.sql</v-btn
              >
              <v-btn v-if="isSqlite" value="file" size="small" data-test="backup-format-file"
                >Copia del archivo (VACUUM INTO)</v-btn
              >
            </v-btn-toggle>
            <span class="backup-dialog__format-hint">{{ formatHint }}</span>
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
                :label="wholeDatabase || isMongo ? 'Base de datos' : 'Esquema'"
                prepend-inner-icon="mdi-database-outline"
                :disabled="!connectionId || running"
                no-data-text="Sin esquemas"
                data-test="backup-schema"
                @update:model-value="onSchemaChange"
              />
            </v-col>
            <v-col v-if="!wholeDatabase" cols="12">
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
            <v-col v-if="isFile && schema && schema !== 'main'" cols="12">
              <p class="backup-dialog__warn" data-test="backup-file-main-only">
                La copia del archivo solo se hace de la base de datos principal (main).
              </p>
            </v-col>
            <v-col v-if="!isFile" cols="12" sm="6" class="d-flex align-center">
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
            <template v-if="isVqb">
              <v-col cols="12" sm="6" class="d-flex align-center">
                <v-checkbox
                  v-model="encrypt"
                  label="Cifrar con contraseña"
                  hide-details
                  density="compact"
                  :disabled="running"
                  data-test="backup-encrypt"
                />
              </v-col>
              <v-col cols="12" sm="6" class="d-flex align-center">
                <v-checkbox
                  v-model="recordConnectionName"
                  label="Guardar el nombre de la conexión"
                  hide-details
                  density="compact"
                  :disabled="running"
                  data-test="backup-record-connection"
                />
              </v-col>
              <template v-if="encrypt">
                <v-col cols="12" sm="6">
                  <v-text-field
                    v-model="password"
                    :type="showPassword ? 'text' : 'password'"
                    label="Contraseña"
                    prepend-inner-icon="mdi-lock-outline"
                    :append-inner-icon="showPassword ? 'mdi-eye-off-outline' : 'mdi-eye-outline'"
                    autocomplete="new-password"
                    :disabled="running"
                    hide-details="auto"
                    data-test="backup-password"
                    @click:append-inner="showPassword = !showPassword"
                  />
                </v-col>
                <v-col cols="12" sm="6">
                  <v-text-field
                    v-model="passwordAgain"
                    :type="showPassword ? 'text' : 'password'"
                    label="Repite la contraseña"
                    prepend-inner-icon="mdi-lock-check-outline"
                    autocomplete="new-password"
                    :disabled="running"
                    :error-messages="passwordAgain && passwordProblem ? [passwordProblem] : []"
                    hide-details="auto"
                    data-test="backup-password-again"
                  />
                </v-col>
                <v-col cols="12">
                  <v-alert
                    type="warning"
                    variant="tonal"
                    density="compact"
                    icon="mdi-key-alert-outline"
                    data-test="backup-password-warning"
                  >
                    Si pierdes la contraseña, la copia no se puede recuperar: Vortaq no la guarda y
                    nadie puede descifrarla sin ella.
                  </v-alert>
                </v-col>
              </template>
            </template>
            <v-col v-if="!isSql && skippedWarning" cols="12">
              <v-alert
                type="warning"
                variant="tonal"
                density="compact"
                data-test="backup-skipped-warning"
                >{{ skippedWarning }}</v-alert
              >
            </v-col>
            <v-col v-if="!isSql && !isFile" cols="12">
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
              {{
                isFile
                  ? 'Copia del archivo creada correctamente'
                  : isSql
                    ? 'Exportación creada correctamente'
                    : encrypt
                      ? 'Copia cifrada creada correctamente'
                      : 'Copia creada correctamente'
              }}
            </div>
            <div class="backup-dialog__path nd-mono nd-ellipsis" :title="result.path">
              {{ result.path }}
            </div>
            <div class="backup-dialog__stats">
              <span
                ><strong class="nd-mono">{{ formatBytes(result.sizeBytes) }}</strong></span
              >
              <template v-if="!isFile">
                <span
                  ><strong class="nd-mono">{{ formatNumber(result.objects) }}</strong> objetos</span
                >
                <span
                  ><strong class="nd-mono">{{ formatNumber(result.rows) }}</strong> filas</span
                >
              </template>
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
          {{ isSql ? 'Exportar' : isFile ? 'Copiar archivo…' : 'Iniciar copia' }}
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
