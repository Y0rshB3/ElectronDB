<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  ConnectionConfig,
  ConnectionInput,
  ConnectionTestResult,
  EngineId,
  MysqlAuthMode,
  SslMode
} from '@shared/types'
import { DEFAULT_NETWORK, ENGINES, defaultPostgresOptions, pickableEngines } from '@shared/engines'
import { can } from '@renderer/engines/capabilities'
import { api } from '@renderer/api'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useUiStore } from '@renderer/stores/ui'
import { useSettingsStore } from '@renderer/stores/settings'
import PathPicker from '@renderer/components/common/PathPicker.vue'
import './pathField.css'
import { vPathTail } from './pathTail'
import DialogHeader from './DialogHeader.vue'
import { ENVIRONMENTS, environmentLabel } from '@renderer/components/backups/backupHelpers'
import {
  COLOR_PRESETS,
  PG_SSL_MODES,
  emptyConnectionInput,
  inputFromConnection,
  normalizeConnectionInput,
  validateConnectionInput,
  withSslMode
} from './connectionForm'

const ui = useUiStore()
const connections = useConnectionsStore()
const settingsStore = useSettingsStore()
const notify = useNotify()

const tab = ref<'general' | 'ssh' | 'ssl' | 'advanced'>('general')
const form = ref<ConnectionInput>(emptyConnectionInput())
// Secrets live only in memory and go straight to the CredentialStore via IPC.
const password = ref('')
const sshPassword = ref('')
const hasPassword = ref(false)
const hasSshPassword = ref(false)
const clearPassword = ref(false)
const clearSshPassword = ref(false)
const showPassword = ref(false)
const testing = ref(false)
const testResult = ref<ConnectionTestResult | null>(null)
const saving = ref(false)
const errors = ref<string[]>([])
// PostgreSQL client-key passphrase (CredentialStore 'sslKey'), like the other secrets.
const sslKeyPassword = ref('')
const hasSslKeyPassword = ref(false)
const clearSslKeyPassword = ref(false)

const engine = computed<EngineId>(() => form.value.engine ?? 'mysql')
const isPg = computed(() => engine.value === 'postgresql')
const engineLabel = computed(() => ENGINES[engine.value]?.label ?? 'MySQL')
/** Backups are MySQL-only: the backup folder fields follow the capability. */
const showBackupDirs = computed(() => can({ engine: engine.value }, 'supportsBackupsNb3'))
/**
 * Engines offered for a new connection: only with Ajustes › Motores en vista
 * previa on (otherwise MySQL, as before, and no picker is shown).
 */
const engineChoices = computed(() =>
  editing.value ? [] : pickableEngines(settingsStore.settings.previewEngines === true)
)

function selectEngine(id: EngineId): void {
  if (id === engine.value) return
  const keep = {
    name: form.value.name,
    environment: form.value.environment,
    color: form.value.color
  }
  form.value = { ...emptyConnectionInput(id), ...keep }
  testResult.value = null
  errors.value = []
}

const pgOptions = computed(() => form.value.postgres ?? defaultPostgresOptions())
function patchPostgres(patch: Partial<NonNullable<ConnectionInput['postgres']>>): void {
  form.value = { ...form.value, postgres: { ...pgOptions.value, ...patch } }
}
const sslMode = computed<SslMode>({
  get: () => form.value.ssl.mode ?? 'disable',
  set: (mode) => {
    form.value = { ...form.value, ssl: withSslMode(form.value.ssl, mode) }
  }
})
const network = computed(() => ({ ...DEFAULT_NETWORK, ...form.value.network }))
const connectTimeoutSec = computed({
  get: () => Math.round(network.value.connectTimeoutMs / 1000),
  set: (v: number) => {
    form.value = {
      ...form.value,
      network: { ...network.value, connectTimeoutMs: Math.max(1, Number(v) || 1) * 1000 }
    }
  }
})
const keepAliveSec = computed({
  get: () => network.value.keepAliveSec,
  set: (v: number) => {
    form.value = {
      ...form.value,
      network: { ...network.value, keepAliveSec: Math.max(0, Number(v) || 0) }
    }
  }
})

const AUTH_MODES: { value: MysqlAuthMode; title: string }[] = [
  { value: 'password', title: 'Contraseña' },
  { value: 'none', title: 'Sin contraseña' }
]

const editing = computed(() => ui.connectionDialog.editing)
const noPassword = computed(() => form.value.authMode === 'none')
const open = computed({
  get: () => ui.connectionDialog.open,
  set: (value: boolean) => {
    ui.connectionDialog = { ...ui.connectionDialog, open: value }
  }
})
const isCustomColor = computed(
  () => !!form.value.color && !COLOR_PRESETS.some((p) => p.value === form.value.color)
)
const environmentHint = computed(() =>
  form.value.environment === 'production'
    ? 'Producción: toda escritura (restauraciones, DDL, cambios de datos) pedirá confirmación explícita.'
    : settingsStore.needsTypedConfirm(form.value.environment)
      ? `${environmentLabel(form.value.environment)}: según Ajustes › Seguridad, toda escritura pedirá escribir el nombre de la conexión.`
      : 'Marca como «Producción» las conexiones donde un error sea grave: se pedirá confirmación antes de escribir.'
)

async function reset(): Promise<void> {
  tab.value = 'general'
  form.value = editing.value
    ? inputFromConnection(editing.value)
    : emptyConnectionInput(ui.connectionDialog.engine ?? 'mysql')
  sslKeyPassword.value = ''
  hasSslKeyPassword.value = false
  clearSslKeyPassword.value = false
  password.value = ''
  sshPassword.value = ''
  clearPassword.value = false
  clearSshPassword.value = false
  showPassword.value = false
  testResult.value = null
  errors.value = []
  hasPassword.value = false
  hasSshPassword.value = false
  if (editing.value) {
    const id = editing.value.id
    const [pw, sshPw] = await Promise.all([
      api.connections.hasPassword(id).catch(() => false),
      api.connections.hasSshPassword(id).catch(() => false)
    ])
    hasPassword.value = pw
    hasSshPassword.value = sshPw
    if (editing.value.engine === 'postgresql')
      hasSslKeyPassword.value = await api.connections.hasSslKeyPassword(id).catch(() => false)
  }
}

watch(
  () => ui.connectionDialog.open,
  (value) => {
    if (value) void reset()
  },
  { immediate: true }
)

async function test(): Promise<void> {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await connections.test(
      normalizeConnectionInput(form.value),
      noPassword.value ? null : password.value || null,
      sshPassword.value || null
    )
  } catch (err) {
    testResult.value = { ok: false, durationMs: 0, error: errorMessage(err) }
  } finally {
    testing.value = false
  }
}

async function save(): Promise<void> {
  const input = normalizeConnectionInput(form.value)
  errors.value = validateConnectionInput(input)
  if (errors.value.length) return
  saving.value = true
  const wasEditing = !!editing.value
  let saved: ConnectionConfig
  try {
    saved = await connections.save(input)
  } catch (err) {
    errors.value = [errorMessage(err)]
    saving.value = false
    return
  }
  // From here on the connection exists: switch the dialog to edit mode so a retry
  // updates it instead of creating a duplicate.
  form.value = { ...form.value, id: saved.id }
  ui.connectionDialog = { ...ui.connectionDialog, editing: saved }
  try {
    // 'none' never uses a password: drop a stored one instead of keeping an unused secret.
    if (input.authMode === 'none') {
      if (hasPassword.value) await api.connections.setPassword(saved.id, null)
    } else if (password.value && input.savePassword)
      await api.connections.setPassword(saved.id, password.value)
    else if (clearPassword.value || (!input.savePassword && hasPassword.value))
      await api.connections.setPassword(saved.id, null)
    if (
      input.ssh.enabled &&
      input.ssh.authType === 'password' &&
      sshPassword.value &&
      input.ssh.savePassword
    ) {
      await api.connections.setSshPassword(saved.id, sshPassword.value)
    } else if (clearSshPassword.value || (!input.ssh.savePassword && hasSshPassword.value)) {
      await api.connections.setSshPassword(saved.id, null)
    }
    if (input.engine === 'postgresql') {
      if (sslKeyPassword.value && input.ssl.clientKeyPath)
        await api.connections.setSslKeyPassword(saved.id, sslKeyPassword.value)
      else if (clearSslKeyPassword.value || (hasSslKeyPassword.value && !input.ssl.clientKeyPath))
        await api.connections.setSslKeyPassword(saved.id, null)
    }
    password.value = ''
    sshPassword.value = ''
    sslKeyPassword.value = ''
    notify.success(
      wasEditing ? `Conexión «${saved.name}» actualizada` : `Conexión «${saved.name}» creada`
    )
    open.value = false
  } catch (err) {
    errors.value = [
      `La conexión «${saved.name}» se guardó, pero no se pudo guardar la contraseña: ${errorMessage(err)}. Vuelve a pulsar Guardar para reintentarlo.`
    ]
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="720" scrollable>
    <v-card data-test="connection-dialog">
      <DialogHeader
        icon="mdi-lan"
        :title="editing ? `Editar conexión · ${editing.name}` : `Nueva conexión ${engineLabel}`"
        :subtitle="
          editing
            ? `${editing.host}:${editing.port}`
            : isPg
              ? 'PostgreSQL (vista previa), con SSH y SSL opcionales'
              : 'MySQL / MariaDB, con SSH y SSL opcionales'
        "
        :danger="form.environment === 'production'"
      />
      <v-tabs v-model="tab" density="compact" color="primary">
        <v-tab value="general" prepend-icon="mdi-tune-variant">General</v-tab>
        <v-tab value="ssh" prepend-icon="mdi-console-network-outline">SSH</v-tab>
        <v-tab value="ssl" prepend-icon="mdi-shield-lock-outline">SSL</v-tab>
        <v-tab value="advanced" prepend-icon="mdi-cog-outline">Avanzado</v-tab>
      </v-tabs>
      <v-card-text class="connection-dialog__body">
        <div
          v-if="engineChoices.length > 1"
          class="connection-dialog__engines"
          role="radiogroup"
          aria-label="Motor de base de datos"
          data-test="conn-engine-picker"
        >
          <button
            v-for="e in engineChoices"
            :key="e.id"
            type="button"
            role="radio"
            class="connection-dialog__engine"
            :class="{ 'connection-dialog__engine--active': engine === e.id }"
            :aria-checked="engine === e.id"
            :data-test="`conn-engine-${e.id}`"
            @click="selectEngine(e.id)"
          >
            <v-icon :icon="e.icon" size="18" aria-hidden="true" />
            <span>{{ e.label }}</span>
            <span v-if="e.capabilities.preview" class="connection-dialog__preview"
              >vista previa</span
            >
          </button>
        </div>
        <div v-else-if="editing && isPg" class="mb-2">
          <v-chip size="small" :prepend-icon="ENGINES.postgresql.icon" data-test="conn-engine-chip"
            >PostgreSQL · vista previa</v-chip
          >
        </div>
        <v-window v-model="tab">
          <v-window-item value="general">
            <v-row dense>
              <v-col cols="12" sm="8">
                <v-text-field
                  v-model="form.name"
                  label="Nombre de la conexión"
                  autofocus
                  data-test="conn-name"
                />
              </v-col>
              <v-col cols="12" sm="4">
                <v-select
                  v-model="form.environment"
                  :items="ENVIRONMENTS"
                  label="Entorno"
                  data-test="conn-environment"
                />
              </v-col>
              <v-col cols="12">
                <div class="connection-dialog__color-row">
                  <span class="nd-section-title">Color</span>
                  <div class="swatches" role="radiogroup" aria-label="Color de la conexión">
                    <button
                      v-for="preset in COLOR_PRESETS"
                      :key="preset.label"
                      type="button"
                      role="radio"
                      class="color-swatch"
                      :class="{
                        'color-swatch--active': form.color === preset.value,
                        'color-swatch--none': !preset.value
                      }"
                      :style="preset.value ? { '--sw': preset.value } : undefined"
                      :aria-checked="form.color === preset.value"
                      :aria-label="preset.label"
                      :title="preset.label"
                      @click="form.color = preset.value"
                    >
                      <v-icon v-if="!preset.value" icon="mdi-cancel" size="14" />
                    </button>
                    <label
                      class="color-swatch color-swatch--custom"
                      :class="{ 'color-swatch--active': isCustomColor }"
                      :style="isCustomColor && form.color ? { '--sw': form.color } : undefined"
                      title="Color personalizado"
                    >
                      <input
                        type="color"
                        class="color-custom"
                        :value="form.color ?? '#888888'"
                        aria-label="Color personalizado"
                        @input="form.color = ($event.target as HTMLInputElement).value"
                      />
                      <v-icon icon="mdi-eyedropper-variant" size="13" aria-hidden="true" />
                    </label>
                  </div>
                </div>
                <div
                  class="connection-dialog__env-hint"
                  :class="{
                    'connection-dialog__env-hint--prod': form.environment === 'production'
                  }"
                >
                  <v-icon
                    :icon="
                      form.environment === 'production'
                        ? 'mdi-shield-alert-outline'
                        : 'mdi-information-outline'
                    "
                    size="15"
                    aria-hidden="true"
                  />
                  <span>{{ environmentHint }}</span>
                </div>
              </v-col>
              <v-col cols="12" sm="8">
                <v-text-field
                  v-model="form.host"
                  label="Host"
                  prepend-inner-icon="mdi-server-network"
                  class="nd-mono-input"
                  data-test="conn-host"
                />
              </v-col>
              <v-col cols="12" sm="4">
                <v-text-field
                  v-model.number="form.port"
                  label="Puerto"
                  type="number"
                  min="1"
                  max="65535"
                  class="nd-mono-input"
                  data-test="conn-port"
                />
              </v-col>
              <v-col cols="12" sm="6">
                <v-text-field
                  v-model="form.username"
                  label="Usuario"
                  prepend-inner-icon="mdi-account-outline"
                  autocomplete="off"
                  data-test="conn-user"
                />
              </v-col>
              <v-col cols="12" sm="6">
                <v-select
                  v-model="form.authMode"
                  :items="AUTH_MODES"
                  label="Autenticación"
                  prepend-inner-icon="mdi-shield-key-outline"
                  data-test="conn-auth-mode"
                />
              </v-col>
              <v-col v-if="noPassword" cols="12">
                <v-alert
                  type="info"
                  variant="tonal"
                  density="compact"
                  icon="mdi-certificate-outline"
                  data-test="conn-no-password-hint"
                >
                  Útil con Cloud SQL Auth Proxy, túneles o certificados de cliente (pestaña SSL).
                  <template v-if="hasPassword">
                    La contraseña guardada de esta conexión se borrará al guardar.</template
                  >
                </v-alert>
              </v-col>
              <v-col v-if="!noPassword" cols="12" sm="6">
                <v-text-field
                  v-model="password"
                  label="Contraseña"
                  persistent-placeholder
                  prepend-inner-icon="mdi-lock-outline"
                  :type="showPassword ? 'text' : 'password'"
                  autocomplete="new-password"
                  :placeholder="hasPassword && !clearPassword ? '•••••• (guardada)' : ''"
                  :append-inner-icon="showPassword ? 'mdi-eye-off' : 'mdi-eye'"
                  data-test="conn-password"
                  @click:append-inner="showPassword = !showPassword"
                />
              </v-col>
              <v-col v-if="!noPassword" cols="12" class="d-flex align-center flex-wrap ga-2">
                <v-checkbox
                  v-model="form.savePassword"
                  label="Guardar contraseña"
                  density="compact"
                  hide-details
                />
                <template v-if="hasPassword">
                  <v-chip
                    v-if="!clearPassword"
                    size="small"
                    color="success"
                    prepend-icon="mdi-key"
                    data-test="conn-password-saved"
                    >contraseña guardada</v-chip
                  >
                  <v-chip v-else size="small" color="warning" prepend-icon="mdi-key-remove"
                    >se borrará al guardar</v-chip
                  >
                  <v-btn
                    size="small"
                    variant="text"
                    :prepend-icon="clearPassword ? 'mdi-undo-variant' : 'mdi-key-remove'"
                    class="connection-dialog__clear-password"
                    :class="{ 'connection-dialog__clear-password--danger': !clearPassword }"
                    @click="clearPassword = !clearPassword"
                  >
                    {{ clearPassword ? 'Mantener contraseña' : 'Borrar contraseña guardada' }}
                  </v-btn>
                </template>
              </v-col>
              <template v-if="isPg">
                <v-col cols="12" sm="6">
                  <v-text-field
                    :model-value="pgOptions.initialDatabase"
                    label="Base de datos inicial"
                    prepend-inner-icon="mdi-database-outline"
                    class="nd-mono-input"
                    hint="Se abre al conectar (por defecto postgres)"
                    persistent-hint
                    data-test="conn-pg-database"
                    @update:model-value="patchPostgres({ initialDatabase: $event })"
                  />
                </v-col>
                <v-col cols="12" sm="6">
                  <v-text-field
                    :model-value="pgOptions.searchPath"
                    label="search_path"
                    class="nd-mono-input"
                    hint="Vacío = el del servidor; p. ej. app, public"
                    persistent-hint
                    data-test="conn-pg-search-path"
                    @update:model-value="patchPostgres({ searchPath: $event })"
                  />
                </v-col>
                <v-col cols="12">
                  <v-combobox
                    v-model="form.customDatabases"
                    label="Mostrar solo estas bases de datos"
                    hint="Si no está vacía, solo se muestran estas bases de datos. Pulsa Enter para añadir."
                    persistent-hint
                    multiple
                    chips
                    closable-chips
                    data-test="conn-pg-custom-databases"
                  />
                </v-col>
                <v-col cols="12">
                  <v-checkbox
                    :model-value="pgOptions.showSystemSchemas"
                    label="Mostrar esquemas y bases de datos del sistema"
                    density="compact"
                    hide-details
                    data-test="conn-pg-system"
                    @update:model-value="patchPostgres({ showSystemSchemas: $event === true })"
                  />
                </v-col>
              </template>
            </v-row>
          </v-window-item>

          <v-window-item value="ssh">
            <v-switch
              v-model="form.ssh.enabled"
              label="Usar túnel SSH"
              color="primary"
              density="compact"
              hide-details
            />
            <v-row dense class="mt-1">
              <v-col cols="12" sm="8"
                ><v-text-field
                  v-model="form.ssh.host"
                  label="Host SSH"
                  class="nd-mono-input"
                  :disabled="!form.ssh.enabled"
              /></v-col>
              <v-col cols="12" sm="4"
                ><v-text-field
                  v-model.number="form.ssh.port"
                  label="Puerto"
                  class="nd-mono-input"
                  type="number"
                  :disabled="!form.ssh.enabled"
              /></v-col>
              <v-col cols="12" sm="6"
                ><v-text-field
                  v-model="form.ssh.username"
                  label="Usuario SSH"
                  :disabled="!form.ssh.enabled"
              /></v-col>
              <v-col cols="12" sm="6">
                <v-select
                  v-model="form.ssh.authType"
                  :items="[
                    { title: 'Contraseña', value: 'password' },
                    { title: 'Clave pública', value: 'key' }
                  ]"
                  label="Autenticación"
                  :disabled="!form.ssh.enabled"
                />
              </v-col>
              <v-col v-if="form.ssh.authType === 'key'" cols="12">
                <PathPicker
                  v-model="form.ssh.privateKeyPath"
                  v-path-tail="form.ssh.privateKeyPath"
                  :title="form.ssh.privateKeyPath || undefined"
                  class="nd-path-field"
                  kind="file"
                  label="Archivo de clave privada"
                  :disabled="!form.ssh.enabled"
                />
              </v-col>
              <v-col v-else cols="12" sm="6">
                <v-text-field
                  v-model="sshPassword"
                  label="Contraseña SSH"
                  type="password"
                  autocomplete="new-password"
                  :placeholder="hasSshPassword && !clearSshPassword ? '•••••• (guardada)' : ''"
                  :disabled="!form.ssh.enabled"
                />
              </v-col>
              <v-col cols="12" class="d-flex align-center flex-wrap ga-2">
                <v-checkbox
                  v-model="form.ssh.savePassword"
                  label="Guardar contraseña SSH"
                  density="compact"
                  hide-details
                  :disabled="!form.ssh.enabled"
                />
                <template v-if="hasSshPassword">
                  <v-chip
                    size="small"
                    :color="clearSshPassword ? 'warning' : 'success'"
                    prepend-icon="mdi-key"
                  >
                    {{ clearSshPassword ? 'se borrará al guardar' : 'contraseña SSH guardada' }}
                  </v-chip>
                  <v-btn size="small" variant="text" @click="clearSshPassword = !clearSshPassword">
                    {{ clearSshPassword ? 'Mantener' : 'Borrar' }}
                  </v-btn>
                </template>
              </v-col>
            </v-row>
          </v-window-item>

          <v-window-item value="ssl">
            <template v-if="isPg">
              <v-select
                v-model="sslMode"
                :items="PG_SSL_MODES"
                label="Modo SSL"
                prepend-inner-icon="mdi-shield-lock-outline"
                hint="Con túnel SSH, verify-full comprueba el nombre del servidor real (no 127.0.0.1)."
                persistent-hint
                data-test="conn-pg-ssl-mode"
              />
              <div class="d-flex flex-column ga-3 mt-3">
                <PathPicker
                  v-model="form.ssl.caCertPath"
                  v-path-tail="form.ssl.caCertPath"
                  :title="form.ssl.caCertPath || undefined"
                  class="nd-path-field"
                  kind="file"
                  label="Certificado CA"
                  :disabled="sslMode === 'disable'"
                />
                <PathPicker
                  v-model="form.ssl.clientCertPath"
                  v-path-tail="form.ssl.clientCertPath"
                  :title="form.ssl.clientCertPath || undefined"
                  class="nd-path-field"
                  kind="file"
                  label="Certificado de cliente"
                  :disabled="sslMode === 'disable'"
                />
                <PathPicker
                  v-model="form.ssl.clientKeyPath"
                  v-path-tail="form.ssl.clientKeyPath"
                  :title="form.ssl.clientKeyPath || undefined"
                  class="nd-path-field"
                  kind="file"
                  label="Clave de cliente"
                  :disabled="sslMode === 'disable'"
                />
                <div class="d-flex align-center flex-wrap ga-2">
                  <v-text-field
                    v-model="sslKeyPassword"
                    label="Contraseña de la clave"
                    type="password"
                    autocomplete="new-password"
                    :placeholder="
                      hasSslKeyPassword && !clearSslKeyPassword ? '•••••• (guardada)' : ''
                    "
                    persistent-placeholder
                    :disabled="sslMode === 'disable' || !form.ssl.clientKeyPath"
                    data-test="conn-pg-ssl-key-password"
                  />
                  <template v-if="hasSslKeyPassword">
                    <v-btn
                      size="small"
                      variant="text"
                      @click="clearSslKeyPassword = !clearSslKeyPassword"
                    >
                      {{ clearSslKeyPassword ? 'Mantener' : 'Borrar' }}
                    </v-btn>
                  </template>
                </div>
              </div>
            </template>
            <template v-else>
              <v-switch
                v-model="form.ssl.enabled"
                label="Usar SSL"
                color="primary"
                density="compact"
                hide-details
              />
              <div class="d-flex flex-column ga-3 mt-2">
                <PathPicker
                  v-model="form.ssl.caCertPath"
                  v-path-tail="form.ssl.caCertPath"
                  :title="form.ssl.caCertPath || undefined"
                  class="nd-path-field"
                  kind="file"
                  label="Certificado CA"
                  :disabled="!form.ssl.enabled"
                />
                <PathPicker
                  v-model="form.ssl.clientCertPath"
                  v-path-tail="form.ssl.clientCertPath"
                  :title="form.ssl.clientCertPath || undefined"
                  class="nd-path-field"
                  kind="file"
                  label="Certificado de cliente"
                  :disabled="!form.ssl.enabled"
                />
                <PathPicker
                  v-model="form.ssl.clientKeyPath"
                  v-path-tail="form.ssl.clientKeyPath"
                  :title="form.ssl.clientKeyPath || undefined"
                  class="nd-path-field"
                  kind="file"
                  label="Clave de cliente"
                  :disabled="!form.ssl.enabled"
                />
                <v-checkbox
                  v-model="form.ssl.verifyServer"
                  label="Verificar certificado del servidor"
                  density="compact"
                  hide-details
                  :disabled="!form.ssl.enabled"
                />
              </div>
            </template>
          </v-window-item>

          <v-window-item value="advanced">
            <v-combobox
              v-if="!isPg"
              v-model="form.customDatabases"
              label="Lista de bases de datos personalizada"
              hint="Si no está vacía, solo se muestran estos esquemas. Pulsa Enter para añadir."
              persistent-hint
              multiple
              chips
              closable-chips
              class="mb-3"
            />
            <v-textarea
              v-model="form.initialQueries"
              label="Consultas iniciales de sesión"
              hint="Se ejecutan al abrir cada sesión, p. ej. SET time_zone = '+00:00';"
              persistent-hint
              rows="3"
              variant="outlined"
              density="compact"
              class="mb-3"
            />
            <v-row v-if="isPg" dense class="mb-1">
              <v-col cols="12" sm="6">
                <v-text-field
                  :model-value="pgOptions.timeZone"
                  label="Zona horaria de sesión"
                  hint="Vacío = la del servidor; p. ej. UTC o Europe/Madrid"
                  persistent-hint
                  class="nd-mono-input"
                  data-test="conn-pg-timezone"
                  @update:model-value="patchPostgres({ timeZone: $event })"
                />
              </v-col>
              <v-col cols="6" sm="3">
                <v-text-field
                  v-model.number="connectTimeoutSec"
                  label="Tiempo de conexión (s)"
                  type="number"
                  min="1"
                  data-test="conn-pg-timeout"
                />
              </v-col>
              <v-col cols="6" sm="3">
                <v-text-field
                  v-model.number="keepAliveSec"
                  label="Intervalo keepalive (s)"
                  type="number"
                  min="0"
                  hint="0 = desactivado"
                  persistent-hint
                  data-test="conn-pg-keepalive"
                />
              </v-col>
            </v-row>
            <PathPicker
              v-if="showBackupDirs"
              v-model="form.backupDir"
              kind="directory"
              label="Carpeta de copias de seguridad"
              hint="Vacío = carpeta por defecto de Ajustes"
            />
            <div v-if="showBackupDirs && form.extraBackupDirs.length" class="mt-3">
              <div class="text-caption text-medium-emphasis">
                Carpetas adicionales (solo lectura, p. ej. Navicat)
              </div>
              <v-list density="compact" class="py-0">
                <v-list-item
                  v-for="dir in form.extraBackupDirs"
                  :key="dir"
                  prepend-icon="mdi-folder-lock-outline"
                  :title="dir"
                >
                  <template #append>
                    <v-btn
                      icon="mdi-folder-open-outline"
                      size="x-small"
                      :aria-label="`Abrir ${dir}`"
                      @click="api.app.openPath(dir)"
                    />
                  </template>
                </v-list-item>
              </v-list>
            </div>
          </v-window-item>
        </v-window>

        <v-alert
          v-if="testResult?.ok && testResult.connectedWithoutPassword && !noPassword"
          type="info"
          variant="tonal"
          density="compact"
          class="mt-3"
          data-test="conn-suggest-no-password"
        >
          El servidor aceptó la conexión sin contraseña. Si no la necesita, marca «Sin contraseña»
          para no tener que guardarla.
          <template #append>
            <v-btn
              size="small"
              variant="text"
              data-test="conn-use-no-password"
              @click="form.authMode = 'none'"
              >Usar «Sin contraseña»</v-btn
            >
          </template>
        </v-alert>
        <v-alert
          v-if="errors.length"
          type="error"
          variant="tonal"
          density="compact"
          class="mt-3"
          data-test="conn-errors"
        >
          <div v-for="e in errors" :key="e">{{ e }}</div>
        </v-alert>
      </v-card-text>
      <v-card-actions>
        <v-btn prepend-icon="mdi-connection" :loading="testing" data-test="conn-test" @click="test"
          >Probar conexión</v-btn
        >
        <span
          v-if="testResult"
          class="nd-pill connection-dialog__result"
          :class="testResult.ok ? 'nd-pill--local' : 'nd-pill--production'"
          :title="testResult.error ?? ''"
          role="status"
          data-test="conn-test-result"
        >
          <span class="connection-dialog__result-dot" aria-hidden="true" />
          <span class="nd-ellipsis">
            <template v-if="testResult.ok && isPg"
              >Conectado · {{ testResult.serverVersion }} ({{ testResult.durationMs }} ms)<template
                v-if="testResult.details?.length"
              >
                · {{ testResult.details.join(' · ') }}</template
              ></template
            >
            <template v-else-if="testResult.ok"
              >Conectado · MySQL {{ testResult.serverVersion }} ({{
                testResult.durationMs
              }}
              ms)</template
            >
            <template v-else>{{ testResult.error ?? 'Error de conexión' }}</template>
          </span>
        </span>
        <v-spacer />
        <v-btn @click="open = false">Cancelar</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" data-test="conn-save" @click="save"
          >Guardar</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.connection-dialog__engines {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.connection-dialog__engine {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: var(--nd-radius-sm);
  border: 1px solid var(--nd-border);
  background: var(--nd-bg-sunken);
  color: var(--nd-text);
  cursor: pointer;
}
.connection-dialog__engine--active {
  border-color: rgba(var(--nd-accent-rgb), 0.6);
  box-shadow: var(--nd-glow);
}
.connection-dialog__preview {
  font-size: var(--nd-fs-xs);
  color: var(--nd-warning);
}
.connection-dialog__body {
  min-height: 300px;
  padding-top: 8px !important;
}
.connection-dialog__body .nd-mono-input :deep(input) {
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
}
.connection-dialog__color-row {
  display: flex;
  align-items: center;
  gap: 14px;
}
.swatches {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.color-swatch {
  position: relative;
  width: 20px;
  height: 20px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--nd-border-strong);
  background: var(--sw, transparent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--sw, transparent) 45%, transparent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--nd-text-muted);
  cursor: pointer;
  transition:
    transform var(--nd-dur-fast) var(--nd-ease),
    box-shadow var(--nd-dur) var(--nd-ease);
}
.color-swatch:hover {
  transform: scale(1.12);
}
.color-swatch--none {
  border-color: var(--nd-border-strong);
  background: var(--nd-bg-input);
  box-shadow: none;
}
.color-swatch--active {
  box-shadow:
    0 0 0 2px var(--nd-bg-raised),
    0 0 0 3.5px var(--sw, var(--nd-accent)),
    0 0 16px color-mix(in srgb, var(--sw, var(--nd-accent)) 65%, transparent);
}
.color-swatch:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 2px var(--nd-bg-raised),
    var(--nd-glow);
}
.color-swatch--custom {
  overflow: hidden;
  background: var(--sw, conic-gradient(#f87171, #fbbf24, #34d399, #22d3ee, #8b5cf6, #f87171));
  border-color: var(--nd-border-strong);
  color: #fff;
}
.color-swatch--custom:focus-within {
  box-shadow:
    0 0 0 2px var(--nd-bg-raised),
    var(--nd-glow);
}
.color-custom {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}
.connection-dialog__env-hint {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: var(--nd-radius-control);
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
  background: var(--nd-hover);
  border: 1px solid var(--nd-hairline);
}
.connection-dialog__env-hint .v-icon {
  margin-top: 1px;
  flex: none;
}
.connection-dialog__env-hint--prod {
  color: var(--nd-error);
  background: var(--nd-error-soft);
  border-color: color-mix(in srgb, var(--nd-error) 35%, transparent);
  box-shadow: 0 0 16px color-mix(in srgb, var(--nd-error) 14%, transparent);
}
.connection-dialog__clear-password {
  color: var(--nd-text-2);
}
.connection-dialog__clear-password--danger:hover,
.connection-dialog__clear-password--danger:focus-visible {
  color: var(--nd-error) !important;
  background: var(--nd-error-soft);
}
.connection-dialog__result {
  max-width: 320px;
  height: 22px;
  min-width: 0;
}
.connection-dialog__result-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
}
</style>
