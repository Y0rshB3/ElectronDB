<script setup lang="ts">
import { computed, useId } from 'vue'
import {
  REPLACE_CONTENT_LABEL,
  STRUCTURE_ONLY_LABEL,
  WITH_DATA_LABEL,
  replaceContentHint
} from './replaceContent'

/**
 * «Contenido» of a REPLACE restore: «Estructura y datos» (true, default) or
 * «Solo estructura» (false). v-model is the request's `includeData`.
 */
const includeData = defineModel<boolean>({ default: true })
defineProps<{ disabled?: boolean }>()

const id = useId()
const hint = computed(() => replaceContentHint(includeData.value))
</script>

<template>
  <div class="replace-content" data-test="replace-content">
    <div :id="`${id}-label`" class="replace-content__label">{{ REPLACE_CONTENT_LABEL }}</div>
    <v-btn-toggle
      v-model="includeData"
      mandatory
      divided
      density="compact"
      variant="outlined"
      class="replace-content__toggle"
      role="group"
      :aria-labelledby="`${id}-label`"
      :aria-describedby="`${id}-hint`"
      :disabled="disabled"
    >
      <v-btn :value="true" prepend-icon="mdi-table-large" data-test="replace-content-data">{{
        WITH_DATA_LABEL
      }}</v-btn>
      <v-btn :value="false" prepend-icon="mdi-table-key" data-test="replace-content-structure">{{
        STRUCTURE_ONLY_LABEL
      }}</v-btn>
    </v-btn-toggle>
    <div :id="`${id}-hint`" class="replace-content__hint" data-test="replace-content-hint">
      {{ hint }}
    </div>
  </div>
</template>

<style scoped>
.replace-content__label {
  margin-bottom: 4px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.replace-content__toggle :deep(.v-btn) {
  text-transform: none;
}
.replace-content__hint {
  margin-top: 4px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
  line-height: 1.4;
}
</style>
