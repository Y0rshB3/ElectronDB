<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import DialogHeader from '@renderer/components/dialogs/DialogHeader.vue'
import { useUpdatesStore } from '@renderer/stores/updates'
import { releaseHighlights } from './highlights'
import { formatReleaseDate } from './updateFormat'

/**
 * «Hay una nueva actualización»: centered popup of the automatic startup check
 * with only the highlights of the release (the full notes stay in UpdateDialog).
 * Closing it without choosing counts as «Más tarde».
 */
const updates = useUpdatesStore()

const result = computed(() => updates.result)
const packaged = computed(() => result.value?.runMode === 'packaged')
const source = computed(() => result.value?.source)
const published = computed(() => formatReleaseDate(result.value?.publishedAt))
const highlights = computed(() => releaseHighlights(result.value?.notes))
const commandsText = computed(() => source.value?.commands.join('\n') ?? '')
const showCommands = ref(false)

const open = computed({
  get: () => updates.noticeOpen && result.value?.status === 'available',
  set: (value: boolean) => {
    if (!value && updates.noticeOpen) void updates.later()
  }
})

watch(
  () => updates.noticeOpen,
  (value) => {
    if (value) showCommands.value = false
  }
)

function primary(): void {
  if (source.value) showCommands.value = !showCommands.value
  else updates.showDetails()
}
</script>

<template>
  <v-dialog v-model="open" max-width="640" scrollable>
    <v-card v-if="result" data-test="update-notice" aria-labelledby="update-notice-title">
      <DialogHeader icon="mdi-rocket-launch-outline" title="Hay una nueva actualización">
        <template #subtitle>
          <span id="update-notice-title" data-test="update-notice-subtitle"
            >Vortaq {{ result.latestVersion }} ya está disponible (tienes
            {{ result.currentVersion }})</span
          >
        </template>
      </DialogHeader>
      <v-card-text class="update-popup__body">
        <div class="update-popup__label">
          Lo más destacado<template v-if="published"> · {{ published }}</template>
        </div>
        <ul v-if="highlights.length" class="update-popup__list" data-test="update-highlights">
          <li v-for="(line, index) in highlights" :key="index">
            <v-icon icon="mdi-check-circle-outline" size="16" aria-hidden="true" />
            <span>{{ line }}</span>
          </li>
        </ul>
        <p v-else class="update-popup__empty">
          Consulta todas las novedades de esta versión antes de actualizar.
        </p>

        <section
          v-if="!packaged && source && showCommands"
          class="update-popup__commands"
          aria-label="Cómo actualizar"
          data-test="update-notice-commands"
        >
          <p class="update-popup__hint">
            Esta copia se ejecuta desde el código fuente en
            <code class="nd-mono">{{ source.dir }}</code
            >. Cierra la app y ejecuta en una terminal:
          </p>
          <v-alert
            v-if="!source.isGit"
            type="warning"
            variant="tonal"
            density="compact"
            class="mb-2"
          >
            Esta carpeta no es un repositorio git: descarga el código de la nueva versión desde
            GitHub.
          </v-alert>
          <div class="update-popup__terminal">
            <div class="update-popup__bar">
              <span class="update-popup__bar-label">
                <v-icon icon="mdi-console" size="14" aria-hidden="true" />Terminal
              </span>
              <v-btn
                size="x-small"
                variant="text"
                prepend-icon="mdi-content-copy"
                data-test="update-notice-copy"
                @click="updates.copyCommands()"
                >Copiar comandos</v-btn
              >
            </div>
            <pre class="nd-mono">{{ commandsText }}</pre>
          </div>
        </section>
      </v-card-text>
      <v-card-actions class="update-popup__actions">
        <v-btn
          variant="text"
          class="update-popup__skip"
          data-test="update-notice-skip"
          @click="updates.dismissVersion()"
          >Omitir esta versión</v-btn
        >
        <v-spacer />
        <v-btn variant="text" data-test="update-notice-later" @click="updates.later()"
          >Más tarde</v-btn
        >
        <v-btn variant="tonal" data-test="update-notice-notes" @click="updates.showDetails()"
          >Ver todas las novedades</v-btn
        >
        <v-btn
          v-if="packaged && updates.selfUpdate"
          color="primary"
          variant="flat"
          prepend-icon="mdi-download"
          data-test="update-notice-update"
          @click="updates.downloadFromNotice()"
          >{{
            updates.installPhase === 'downloaded'
              ? 'Ver actualización descargada'
              : updates.installMode === 'mac-dmg'
                ? 'Descargar instalador'
                : 'Descargar y actualizar'
          }}</v-btn
        >
        <v-btn
          v-else-if="packaged"
          color="primary"
          variant="flat"
          prepend-icon="mdi-download"
          data-test="update-notice-download"
          @click="updates.download()"
          >Descargar</v-btn
        >
        <v-btn
          v-else
          color="primary"
          variant="flat"
          prepend-icon="mdi-console"
          :aria-expanded="source ? String(showCommands) : undefined"
          data-test="update-notice-howto"
          @click="primary"
          >Cómo actualizar</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.update-popup__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 4px !important;
}
.update-popup__label {
  font-size: var(--nd-fs-small);
  font-weight: 600;
  color: var(--nd-text-2);
}
.update-popup__list {
  list-style: none;
  margin: 0;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border);
}
.update-popup__list li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: var(--nd-text);
  line-height: 1.45;
}
.update-popup__list .v-icon {
  flex: none;
  margin-top: 2px;
  color: var(--nd-accent);
}
.update-popup__empty {
  margin: 0;
  color: var(--nd-text-2);
  font-size: var(--nd-fs-dense);
}
.update-popup__hint {
  margin: 0 0 8px;
  color: var(--nd-text);
  font-size: var(--nd-fs-dense);
}
.update-popup__hint code {
  font-size: 0.95em;
  overflow-wrap: anywhere;
}
.update-popup__terminal {
  border-radius: var(--nd-radius-control);
  background: var(--nd-bg-sunken);
  border: 1px solid var(--nd-border);
  overflow: hidden;
}
.update-popup__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 4px 3px 12px;
  border-bottom: 1px solid var(--nd-hairline);
}
.update-popup__bar-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--nd-fs-small);
  color: var(--nd-text-2);
}
.update-popup__terminal pre {
  margin: 0;
  padding: 10px 12px;
  font-size: var(--nd-fs-dense);
  line-height: 1.6;
  color: var(--nd-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
.update-popup__actions {
  flex-wrap: wrap;
  gap: 4px;
}
.update-popup__skip {
  color: var(--nd-text-2);
}
</style>
