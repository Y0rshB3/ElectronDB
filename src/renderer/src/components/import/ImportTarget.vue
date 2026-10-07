<script setup lang="ts">
import { computed } from 'vue'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  backupConnections,
  environmentLabel,
  environmentPillClass
} from '@renderer/components/backups/backupHelpers'

/**
 * Target connection of a SQL import, with the typed-name confirmation of
 * guarded environments (production always, plus those of Ajustes › Seguridad).
 */
const props = defineProps<{ disabled?: boolean }>()
const connectionId = defineModel<string | null>('connectionId', { required: true })
const typedName = defineModel<string>('typedName', { required: true })

const connections = useConnectionsStore()
const settings = useSettingsStore()

const items = computed(() =>
  backupConnections(connections.sorted).map((c) => ({
    title: c.name,
    value: c.id,
    subtitle: environmentLabel(c.environment),
    pill: environmentPillClass(c.environment)
  }))
)
const target = computed(() =>
  connectionId.value ? connections.get(connectionId.value) : undefined
)
const needsTyped = computed(() => settings.needsTypedConfirm(target.value?.environment))

function onChange(id: string | null): void {
  connectionId.value = id
  typedName.value = ''
}
</script>

<template>
  <div class="import-target">
    <v-select
      :model-value="connectionId"
      :items="items"
      label="Conexión de destino"
      prepend-inner-icon="mdi-database-outline"
      :disabled="props.disabled"
      data-test="import-target"
      @update:model-value="onChange"
    >
      <template #item="{ props: itemProps, item }">
        <v-list-item v-bind="itemProps" :title="item.raw.title">
          <template #append>
            <span class="nd-pill" :class="item.raw.pill">{{ item.raw.subtitle }}</span>
          </template>
        </v-list-item>
      </template>
      <template #append-inner>
        <span v-if="target" class="nd-pill" :class="environmentPillClass(target.environment)">{{
          environmentLabel(target.environment)
        }}</span>
      </template>
    </v-select>
    <v-alert
      v-if="target && needsTyped"
      type="error"
      variant="tonal"
      density="compact"
      class="mb-3"
      data-test="import-typed-confirm"
    >
      <div class="mb-2">
        {{
          target.environment === 'production'
            ? `«${target.name}» es una conexión de PRODUCCIÓN.`
            : `«${target.name}» requiere confirmación (Ajustes › Seguridad).`
        }}
        Escribe su nombre para importar en ella.
      </div>
      <v-text-field
        v-model="typedName"
        :label="`Escribe «${target.name}»`"
        density="compact"
        hide-details
        :disabled="props.disabled"
        data-test="import-typed-name"
      />
    </v-alert>
  </div>
</template>
