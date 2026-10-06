<script setup lang="ts">
import type { QueryStatementResult } from '@shared/types'
import { formatDuration, formatNumber } from '@renderer/utils/format'

defineProps<{
  results: QueryStatementResult[]
  /** Free-form notice shown on top (e.g. stopped execution). */
  notice?: string | null
  /** Show «Explicar error» on failed statements (AI assistant enabled). */
  canExplain?: boolean
}>()
const emit = defineEmits<{ 'explain-error': [result: QueryStatementResult] }>()

function summary(r: QueryStatementResult): string {
  if (r.error) return r.error
  if (r.resultSet)
    return `${formatNumber(r.resultSet.rows.length)} fila(s) devuelta(s)${r.resultSet.truncated ? ' (truncado)' : ''}`
  const parts = [`${formatNumber(r.affectedRows ?? 0)} fila(s) afectada(s)`]
  if (r.insertId) parts.push(`último id ${r.insertId}`)
  if (r.warnings) parts.push(`${r.warnings} aviso(s)`)
  return parts.join(' · ')
}
</script>

<template>
  <div class="query-messages" role="log" aria-live="polite">
    <div v-if="notice" class="query-messages__notice">
      <v-icon icon="mdi-alert-outline" size="16" />
      <span>{{ notice }}</span>
    </div>
    <div v-if="!results.length && !notice" class="query-messages__empty">
      <v-icon icon="mdi-console-line" size="34" class="query-messages__empty-icon" />
      <div>Sin mensajes. Ejecuta una consulta para ver resultados.</div>
      <div class="query-messages__hint">Cmd+R o Cmd+Enter ejecuta el editor o la selección.</div>
    </div>
    <div
      v-for="(r, i) in results"
      :key="i"
      class="query-messages__item"
      :class="r.error ? 'is-error' : 'is-ok'"
      :data-test="`message-${i}`"
    >
      <span class="query-messages__dot" role="img" :aria-label="r.error ? 'Error' : 'Correcto'" />
      <div class="query-messages__body">
        <code class="query-messages__sql" :title="r.sql">{{ r.sql }}</code>
        <div class="query-messages__summary">{{ summary(r) }}</div>
        <v-btn
          v-if="r.error && canExplain"
          size="x-small"
          variant="tonal"
          color="primary"
          prepend-icon="mdi-creation-outline"
          class="query-messages__explain"
          title="Pregunta al asistente de IA por qué falla (se envían el SQL y el mensaje de error)"
          :data-test="`explain-error-${i}`"
          @click="emit('explain-error', r)"
          >Explicar error</v-btn
        >
      </div>
      <span class="query-messages__time">{{ formatDuration(r.durationMs) }}</span>
    </div>
  </div>
</template>

<style scoped>
.query-messages {
  overflow: auto;
  height: 100%;
  padding: 6px 0;
  font-size: var(--nd-fs-dense);
}
.query-messages__notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 4px 12px 8px;
  padding: 8px 12px;
  border-radius: var(--nd-radius-control);
  color: var(--nd-warning);
  background: var(--nd-warning-soft);
  border: 1px solid color-mix(in srgb, var(--nd-warning) 30%, transparent);
}
.query-messages__notice > span {
  color: var(--nd-text);
}
.query-messages__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 100%;
  min-height: 120px;
  text-align: center;
  color: var(--nd-text-2);
}
.query-messages__empty-icon {
  margin-bottom: 6px;
  color: var(--nd-accent);
  opacity: 0.8;
}
.query-messages__hint {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.query-messages__item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--nd-hairline);
  transition: background-color var(--nd-dur-fast) var(--nd-ease);
}
.query-messages__item:hover {
  background: var(--nd-hover);
}
.query-messages__dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--nd-success);
  box-shadow: 0 0 8px var(--nd-success);
}
.is-error .query-messages__dot {
  background: var(--nd-error);
  box-shadow: 0 0 8px var(--nd-error);
}
.query-messages__body {
  flex: 1 1 auto;
  min-width: 0;
}
.query-messages__sql {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
  color: var(--nd-text);
  background: none;
  padding: 0;
}
.query-messages__summary {
  margin-top: 2px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.is-error .query-messages__summary {
  color: var(--nd-error);
}
.query-messages__explain {
  margin-top: 6px;
}
.query-messages__time {
  flex: none;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  font-variant-numeric: tabular-nums;
  color: var(--nd-text-muted);
}
</style>
