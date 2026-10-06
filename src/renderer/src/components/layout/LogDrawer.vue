<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { LogEvent } from '@shared/types'
import { useLogStore } from '@renderer/stores/log'
import { useUiStore } from '@renderer/stores/ui'

const log = useLogStore()
const ui = useUiStore()
const scroller = ref<HTMLElement | null>(null)
const follow = ref(true)

const LEVELS: { value: LogEvent['level'] | 'all'; title: string }[] = [
  { value: 'all', title: 'Todos' },
  { value: 'debug', title: 'Depuración' },
  { value: 'info', title: 'Información' },
  { value: 'warn', title: 'Avisos' },
  { value: 'error', title: 'Errores' }
]

const LEVEL_CLASS: Record<LogEvent['level'], string> = {
  debug: 'log-drawer__line--debug',
  info: 'log-drawer__line--info',
  warn: 'log-drawer__line--warn',
  error: 'log-drawer__line--error'
}

function time(at: string): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : d.toLocaleTimeString('es', { hour12: false })
}

function onScroll(): void {
  const el = scroller.value
  if (el) follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}

watch(
  () => [log.filtered.length, ui.logDrawerVisible],
  async () => {
    if (!follow.value || !ui.logDrawerVisible) return
    await nextTick()
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
  }
)
</script>

<template>
  <section
    v-if="ui.logDrawerVisible"
    class="log-drawer"
    aria-label="Registro"
    data-test="log-drawer"
  >
    <div class="log-drawer__header">
      <v-icon icon="mdi-text-box-outline" size="15" class="log-drawer__header-icon" />
      <span class="log-drawer__title">Registro ({{ log.entries.length }})</span>
      <v-spacer />
      <v-select
        v-model="log.levelFilter"
        :items="LEVELS"
        item-title="title"
        item-value="value"
        density="compact"
        variant="outlined"
        hide-details
        class="log-drawer__filter"
        aria-label="Nivel"
      />
      <v-btn
        size="x-small"
        variant="text"
        prepend-icon="mdi-delete-sweep-outline"
        @click="log.clear()"
        >Limpiar</v-btn
      >
      <v-btn
        icon="mdi-close"
        size="x-small"
        variant="text"
        aria-label="Cerrar registro"
        @click="ui.toggleLogDrawer(false)"
      />
    </div>
    <div ref="scroller" class="log-drawer__body" @scroll="onScroll">
      <div v-if="!log.filtered.length" class="log-drawer__empty">Sin entradas.</div>
      <div
        v-for="(entry, i) in log.filtered"
        :key="i"
        class="log-drawer__line"
        :class="LEVEL_CLASS[entry.level]"
      >
        <span class="log-drawer__time">{{ time(entry.at) }}</span>
        <span class="log-drawer__level">{{ entry.level.toUpperCase() }}</span>
        <span class="log-drawer__scope">[{{ entry.scope }}]</span>
        <span class="log-drawer__msg">{{ entry.message }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.log-drawer {
  display: flex;
  flex-direction: column;
  height: 200px;
  flex: none;
  margin: 0 8px 8px;
  overflow: hidden;
  background: var(--nd-bg-panel);
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-card);
  box-shadow: var(--nd-shadow-inset);
}
.log-drawer__header {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 38px;
  padding: 0 6px 0 14px;
  border-bottom: 1px solid var(--nd-hairline);
  flex: none;
}
.log-drawer__header-icon {
  color: var(--nd-text-muted);
}
.log-drawer__title {
  font-size: var(--nd-fs-dense);
  font-weight: 600;
  color: var(--nd-text);
}
.log-drawer__filter {
  max-width: 150px;
  font-size: var(--nd-fs-dense);
}
.log-drawer__filter :deep(.v-field__input) {
  min-height: 28px;
  padding-top: 2px;
  padding-bottom: 2px;
  font-size: var(--nd-fs-dense);
}
.log-drawer__body {
  flex: 1;
  overflow: auto;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  line-height: 1.7;
  padding: 4px 0;
  user-select: text;
}
.log-drawer__empty {
  padding: 10px 14px;
  font-family: var(--nd-font-ui);
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.log-drawer__line {
  display: flex;
  gap: 10px;
  padding: 0 14px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--nd-text);
}
.log-drawer__line:hover {
  background: var(--nd-hover);
}
.log-drawer__time,
.log-drawer__scope {
  flex: none;
  color: var(--nd-text-muted);
}
.log-drawer__level {
  flex: none;
  width: 44px;
  font-weight: 600;
  color: var(--nd-text-2);
}
.log-drawer__line--debug {
  color: var(--nd-text-2);
}
.log-drawer__line--debug .log-drawer__level {
  color: var(--nd-text-muted);
}
.log-drawer__line--info .log-drawer__level {
  color: var(--nd-info);
}
.log-drawer__line--warn {
  color: var(--nd-warning);
}
.log-drawer__line--warn .log-drawer__level {
  color: var(--nd-warning);
}
.log-drawer__line--error {
  color: var(--nd-error);
  background: color-mix(in srgb, var(--nd-error) 6%, transparent);
}
.log-drawer__line--error .log-drawer__level {
  color: var(--nd-error);
}
</style>
