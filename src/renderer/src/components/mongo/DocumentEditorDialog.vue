<script setup lang="ts">
/**
 * Whole-document editor (docs/multi-engine-design.md, 9.2): shell-syntax
 * text, parsed in main with shell-bson-parser. Editing an existing document
 * replaces it, which the view only allows for documents loaded whole (it
 * fetches the full document first); `_id` cannot change.
 */
import { ref, watch } from 'vue'
import SqlEditor from '@renderer/components/common/SqlEditor.vue'

const props = defineProps<{
  title: string
  subtitle?: string
  /** Initial shell text. */
  text: string
  saving?: boolean
  error?: string | null
  readonly?: boolean
  saveLabel?: string
}>()
const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ save: [text: string] }>()

const draft = ref('')
watch(
  () => [open.value, props.text] as const,
  ([isOpen]) => {
    if (isOpen) draft.value = props.text
  },
  { immediate: true }
)
</script>

<template>
  <v-dialog v-model="open" max-width="820" scrollable>
    <v-card data-test="document-editor">
      <v-card-title class="d-flex align-center ga-2">
        <v-icon icon="mdi-file-document-edit-outline" size="20" />
        <span class="text-subtitle-1">{{ title }}</span>
        <span v-if="subtitle" class="text-caption text-medium-emphasis nd-mono nd-ellipsis">{{
          subtitle
        }}</span>
      </v-card-title>
      <v-card-text class="document-editor__body">
        <div class="document-editor__editor">
          <SqlEditor
            v-model="draft"
            engine="mongodb"
            :readonly="readonly"
            min-height="360px"
            @save="!readonly && emit('save', draft)"
          />
        </div>
        <div class="text-caption text-medium-emphasis mt-2">
          Sintaxis del shell: ObjectId('…'), ISODate('…'), NumberLong('…'), NumberDecimal('…'),
          NumberInt(…), UUID('…'). Los tipos se conservan; el _id no se puede cambiar.
        </div>
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-2">{{
          error
        }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">{{ readonly ? 'Cerrar' : 'Cancelar' }}</v-btn>
        <v-btn
          v-if="!readonly"
          color="primary"
          variant="flat"
          :loading="saving"
          data-test="document-editor-save"
          @click="emit('save', draft)"
          >{{ saveLabel ?? 'Guardar' }}</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.document-editor__editor {
  height: 420px;
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-control);
  overflow: hidden;
}
</style>
