<script setup lang="ts">
import { computed } from 'vue'
import type { ConnectionConfig } from '@shared/types'
import { environmentLabel, environmentPillClass } from '@renderer/components/backups/backupHelpers'

/**
 * Connection selector of the query toolbar (presentational): colour dot, name
 * and environment pill per connection; production is tinted red. Switching
 * logic (guards, opening, reloading) lives in the view.
 */
const props = defineProps<{
  modelValue: string
  connections: ConnectionConfig[]
  disabled?: boolean
  /** Tooltip explaining why the picker is disabled. */
  disabledReason?: string | null
}>()

const emit = defineEmits<{ 'update:modelValue': [id: string] }>()

const current = computed(() => props.connections.find((c) => c.id === props.modelValue))
const production = computed(() => current.value?.environment === 'production')
const title = computed(() => {
  if (props.disabled && props.disabledReason) return props.disabledReason
  const c = current.value
  if (!c) return 'Conexión de la consulta'
  return production.value
    ? `Conexión: ${c.name} (PRODUCCIÓN: las escrituras piden confirmación)`
    : `Conexión: ${c.name}`
})
</script>

<template>
  <v-select
    :model-value="modelValue || null"
    :items="connections"
    item-title="name"
    item-value="id"
    placeholder="Conexión"
    aria-label="Conexión"
    density="compact"
    hide-details
    :disabled="disabled"
    :title="title"
    no-data-text="Sin conexiones"
    class="query-conn"
    :class="{ 'is-production': production }"
    :menu-props="{ maxHeight: 360 }"
    data-test="connection"
    @update:model-value="$event && emit('update:modelValue', $event)"
  >
    <template #selection="{ item }">
      <span class="query-conn__value" data-test="connection-selection">
        <span
          class="nd-dot query-conn__dot"
          :style="{ '--nd-dot': item.raw.color ?? 'transparent' }"
          aria-hidden="true"
        />
        <span class="query-conn__name nd-ellipsis">{{ item.raw.name }}</span>
        <span
          class="nd-pill query-conn__pill"
          :class="environmentPillClass(item.raw.environment)"
          data-test="connection-env"
          >{{ environmentLabel(item.raw.environment) }}</span
        >
      </span>
    </template>
    <template #item="{ item, props: itemProps }">
      <v-list-item
        v-bind="itemProps"
        :title="undefined"
        density="compact"
        :data-test="`connection-option-${item.raw.id}`"
      >
        <span class="query-conn__value">
          <span
            class="nd-dot query-conn__dot"
            :style="{ '--nd-dot': item.raw.color ?? 'transparent' }"
            aria-hidden="true"
          />
          <span class="query-conn__name nd-ellipsis">{{ item.raw.name }}</span>
          <span class="nd-pill query-conn__pill" :class="environmentPillClass(item.raw.environment)"
            ><v-icon
              v-if="item.raw.environment === 'production'"
              icon="mdi-shield-alert-outline"
              size="12"
              aria-hidden="true"
            />{{ environmentLabel(item.raw.environment) }}</span
          >
        </span>
      </v-list-item>
    </template>
  </v-select>
</template>

<style scoped>
.query-conn {
  flex: 3 1 190px;
  min-width: 190px;
  max-width: 280px;
}
.query-conn__value {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  max-width: 100%;
}
.query-conn__name {
  min-width: 0;
  font-size: var(--nd-fs-dense);
}
.query-conn__pill {
  flex: none;
}
/* Production: the field itself turns red so the target is obvious before running anything. */
.query-conn.is-production :deep(.v-field) {
  background: var(--nd-error-soft);
}
.query-conn.is-production :deep(.v-field__outline) {
  --v-field-border-opacity: 1;
  color: color-mix(in srgb, var(--nd-error) 70%, transparent);
}
</style>
