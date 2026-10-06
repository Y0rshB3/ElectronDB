<script setup lang="ts">
import { computed } from 'vue'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useLogStore } from '@renderer/stores/log'
import { useProgressStore } from '@renderer/stores/progress'
import { useUiStore } from '@renderer/stores/ui'
import { useObjectsContext } from '@renderer/composables/useObjectsContext'

const connections = useConnectionsStore()
const progress = useProgressStore()
const log = useLogStore()
const ui = useUiStore()
const { summary } = useObjectsContext()

const connectionsText = computed(() => {
  const n = connections.items.length
  return `${n} ${n === 1 ? 'Conexión' : 'Conexiones'} en Mis Conexiones`
})
const openText = computed(() => {
  const n = connections.openIds.length
  return n ? `${n} ${n === 1 ? 'abierta' : 'abiertas'}` : ''
})
</script>

<template>
  <footer class="status-bar" role="status" aria-live="polite">
    <div v-if="progress.latestMessage" class="status-bar__sweep" aria-hidden="true">
      <span />
    </div>
    <span
      class="status-bar__live"
      :class="{ 'status-bar__live--on': connections.openIds.length > 0 }"
      aria-hidden="true"
    />
    <span data-test="status-connections">{{ connectionsText }}</span>
    <span v-if="openText" class="status-bar__muted">· {{ openText }}</span>
    <span v-if="summary" class="status-bar__sep" data-test="status-objects">{{ summary }}</span>
    <v-spacer />
    <span v-if="progress.latestMessage" class="status-bar__progress" data-test="status-progress">
      <span class="status-bar__bar" aria-hidden="true"><span /></span>
      <span class="status-bar__progress-text">{{ progress.latestMessage }}</span>
    </span>
    <button
      type="button"
      class="status-bar__btn"
      :aria-pressed="ui.logDrawerVisible"
      title="Registro"
      data-test="status-log"
      @click="ui.toggleLogDrawer()"
    >
      <v-icon icon="mdi-text-box-outline" size="13" />
      Registro
      <span v-if="log.errorCount" class="status-bar__badge">{{ log.errorCount }}</span>
    </button>
    <button
      type="button"
      class="status-bar__btn"
      :aria-pressed="ui.infoPanelVisible"
      :title="ui.infoPanelVisible ? 'Ocultar panel de información' : 'Mostrar panel de información'"
      :aria-label="
        ui.infoPanelVisible ? 'Ocultar panel de información' : 'Mostrar panel de información'
      "
      data-test="status-info"
      @click="ui.toggleInfoPanel()"
    >
      <v-icon icon="mdi-dock-right" size="13" />
    </button>
  </footer>
</template>

<style scoped>
.status-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--nd-statusbar-h);
  padding: 0 8px 0 14px;
  font-family: var(--nd-font-mono);
  font-size: 10.5px;
  font-variant-ligatures: none;
  background: var(--nd-bg-app);
  border-top: 1px solid var(--nd-hairline);
  color: var(--nd-text-2);
  white-space: nowrap;
  overflow: hidden;
  flex: none;
}
.status-bar__live {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--nd-text-muted);
  opacity: 0.6;
}
.status-bar__live--on {
  background: var(--nd-success);
  box-shadow: 0 0 6px var(--nd-success);
  opacity: 1;
}
.status-bar__muted {
  color: var(--nd-text-muted);
}
.status-bar__sep {
  padding-left: 10px;
  border-left: 1px solid var(--nd-border);
}
.status-bar__progress {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 45%;
  color: var(--nd-accent);
}
.status-bar__progress-text {
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Thin indeterminate gradient bar next to the live message. */
.status-bar__bar {
  position: relative;
  flex: none;
  width: 56px;
  height: 3px;
  overflow: hidden;
  border-radius: var(--nd-radius-pill);
  background: var(--nd-hairline);
}
.status-bar__bar > span,
.status-bar__sweep > span {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 40%;
  border-radius: inherit;
  background: var(--nd-accent-gradient-h);
  animation: nd-status-sweep 1.4s var(--nd-ease) infinite;
}
/* Same sweep along the top edge of the bar. */
.status-bar__sweep {
  position: absolute;
  top: -1px;
  left: 0;
  right: 0;
  height: 2px;
  overflow: hidden;
  pointer-events: none;
}
.status-bar__sweep > span {
  box-shadow: 0 0 8px rgba(var(--nd-accent-rgb), 0.6);
}
@keyframes nd-status-sweep {
  from {
    left: -40%;
  }
  to {
    left: 100%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .status-bar__bar > span {
    animation: none;
    left: 0;
    width: 100%;
  }
  .status-bar__sweep {
    display: none;
  }
}
.status-bar__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  padding: 0 7px;
  height: 18px;
  border-radius: var(--nd-radius-sm);
  transition:
    background-color var(--nd-dur-fast) var(--nd-ease),
    color var(--nd-dur-fast) var(--nd-ease);
}
.status-bar__btn:hover {
  background: var(--nd-hover);
  color: var(--nd-text);
}
.status-bar__btn[aria-pressed='true'] {
  background: var(--nd-selected);
  color: var(--nd-accent);
}
.status-bar__badge {
  min-width: 16px;
  padding: 0 5px;
  border-radius: var(--nd-radius-pill);
  background: var(--nd-error-soft);
  color: var(--nd-error);
  border: 1px solid color-mix(in srgb, var(--nd-error) 40%, transparent);
  font-size: 10px;
  line-height: 13px;
  text-align: center;
}
</style>
