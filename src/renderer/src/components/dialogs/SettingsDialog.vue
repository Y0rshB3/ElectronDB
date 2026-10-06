<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useTheme } from 'vuetify'
import type { AppSettings } from '@shared/types'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore } from '@renderer/stores/ui'
import { useUpdatesStore } from '@renderer/stores/updates'
import PathPicker from '@renderer/components/common/PathPicker.vue'
import './pathField.css'
import { vPathTail } from './pathTail'
import DialogHeader from './DialogHeader.vue'

const ui = useUiStore()
const settingsStore = useSettingsStore()
const theme = useTheme()
const notify = useNotify()
const updates = useUpdatesStore()

const form = ref<AppSettings>({ ...settingsStore.settings })
const saving = ref(false)
const error = ref('')

const open = computed({
  get: () => ui.settingsDialog,
  set: (value: boolean) => {
    ui.settingsDialog = value
  }
})

watch(
  () => ui.settingsDialog,
  (value) => {
    if (!value) return
    form.value = { ...settingsStore.settings }
    error.value = ''
    void updates.loadAppVersion()
  },
  { immediate: true }
)

async function save(): Promise<void> {
  const limit = Math.trunc(Number(form.value.defaultRowLimit))
  if (!Number.isFinite(limit) || limit < 1) {
    error.value = 'El límite de filas debe ser un número mayor que 0.'
    return
  }
  saving.value = true
  error.value = ''
  try {
    await settingsStore.update({ ...form.value, defaultRowLimit: limit })
    theme.change(settingsStore.themeName)
    notify.success('Ajustes guardados')
    open.value = false
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="620" scrollable>
    <v-card data-test="settings-dialog">
      <DialogHeader icon="mdi-cog-outline" title="Ajustes" subtitle="Preferencias de ElectronDB" />
      <v-card-text class="settings-dialog__body">
        <section class="settings-section" aria-label="Carpetas">
          <div class="settings-section__title">
            <v-icon icon="mdi-folder-outline" size="15" aria-hidden="true" />Carpetas
          </div>
          <div class="settings-section__fields">
            <PathPicker
              v-model="form.navicatRootPath"
              v-path-tail="form.navicatRootPath"
              :title="form.navicatRootPath || undefined"
              kind="directory"
              label="Carpeta de datos de Navicat"
              hint="Se usa para importar conexiones, tareas y copias"
              class="nd-path-field"
            />
            <PathPicker
              v-model="form.backupsRootDir"
              v-path-tail="form.backupsRootDir"
              :title="form.backupsRootDir || undefined"
              kind="directory"
              label="Carpeta raíz de copias de seguridad"
              hint="Destino por defecto de las copias creadas por ElectronDB"
              class="nd-path-field"
            />
          </div>
        </section>

        <section class="settings-section" aria-label="Consultas">
          <div class="settings-section__title">
            <v-icon icon="mdi-table-large" size="15" aria-hidden="true" />Consultas
          </div>
          <v-text-field
            v-model.number="form.defaultRowLimit"
            type="number"
            min="1"
            label="Límite de filas por defecto"
            hint="Filas cargadas al abrir una tabla o ejecutar una consulta"
            persistent-hint
            class="settings-dialog__limit"
          />
        </section>

        <section class="settings-section" aria-label="Apariencia">
          <div class="settings-section__title">
            <v-icon icon="mdi-palette-outline" size="15" aria-hidden="true" />Apariencia
          </div>
          <div class="settings-row">
            <span class="settings-row__label">Tema</span>
            <v-btn-toggle
              v-model="form.theme"
              mandatory
              density="compact"
              variant="outlined"
              color="primary"
              aria-label="Tema"
            >
              <v-btn value="dark" prepend-icon="mdi-weather-night">Oscuro</v-btn>
              <v-btn value="light" prepend-icon="mdi-white-balance-sunny">Claro</v-btn>
            </v-btn-toggle>
          </div>
        </section>

        <section class="settings-section" aria-label="Actualizaciones">
          <div class="settings-section__title">
            <v-icon icon="mdi-update" size="15" aria-hidden="true" />Actualizaciones
          </div>
          <div class="settings-row">
            <span class="settings-row__label">
              Versión instalada
              <span class="nd-mono settings-version" data-test="settings-version">{{
                updates.appVersion || '—'
              }}</span>
            </span>
            <v-btn
              size="small"
              variant="tonal"
              prepend-icon="mdi-update"
              data-test="settings-check-updates"
              @click="updates.openDialog()"
              >Buscar ahora</v-btn
            >
          </div>
          <v-switch
            v-model="form.checkUpdatesOnStartup"
            color="primary"
            label="Buscar actualizaciones al iniciar"
            density="compact"
            hide-details
            data-test="settings-check-updates-startup"
            class="settings-dialog__switch"
          />
        </section>

        <section class="settings-section settings-section--danger" aria-label="Seguridad">
          <div class="settings-section__title">
            <v-icon icon="mdi-shield-alert-outline" size="15" aria-hidden="true" />Producción
          </div>
          <v-switch
            v-model="form.confirmProductionWrites"
            color="error"
            label="Pedir confirmación escribiendo el nombre antes de escribir en conexiones de producción"
            density="compact"
            hide-details
          />
        </section>
        <v-alert v-if="error" type="error">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">Cancelar</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :loading="saving"
          data-test="settings-save"
          @click="save"
          >Guardar</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.settings-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 4px !important;
}
.settings-section {
  padding: 12px 14px 14px;
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border);
}
.settings-section__title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  font-size: var(--nd-fs-small);
  font-weight: 600;
  color: var(--nd-text-2);
}
.settings-section__title .v-icon {
  color: var(--nd-text-muted);
}
.settings-section__fields {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.settings-dialog__limit {
  max-width: 380px;
}
.settings-dialog__limit :deep(input) {
  font-family: var(--nd-font-mono);
}
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.settings-row__label {
  color: var(--nd-text);
}
.settings-dialog__switch {
  margin-top: 8px;
}
.settings-version {
  margin-left: 6px;
  color: var(--nd-accent);
}
.settings-section--danger {
  border-color: color-mix(in srgb, var(--nd-error) 22%, transparent);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--nd-error) 6%, transparent), transparent 70%),
    var(--nd-bg-raised);
}
.settings-section--danger .settings-section__title,
.settings-section--danger .settings-section__title .v-icon {
  color: var(--nd-error);
}
</style>
