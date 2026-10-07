<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { ImportLogEntry } from './importHelpers'

const props = defineProps<{ entries: ImportLogEntry[] }>()

const ICONS: Record<ImportLogEntry['tone'], string> = {
  ok: 'mdi-check',
  info: 'mdi-information-outline',
  warning: 'mdi-alert-outline',
  error: 'mdi-close-circle-outline',
  section: 'mdi-file-document-outline'
}

const box = ref<HTMLElement | null>(null)
/** Follows new lines unless the user scrolled up to read. */
let follow = true

function onScroll(): void {
  const el = box.value
  if (el) follow = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
}

watch(
  () => props.entries.length,
  async () => {
    if (!follow) return
    await nextTick()
    if (box.value) box.value.scrollTop = box.value.scrollHeight
  }
)
</script>

<template>
  <div
    ref="box"
    class="import-log nd-mono"
    role="log"
    aria-live="polite"
    data-test="import-log"
    @scroll="onScroll"
  >
    <div v-if="!entries.length" class="import-log__empty">Esperando…</div>
    <div
      v-for="e in entries"
      :key="e.id"
      class="import-log__line"
      :class="`import-log__line--${e.tone}`"
    >
      <v-icon :icon="ICONS[e.tone]" size="13" class="import-log__icon" aria-hidden="true" />
      <div class="import-log__text">
        <div>{{ e.text }}</div>
        <div v-if="e.detail" class="import-log__detail nd-ellipsis" :title="e.detail">
          {{ e.detail }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.import-log {
  height: 220px;
  overflow-y: auto;
  padding: 8px 10px;
  border-radius: var(--nd-radius-card);
  border: 1px solid var(--nd-border);
  background: var(--nd-bg-sunken);
  font-size: var(--nd-fs-xs);
  line-height: 1.5;
}
.import-log__empty {
  color: var(--nd-text-muted);
}
.import-log__line {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  color: var(--nd-text-2);
}
.import-log__icon {
  margin-top: 2px;
  flex: none;
}
.import-log__text {
  min-width: 0;
  flex: 1;
  overflow-wrap: anywhere;
}
.import-log__detail {
  color: var(--nd-text-muted);
}
.import-log__line--ok .import-log__icon {
  color: rgb(var(--v-theme-success));
}
.import-log__line--warning {
  color: rgb(var(--v-theme-warning));
}
.import-log__line--error {
  color: rgb(var(--v-theme-error));
}
.import-log__line--section {
  color: var(--nd-text);
  font-weight: 600;
  margin-top: 4px;
}
</style>
