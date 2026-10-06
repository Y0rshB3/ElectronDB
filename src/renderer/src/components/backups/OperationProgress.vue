<script setup lang="ts">
import { computed } from 'vue'
import { useProgressStore } from '@renderer/stores/progress'
import { describeProgress } from '@renderer/stores/progressText'

const props = defineProps<{
  operationId: string | null
  label: string
  cancelling?: boolean
}>()

const emit = defineEmits<{ cancel: [] }>()

const progress = useProgressStore()
const entry = computed(() =>
  props.operationId ? progress.operations[props.operationId] : undefined
)
const view = computed(() => (entry.value ? describeProgress(entry.value) : null))
const percent = computed(() => view.value?.percent ?? null)
</script>

<template>
  <div class="operation-progress" role="status" aria-live="polite" data-test="operation-progress">
    <div class="operation-progress__head">
      <span class="operation-progress__spinner" aria-hidden="true" />
      <span class="operation-progress__label nd-ellipsis" :title="label">{{ label }}</span>
      <span v-if="percent !== null" class="operation-progress__percent nd-mono"
        >{{ percent }}%</span
      >
      <v-btn
        size="small"
        color="error"
        variant="text"
        prepend-icon="mdi-stop-circle-outline"
        :loading="cancelling"
        data-test="operation-cancel"
        @click="emit('cancel')"
      >
        Cancelar
      </v-btn>
    </div>
    <div
      class="nd-progress operation-progress__track"
      :class="{ 'operation-progress__track--indeterminate': percent === null }"
      role="progressbar"
      :aria-label="label"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="percent ?? undefined"
    >
      <span :style="percent === null ? undefined : { width: `${percent}%` }" />
    </div>
    <div class="operation-progress__detail">
      <template v-if="entry && view">
        {{ view.message || entry.message || entry.phase }}
        <span v-if="view.counter" class="nd-mono"> · {{ view.counter }}</span>
      </template>
      <template v-else>Iniciando…</template>
    </div>
  </div>
</template>

<style scoped>
.operation-progress {
  padding: 12px 14px;
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-raised);
  border: 1px solid rgba(var(--nd-accent-rgb), 0.22);
  box-shadow: var(--nd-shadow-inset);
}
.operation-progress__head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.operation-progress__spinner {
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid rgba(var(--nd-accent-rgb), 0.2);
  border-top-color: var(--nd-cyan);
  border-right-color: var(--nd-violet);
  animation: op-spin 0.9s linear infinite;
}
.operation-progress__label {
  flex: 1;
  font-weight: 600;
  color: var(--nd-text);
}
.operation-progress__percent {
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.operation-progress__track {
  height: 4px;
}
.operation-progress__track > span {
  box-shadow: 0 0 10px rgba(var(--nd-accent-rgb), 0.45);
}
.operation-progress__track--indeterminate > span {
  width: 35%;
  animation: op-indeterminate 1.2s var(--nd-ease) infinite;
}
.operation-progress__detail {
  margin-top: 8px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
@keyframes op-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes op-indeterminate {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(300%);
  }
}
</style>
