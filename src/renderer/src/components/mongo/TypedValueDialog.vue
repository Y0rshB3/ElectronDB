<script setup lang="ts">
/**
 * Typed value editor of the grid and the tree (docs/multi-engine-design.md,
 * 9.1): the plain value plus a BSON type that defaults to the current one, so
 * typing `5` into an Int32 cell stays Int32. Documents and arrays are typed
 * as shell syntax and parsed in main.
 */
import { computed, ref, watch } from 'vue'
import {
  BSON_TYPE_LABELS,
  EDITABLE_TYPES,
  bsonTypeOf,
  isEditableType,
  plainValue,
  shellText,
  typedValue,
  type EditableType,
  type EjsonValue
} from '@shared/mongo/shellFormat'

const props = defineProps<{
  /** "addr.city" or "tags[2]". */
  label: string
  value: EjsonValue | undefined
  /** Adding a field to a document: asks for its name too. */
  askKey?: boolean
}>()
const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ save: [value: EjsonValue, key: string | null] }>()

const type = ref<EditableType>('string')
const text = ref('')
const key = ref('')
const error = ref('')

const TYPE_ITEMS = EDITABLE_TYPES.map((t) => ({ value: t, title: BSON_TYPE_LABELS[t] }))

watch(
  () => open.value,
  (isOpen) => {
    if (!isOpen) return
    error.value = ''
    key.value = ''
    const v = props.value
    const current = v === undefined ? 'string' : bsonTypeOf(v)
    type.value = isEditableType(current) ? current : 'string'
    text.value = v === undefined ? '' : isEditableType(current) ? plainValue(v) : shellText(v)
  },
  { immediate: true }
)

const placeholder = computed(
  () =>
    ({
      string: 'Texto',
      int: '42',
      long: '9007199254740993',
      double: '3.14',
      decimal: '19.90',
      bool: 'true / false',
      date: '2026-10-07T12:30:00Z',
      objectId: '24 caracteres hexadecimales',
      null: ''
    })[type.value]
)

function save(): void {
  if (props.askKey) {
    const k = key.value.trim()
    if (!k) {
      error.value = 'Escribe el nombre del campo.'
      return
    }
    if (k.includes('.') || k.startsWith('$')) {
      error.value = 'El nombre no puede contener «.» ni empezar por «$».'
      return
    }
  }
  const result = typedValue(type.value, text.value)
  if ('error' in result) {
    error.value = result.error
    return
  }
  emit('save', result.value, props.askKey ? key.value.trim() : null)
  open.value = false
}
</script>

<template>
  <v-dialog v-model="open" max-width="460">
    <v-card data-test="typed-value-dialog">
      <v-card-title class="text-subtitle-1">
        {{ askKey ? 'Añadir campo' : 'Editar valor' }} ·
        <span class="nd-mono">{{ label }}</span>
      </v-card-title>
      <v-card-text>
        <v-text-field
          v-if="askKey"
          v-model="key"
          label="Nombre del campo"
          class="nd-mono-input mb-2"
          autofocus
          data-test="typed-value-key"
        />
        <v-select
          v-model="type"
          :items="TYPE_ITEMS"
          label="Tipo BSON"
          class="mb-2"
          data-test="typed-value-type"
        />
        <v-switch
          v-if="type === 'bool'"
          :model-value="text === 'true'"
          :label="text === 'true' ? 'true' : 'false'"
          color="primary"
          density="compact"
          @update:model-value="text = $event ? 'true' : 'false'"
        />
        <v-textarea
          v-else-if="type === 'string'"
          v-model="text"
          label="Valor"
          rows="3"
          auto-grow
          variant="outlined"
          class="nd-mono-input"
          :autofocus="!askKey"
          data-test="typed-value-text"
        />
        <v-text-field
          v-else-if="type !== 'null'"
          v-model="text"
          label="Valor"
          :placeholder="placeholder"
          persistent-placeholder
          class="nd-mono-input"
          :autofocus="!askKey"
          data-test="typed-value-text"
          @keydown.enter.prevent="save"
        />
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-2">{{
          error
        }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">Cancelar</v-btn>
        <v-btn color="primary" variant="flat" data-test="typed-value-save" @click="save"
          >Aceptar</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
