<script setup lang="ts">
import { api } from '@renderer/api'

const props = defineProps<{
  label: string
  kind: 'file' | 'directory'
  filters?: { name: string; extensions: string[] }[]
  hint?: string
  disabled?: boolean
}>()

const model = defineModel<string>({ default: '' })

async function pick(): Promise<void> {
  const result =
    props.kind === 'directory'
      ? await api.app.pickDirectory(props.label)
      : await api.app.pickFile(props.label, props.filters)
  if (result) model.value = result
}
</script>

<template>
  <v-text-field
    v-model="model"
    :label="label"
    :hint="hint"
    :persistent-hint="!!hint"
    :disabled="disabled"
    :append-inner-icon="
      kind === 'directory' ? 'mdi-folder-open-outline' : 'mdi-file-search-outline'
    "
    @click:append-inner="pick"
  >
    <template v-if="model" #append>
      <v-btn
        icon="mdi-close"
        size="x-small"
        variant="text"
        :aria-label="`Limpiar ${label}`"
        @click="model = ''"
      />
    </template>
  </v-text-field>
</template>
