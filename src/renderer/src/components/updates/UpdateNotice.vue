<script setup lang="ts">
import { computed } from 'vue'
import { useUpdatesStore } from '@renderer/stores/updates'
import { formatReleaseDate } from './updateFormat'

/** Non-blocking card (bottom right) shown when the startup check finds a new version. */
const updates = useUpdatesStore()

const result = computed(() => updates.result)
const packaged = computed(() => result.value?.runMode === 'packaged')
const published = computed(() => formatReleaseDate(result.value?.publishedAt))
</script>

<template>
  <transition name="update-notice">
    <aside
      v-if="updates.noticeOpen && result?.status === 'available'"
      class="update-notice nd-glass"
      role="status"
      aria-live="polite"
      aria-labelledby="update-notice-title"
      data-test="update-notice"
    >
      <div class="update-notice__head">
        <span class="nd-icon-badge" aria-hidden="true">
          <v-icon icon="mdi-rocket-launch-outline" size="18" />
        </span>
        <div class="update-notice__text">
          <h2 id="update-notice-title" class="update-notice__title">
            Nueva versión {{ result.latestVersion }} disponible
          </h2>
          <p class="update-notice__subtitle">
            Tienes la {{ result.currentVersion
            }}<template v-if="published"> · publicada el {{ published }}</template>
          </p>
        </div>
        <v-btn
          icon="mdi-close"
          size="x-small"
          variant="text"
          aria-label="Cerrar aviso de actualización"
          data-test="update-notice-close"
          @click="updates.hideNotice()"
        />
      </div>
      <div class="update-notice__actions">
        <v-btn
          variant="text"
          size="small"
          class="update-notice__skip"
          data-test="update-notice-skip"
          @click="updates.dismissVersion()"
          >Omitir esta versión</v-btn
        >
        <v-spacer />
        <v-btn
          variant="tonal"
          size="small"
          data-test="update-notice-notes"
          @click="updates.showDetails()"
          >Ver novedades</v-btn
        >
        <v-btn
          v-if="packaged"
          color="primary"
          variant="flat"
          size="small"
          prepend-icon="mdi-download"
          data-test="update-notice-download"
          @click="updates.download()"
          >Descargar</v-btn
        >
        <v-btn
          v-else
          color="primary"
          variant="flat"
          size="small"
          prepend-icon="mdi-console"
          data-test="update-notice-howto"
          @click="updates.showDetails()"
          >Cómo actualizar</v-btn
        >
      </div>
    </aside>
  </transition>
</template>

<style scoped>
.update-notice {
  position: fixed;
  right: 16px;
  bottom: calc(var(--nd-statusbar-h) + 14px);
  z-index: 2000;
  width: 440px;
  max-width: calc(100vw - 32px);
  padding: 14px 14px 10px;
  border-radius: var(--nd-radius-card);
  border: 1px solid var(--nd-border-strong);
  box-shadow: var(--nd-shadow-2);
}
.update-notice__head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.update-notice__text {
  flex: 1;
  min-width: 0;
}
.update-notice__title {
  margin: 1px 0 0;
  font-size: var(--nd-fs-base);
  font-weight: var(--nd-fw-heading);
  color: var(--nd-text);
}
.update-notice__subtitle {
  margin: 2px 0 0;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.update-notice__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
}
.update-notice__skip {
  color: var(--nd-text-2);
  margin-left: -6px;
}
.update-notice-enter-active,
.update-notice-leave-active {
  transition:
    opacity var(--nd-dur-slow) var(--nd-ease),
    transform var(--nd-dur-slow) var(--nd-ease);
}
.update-notice-enter-from,
.update-notice-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
