<script setup lang="ts">
import { computed } from 'vue'
import { useUpdatesStore } from '@renderer/stores/updates'
import { formatBytes } from '@renderer/utils/format'

/**
 * «Descargar y actualizar» inside the updates dialog, for copies that update themselves:
 * Windows installer and Linux AppImage (download, then «Reiniciar y actualizar») and macOS
 * (verified .dmg, then drag to Applications). States come from main (event:updateInstall).
 */
const updates = useUpdatesStore()

const result = computed(() => updates.result)
const state = computed(() => updates.install)
const phase = computed(() => updates.installPhase)
const isMac = computed(() => updates.installMode === 'mac-dmg')
const version = computed(() => state.value?.version || result.value?.latestVersion || '')

const percent = computed(() => {
  const total = state.value?.total ?? 0
  if (!total) return 0
  return Math.min(100, Math.round(((state.value?.transferred ?? 0) / total) * 100))
})
const progressText = computed(() => {
  const s = state.value
  if (!s) return ''
  const done = formatBytes(s.transferred ?? 0)
  const of = s.total ? ` de ${formatBytes(s.total)}` : ''
  const speed = s.bytesPerSecond ? ` · ${formatBytes(s.bytesPerSecond)}/s` : ''
  return `${done}${of}${speed}`
})
const fileName = computed(() => {
  const path = state.value?.filePath ?? ''
  return path.split(/[\\/]/).pop() ?? ''
})
</script>

<template>
  <div class="update-install" data-test="update-install" :data-phase="phase">
    <template v-if="phase === 'downloading'">
      <div class="update-install__row">
        <v-icon icon="mdi-download" size="20" class="update-install__icon" aria-hidden="true" />
        <div class="update-install__text">
          <div class="update-install__title">Descargando ElectronDB {{ version }}…</div>
          <div class="update-install__meta nd-mono" data-test="update-progress-text">
            {{ progressText }}
          </div>
        </div>
        <v-btn variant="text" data-test="update-cancel" @click="updates.cancelDownload()"
          >Cancelar</v-btn
        >
      </div>
      <v-progress-linear
        :model-value="percent"
        :indeterminate="!state?.total"
        color="primary"
        height="6"
        rounded
        :aria-label="`Descarga de la actualización: ${percent}%`"
        data-test="update-progress"
      />
    </template>

    <template v-else-if="phase === 'downloaded' && !isMac">
      <div class="update-install__row update-install__row--ok" data-test="update-ready">
        <v-icon
          icon="mdi-check-circle-outline"
          size="20"
          class="update-install__icon"
          aria-hidden="true"
        />
        <div class="update-install__text">
          <div class="update-install__title">
            ElectronDB {{ version }} está listo para instalarse
          </div>
          <div class="update-install__meta">
            Descargado y comprobado (sha512). Al reiniciar se instala sin preguntas y se abre la
            versión nueva; tus conexiones, trabajos y ajustes se conservan. Si eliges «Más tarde» se
            instalará cuando cierres ElectronDB.
          </div>
        </div>
      </div>
      <div class="update-install__actions">
        <v-btn variant="text" data-test="update-install-later" @click="updates.dialogOpen = false"
          >Más tarde</v-btn
        >
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-restart"
          data-test="update-restart"
          @click="updates.installNow()"
          >Reiniciar y actualizar</v-btn
        >
      </div>
    </template>

    <template v-else-if="phase === 'downloaded' && isMac">
      <div class="update-install__row update-install__row--ok" data-test="update-mac-ready">
        <v-icon
          icon="mdi-check-circle-outline"
          size="20"
          class="update-install__icon"
          aria-hidden="true"
        />
        <div class="update-install__text">
          <div class="update-install__title">Instalador descargado y comprobado (SHA-256)</div>
          <div class="update-install__meta nd-mono nd-ellipsis" :title="state?.filePath">
            {{ fileName }} · en Descargas
          </div>
        </div>
      </div>
      <ol class="update-install__steps" data-test="update-mac-steps">
        <li>Cierra ElectronDB.</li>
        <li>
          En la ventana del instalador,
          <strong>arrastra ElectronDB a Aplicaciones y reemplaza</strong>
          la versión anterior.
        </li>
        <li>Abre ElectronDB de nuevo: tus conexiones, trabajos y ajustes se conservan.</li>
      </ol>
      <div class="update-install__actions">
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-open-in-app"
          data-test="update-open-dmg"
          @click="updates.installNow()"
          >Abrir el instalador</v-btn
        >
      </div>
    </template>

    <template v-else>
      <v-alert
        v-if="phase === 'error'"
        type="error"
        variant="tonal"
        density="compact"
        class="mb-2"
        data-test="update-install-error"
      >
        {{ state?.error || 'No se pudo descargar la actualización.' }}
      </v-alert>
      <div class="update-install__row">
        <v-icon icon="mdi-package-down" size="20" class="update-install__icon" aria-hidden="true" />
        <div class="update-install__text">
          <div
            class="update-install__title nd-mono nd-ellipsis"
            :title="result?.download?.fileName"
          >
            {{ result?.download?.fileName || `ElectronDB ${version}` }}
          </div>
          <div class="update-install__meta">
            <template v-if="result?.download"
              >{{ result.download.label }} · {{ formatBytes(result.download.sizeBytes) }}</template
            >
            <template v-if="state?.cancelled"> · Descarga cancelada</template>
          </div>
        </div>
        <v-btn
          color="primary"
          variant="flat"
          :prepend-icon="phase === 'error' ? 'mdi-refresh' : 'mdi-download'"
          data-test="update-start"
          @click="updates.startDownload()"
          >{{
            phase === 'error'
              ? 'Reintentar'
              : isMac
                ? 'Descargar instalador'
                : 'Descargar y actualizar'
          }}</v-btn
        >
      </div>
      <p v-if="isMac" class="update-install__hint" data-test="update-mac-why">
        En Mac la app descarga el <code>.dmg</code> y comprueba su suma SHA-256, pero no puede
        reemplazarse a sí misma: macOS solo permite la actualización automática a apps firmadas con
        un certificado de desarrollador de Apple, y ElectronDB todavía no lo tiene. Después solo
        tienes que arrastrar la app a Aplicaciones.
      </p>
      <p v-else class="update-install__hint">
        Se descarga desde las versiones de ElectronDB en GitHub y se comprueba antes de instalar.
        Tus conexiones, trabajos y ajustes se conservan.
      </p>
    </template>

    <div v-if="phase !== 'downloaded'" class="update-install__manual">
      <v-btn
        size="small"
        variant="text"
        append-icon="mdi-open-in-new"
        data-test="update-manual"
        @click="updates.downloadManually()"
        >Descargar manualmente</v-btn
      >
    </div>
  </div>
</template>

<style scoped>
.update-install {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.update-install__row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.update-install__icon {
  color: var(--nd-accent);
}
.update-install__row--ok .update-install__icon {
  color: var(--nd-success);
}
.update-install__text {
  flex: 1;
  min-width: 0;
}
.update-install__title {
  font-size: var(--nd-fs-dense);
  color: var(--nd-text);
}
.update-install__meta {
  font-size: var(--nd-fs-small);
  color: var(--nd-text-2);
}
.update-install__actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.update-install__steps {
  margin: 0;
  padding-left: 52px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text);
  line-height: 1.6;
}
.update-install__hint {
  margin: 0;
  font-size: var(--nd-fs-small);
  color: var(--nd-text-2);
}
.update-install__hint code {
  font-family: var(--nd-font-mono);
  font-size: 0.95em;
}
.update-install__manual {
  display: flex;
  justify-content: flex-end;
  margin-top: -4px;
}
</style>
