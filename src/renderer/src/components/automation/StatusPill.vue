<script setup lang="ts">
import { computed } from 'vue'
import type { RunStatus } from '@shared/types'
import { RUN_STATUS } from './runStatus'

/** Run / step status as a pill with a glowing dot (pulses while running). */
const props = defineProps<{ status: RunStatus }>()

const TONES: Record<string, string> = {
  success: 'var(--nd-success)',
  error: 'var(--nd-error)',
  warning: 'var(--nd-warning)',
  info: 'var(--nd-info)',
  secondary: 'var(--nd-text-2)'
}

const info = computed(() => RUN_STATUS[props.status])
const tone = computed(() => TONES[info.value.color] ?? 'var(--nd-text-2)')
</script>

<template>
  <span
    class="nd-pill status-pill"
    :class="{ 'status-pill--live': status === 'running' || status === 'queued' }"
    :style="{ '--tone': tone }"
  >
    <span class="status-pill__dot" aria-hidden="true" />{{ info.label }}
  </span>
</template>

<style scoped>
.status-pill {
  color: var(--tone);
  background: color-mix(in srgb, var(--tone) 12%, transparent);
  border-color: color-mix(in srgb, var(--tone) 32%, transparent);
}
.status-pill__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--tone);
  box-shadow: 0 0 6px var(--tone);
}
.status-pill--live .status-pill__dot {
  animation: status-pulse 1.4s var(--nd-ease) infinite;
}
@keyframes status-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
</style>
