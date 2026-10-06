<script setup lang="ts">
import { computed } from 'vue'
import { useNotify, type NotifyLevel } from '@renderer/composables/useNotify'

/** Global snackbar fed by useNotify(); shows one message at a time, oldest first. */
const notify = useNotify()

const current = computed(() => notify.queue[0] ?? null)

const ICONS: Record<NotifyLevel, string> = {
  success: 'mdi-check-circle-outline',
  info: 'mdi-information-outline',
  warning: 'mdi-alert-outline',
  error: 'mdi-alert-circle-outline'
}

function runAction(): void {
  const item = current.value
  if (!item?.action) return
  notify.dismiss(item.id)
  item.action.handler()
}

const open = computed({
  get: () => !!current.value,
  set: (value: boolean) => {
    if (!value && current.value) notify.dismiss(current.value.id)
  }
})
</script>

<template>
  <v-snackbar
    v-if="current"
    :key="current.id"
    v-model="open"
    :class="['notify-host', `notify-host--${current.level}`]"
    :timeout="current.timeout"
    location="bottom center"
    multi-line
    :role="current.level === 'error' ? 'alert' : 'status'"
    data-test="notify"
  >
    <div class="notify-host__body">
      <span class="notify-host__icon" aria-hidden="true">
        <v-icon :icon="ICONS[current.level]" size="17" />
      </span>
      <span class="notify-host__message" data-test="notify-message">{{ current.message }}</span>
    </div>
    <template #actions>
      <span v-if="notify.queue.length > 1" class="notify-host__more nd-mono"
        >+{{ notify.queue.length - 1 }}</span
      >
      <v-btn
        v-if="current.action"
        variant="text"
        size="small"
        class="notify-host__action"
        data-test="notify-action"
        @click="runAction"
        >{{ current.action.label }}</v-btn
      >
      <v-btn
        variant="text"
        size="small"
        aria-label="Cerrar notificación"
        @click="notify.dismiss(current.id)"
        >Cerrar</v-btn
      >
    </template>
  </v-snackbar>
</template>

<style scoped>
.notify-host__body {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.notify-host__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 26px;
  height: 26px;
  margin-top: -3px;
  border-radius: 50%;
  color: var(--nd-level, var(--nd-info));
  background: var(--nd-level-soft, var(--nd-info-soft));
  border: 1px solid color-mix(in srgb, var(--nd-level, var(--nd-info)) 35%, transparent);
}
.notify-host__message {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
}
.notify-host__more {
  margin-right: 4px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.notify-host__action {
  color: var(--nd-accent) !important;
}
</style>

<style>
/* The snackbar wrapper is rendered by Vuetify (no scope id): level accent per message. */
.notify-host--success {
  --nd-level: var(--nd-success);
  --nd-level-soft: var(--nd-success-soft);
}
.notify-host--info {
  --nd-level: var(--nd-info);
  --nd-level-soft: var(--nd-info-soft);
}
.notify-host--warning {
  --nd-level: var(--nd-warning);
  --nd-level-soft: var(--nd-warning-soft);
}
.notify-host--error {
  --nd-level: var(--nd-error);
  --nd-level-soft: var(--nd-error-soft);
}
html .notify-host .v-snackbar__wrapper {
  min-width: 360px;
  max-width: 560px;
  border-left: 0;
  box-shadow:
    inset 3px 0 0 var(--nd-level),
    var(--nd-shadow-2);
}
html .notify-host--error .v-snackbar__wrapper {
  box-shadow:
    inset 3px 0 0 var(--nd-level),
    0 0 22px color-mix(in srgb, var(--nd-error) 22%, transparent),
    var(--nd-shadow-2);
}
</style>
