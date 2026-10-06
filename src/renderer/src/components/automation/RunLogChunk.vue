<script setup lang="ts">
import type { LogRow } from './runLogModel'

/**
 * A block of run log lines. Kept as its own component so that, when new
 * lines arrive, only the block whose `rows` changed is patched again.
 */
defineProps<{
  rows: readonly LogRow[]
  /** data-test of each line. */
  lineTest?: string
  /** Summary block: the text after a token keeps the block colour. */
  plainRest?: boolean
}>()

function lineClass(line: LogRow): Record<string, boolean> {
  return {
    [`run-log__line--${line.kind}`]: true,
    [`run-log__line--tone-${line.tone}`]: !!line.tone && !line.token
  }
}
</script>

<template>
  <div class="run-log__chunk">
    <div
      v-for="line in rows"
      :key="line.n"
      class="run-log__line"
      :class="lineClass(line)"
      :data-test="lineTest ?? 'run-log-line'"
    >
      <span v-if="line.time" class="run-log__time">{{ line.time }}</span
      ><span class="run-log__text">{{ line.text }}</span
      ><span
        v-if="line.token"
        class="run-log__token"
        :class="`run-log__token--${line.tone}`"
        data-test="run-log-token"
        >{{ line.token }}</span
      ><span
        v-if="line.rest"
        class="run-log__rest"
        :class="plainRest ? undefined : `run-log__rest--${line.tone}`"
        >{{ line.rest }}</span
      >
    </div>
  </div>
</template>

<style scoped>
.run-log__chunk {
  /* Keeps the first heading's margin inside the block, so measured heights are exact. */
  display: flow-root;
}
.run-log__line {
  padding: 0 14px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.run-log__time {
  color: var(--nd-text-muted);
  margin-right: 10px;
  user-select: none;
}
.run-log__line--title {
  color: var(--nd-text-2);
}
.run-log__line--heading {
  margin-top: 10px;
  padding-top: 3px;
  padding-bottom: 3px;
  font-weight: 700;
  color: var(--nd-accent);
  background: rgba(var(--nd-accent-rgb), 0.07);
  border-top: 1px solid rgba(var(--nd-accent-rgb), 0.16);
}
.run-log__line--result {
  font-weight: 600;
}
.run-log__line--tone-error {
  color: var(--nd-error);
}
.run-log__line--tone-ok {
  color: var(--nd-success);
}
.run-log__line--tone-cancelled,
.run-log__line--tone-skipped {
  color: var(--nd-warning);
}
.run-log__token {
  font-weight: 700;
}
.run-log__token--ok {
  color: var(--nd-success);
}
.run-log__token--error,
.run-log__rest--error {
  color: var(--nd-error);
}
.run-log__token--cancelled,
.run-log__token--skipped {
  color: var(--nd-warning);
}
</style>
