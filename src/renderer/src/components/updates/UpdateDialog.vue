<script setup lang="ts">
import { computed } from 'vue'
import { useUpdatesStore } from '@renderer/stores/updates'
import { formatBytes } from '@renderer/utils/format'
import DialogHeader from '@renderer/components/dialogs/DialogHeader.vue'
import ReleaseNotes from './ReleaseNotes.vue'
import { formatReleaseDate } from './updateFormat'

/**
 * «Buscar actualizaciones»: installed vs latest version, release notes and the
 * way to update this copy (download the installer, or the commands for a
 * folder that runs from source).
 */
const updates = useUpdatesStore()

const open = computed({
  get: () => updates.dialogOpen,
  set: (value: boolean) => {
    updates.dialogOpen = value
  }
})

const result = computed(() => updates.result)
/** The spinner only replaces content when there is no answer yet. */
const firstLoad = computed(() => updates.checking && !result.value)
const status = computed(() => (firstLoad.value ? 'checking' : (result.value?.status ?? 'checking')))
const currentVersion = computed(() => result.value?.currentVersion || updates.appVersion || '—')
const latestVersion = computed(() =>
  status.value === 'error' || status.value === 'checking'
    ? '—'
    : result.value?.latestVersion || currentVersion.value
)
const published = computed(() => formatReleaseDate(result.value?.publishedAt))
const source = computed(() => result.value?.source)
const commandsText = computed(() => source.value?.commands.join('\n') ?? '')
const offBranch = computed(() => {
  const branch = source.value?.branch
  return branch && branch !== 'main' ? branch : null
})
const subtitle = computed(() => {
  switch (status.value) {
    case 'checking':
      return 'Consultando GitHub…'
    case 'available':
      return `Hay una versión nueva: ${result.value?.latestVersion}`
    case 'up-to-date':
      return 'No hay versiones nuevas'
    default:
      return 'No se pudo comprobar'
  }
})
</script>

<template>
  <v-dialog v-model="open" max-width="640" scrollable>
    <v-card data-test="update-dialog" :data-status="status">
      <DialogHeader icon="mdi-update" title="Actualizaciones" :subtitle="subtitle" />
      <v-progress-linear
        :active="updates.checking"
        indeterminate
        color="primary"
        height="2"
        aria-label="Buscando actualizaciones"
      />
      <v-card-text class="update-dialog__body">
        <div class="update-versions" role="group" aria-label="Versiones">
          <div class="update-versions__tile">
            <span class="update-versions__label">Versión instalada</span>
            <span class="update-versions__value nd-mono" data-test="update-current">{{
              currentVersion
            }}</span>
          </div>
          <v-icon
            icon="mdi-arrow-right"
            size="16"
            class="update-versions__arrow"
            aria-hidden="true"
          />
          <div
            class="update-versions__tile"
            :class="{ 'update-versions__tile--new': status === 'available' }"
          >
            <span class="update-versions__label">Última versión</span>
            <span class="update-versions__value nd-mono" data-test="update-latest">{{
              latestVersion
            }}</span>
          </div>
        </div>

        <div v-if="status === 'checking'" class="update-state" data-test="update-checking">
          <v-progress-circular indeterminate size="22" width="2" color="primary" />
          <span>Buscando la última versión publicada en GitHub…</span>
        </div>

        <v-alert
          v-else-if="status === 'error'"
          type="error"
          variant="tonal"
          density="compact"
          data-test="update-error"
        >
          {{ result?.error || 'No se pudo comprobar si hay actualizaciones.' }}
        </v-alert>

        <div
          v-else-if="status === 'up-to-date'"
          class="update-state update-state--ok"
          data-test="update-uptodate"
        >
          <span class="update-state__icon" aria-hidden="true"
            ><v-icon icon="mdi-check-circle-outline" size="20"
          /></span>
          <span>Estás en la última versión ({{ currentVersion }}).</span>
        </div>

        <template v-else-if="status === 'available' && result">
          <section class="update-section" aria-labelledby="update-release-title">
            <div class="update-section__head">
              <h3
                id="update-release-title"
                class="update-section__title nd-ellipsis"
                :title="result.releaseName"
              >
                {{ result.releaseName }}
              </h3>
              <span v-if="published" class="update-section__meta">{{ published }}</span>
            </div>
            <div class="update-notes">
              <ReleaseNotes :source="result.notes ?? ''" />
            </div>
          </section>

          <section
            v-if="result.runMode === 'packaged'"
            class="update-section update-section--action"
            aria-label="Descargar"
            data-test="update-packaged"
          >
            <template v-if="result.download">
              <div class="update-download">
                <v-icon
                  icon="mdi-package-down"
                  size="20"
                  class="update-download__icon"
                  aria-hidden="true"
                />
                <div class="update-download__text">
                  <div
                    class="update-download__name nd-mono nd-ellipsis"
                    :title="result.download.fileName"
                  >
                    {{ result.download.fileName }}
                  </div>
                  <div class="update-download__meta">
                    {{ result.download.label }} · {{ formatBytes(result.download.sizeBytes) }}
                  </div>
                </div>
                <v-btn
                  color="primary"
                  variant="flat"
                  prepend-icon="mdi-download"
                  data-test="update-download"
                  @click="updates.download()"
                  >Descargar</v-btn
                >
              </div>
              <div v-if="result.alternatives?.length" class="update-alternatives">
                <span class="update-alternatives__label">También:</span>
                <v-btn
                  v-for="alt in result.alternatives"
                  :key="alt.url"
                  size="small"
                  variant="text"
                  :title="alt.fileName"
                  data-test="update-alternative"
                  @click="updates.download(alt)"
                  >{{ alt.label }} · {{ formatBytes(alt.sizeBytes) }}</v-btn
                >
              </div>
            </template>
            <p v-else class="update-hint" data-test="update-no-asset">
              No hay un instalador para este sistema en esta versión. Descárgalo desde la página de
              la versión en GitHub.
            </p>
            <p class="update-hint">
              La descarga se abre en el navegador. Cierra ElectronDB antes de instalar la versión
              nueva: tus conexiones, trabajos y ajustes se conservan.
            </p>
          </section>

          <section
            v-else-if="source"
            class="update-section update-section--action"
            aria-label="Cómo actualizar"
            data-test="update-source"
          >
            <p class="update-hint update-hint--lead">
              Esta copia se ejecuta desde el código fuente en
              <code class="nd-mono">{{ source.dir }}</code
              >. Cierra la app y ejecuta en una terminal:
            </p>
            <v-alert
              v-if="!source.isGit"
              type="warning"
              variant="tonal"
              density="compact"
              class="update-alert"
              data-test="update-not-git"
            >
              Esta carpeta no es un repositorio git: descarga el código de la nueva versión desde
              GitHub (o clónalo con <code>git clone</code>) y después instala las dependencias.
            </v-alert>
            <v-alert
              v-else-if="offBranch"
              type="info"
              variant="tonal"
              density="compact"
              class="update-alert"
              data-test="update-branch"
            >
              Estás en la rama <code>{{ offBranch }}</code
              >: <code>git pull</code> traerá los cambios de esa rama. Las versiones se publican
              desde <code>main</code>.
            </v-alert>
            <div class="update-commands">
              <div class="update-commands__bar">
                <span class="update-commands__label">
                  <v-icon icon="mdi-console" size="14" aria-hidden="true" />Terminal
                </span>
                <v-btn
                  size="x-small"
                  variant="text"
                  prepend-icon="mdi-content-copy"
                  data-test="update-copy"
                  @click="updates.copyCommands()"
                  >Copiar comandos</v-btn
                >
              </div>
              <pre class="nd-mono" data-test="update-commands">{{ commandsText }}</pre>
            </div>
            <p class="update-hint">
              <code>npm install</code> solo hace algo si cambiaron las dependencias; no pasa nada
              por ejecutarlo siempre.
            </p>
          </section>
        </template>
      </v-card-text>
      <v-card-actions>
        <v-btn
          v-if="status === 'available' && !result?.dismissed"
          variant="text"
          data-test="update-skip"
          @click="updates.dismissVersion()"
          >Omitir esta versión</v-btn
        >
        <v-spacer />
        <v-btn
          v-if="status === 'up-to-date' || status === 'error'"
          variant="text"
          :loading="updates.checking"
          data-test="update-recheck"
          @click="updates.checkNow()"
          >Buscar de nuevo</v-btn
        >
        <v-btn
          v-if="result?.releaseUrl && status !== 'error'"
          variant="text"
          append-icon="mdi-open-in-new"
          data-test="update-release-page"
          @click="updates.openRelease()"
          >Ver novedades en GitHub</v-btn
        >
        <v-btn variant="tonal" data-test="update-close" @click="open = false">Cerrar</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.update-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 8px !important;
}
.update-versions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.update-versions__tile {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border);
}
.update-versions__tile--new {
  border-color: rgba(var(--nd-accent-rgb), 0.35);
  background:
    linear-gradient(180deg, rgba(var(--nd-accent-rgb), 0.08), transparent 80%), var(--nd-bg-raised);
}
.update-versions__label {
  font-size: var(--nd-fs-small);
  color: var(--nd-text-2);
}
.update-versions__value {
  font-size: var(--nd-fs-heading);
  font-weight: var(--nd-fw-heading);
  color: var(--nd-text);
}
.update-versions__tile--new .update-versions__value {
  color: var(--nd-accent);
}
.update-versions__arrow {
  color: var(--nd-text-muted);
}
.update-state {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border);
  color: var(--nd-text);
}
.update-state--ok {
  border-color: color-mix(in srgb, var(--nd-success) 30%, transparent);
  background: var(--nd-success-soft);
}
.update-state__icon {
  display: inline-flex;
  color: var(--nd-success);
}
.update-section {
  padding: 12px 14px;
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border);
}
.update-section__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}
.update-section__title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: var(--nd-fs-base);
  font-weight: var(--nd-fw-heading);
  color: var(--nd-text);
}
.update-section__meta {
  flex: none;
  font-size: var(--nd-fs-small);
  color: var(--nd-text-2);
}
.update-notes {
  max-height: 240px;
  overflow-y: auto;
  padding-right: 4px;
}
.update-download {
  display: flex;
  align-items: center;
  gap: 12px;
}
.update-download__icon {
  color: var(--nd-accent);
}
.update-download__text {
  flex: 1;
  min-width: 0;
}
.update-download__name {
  font-size: var(--nd-fs-dense);
  color: var(--nd-text);
}
.update-download__meta {
  font-size: var(--nd-fs-small);
  color: var(--nd-text-2);
}
.update-alternatives {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  margin-top: 6px;
  margin-left: 32px;
}
.update-alternatives__label {
  font-size: var(--nd-fs-small);
  color: var(--nd-text-2);
  margin-right: 4px;
}
.update-hint {
  margin: 8px 0 0;
  font-size: var(--nd-fs-small);
  color: var(--nd-text-2);
}
.update-hint--lead {
  margin-top: 0;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text);
}
.update-hint code,
.update-alert code {
  font-family: var(--nd-font-mono);
  font-size: 0.95em;
  overflow-wrap: anywhere;
}
.update-alert {
  margin-top: 8px;
}
.update-commands {
  margin-top: 8px;
  border-radius: var(--nd-radius-control);
  background: var(--nd-bg-sunken);
  border: 1px solid var(--nd-border);
  overflow: hidden;
}
.update-commands__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 4px 3px 12px;
  border-bottom: 1px solid var(--nd-hairline);
}
.update-commands__label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--nd-fs-small);
  color: var(--nd-text-2);
}
.update-commands pre {
  margin: 0;
  padding: 10px 12px;
  font-size: var(--nd-fs-dense);
  line-height: 1.6;
  color: var(--nd-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
</style>
