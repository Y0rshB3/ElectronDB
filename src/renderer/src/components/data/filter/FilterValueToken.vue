<script setup lang="ts">
import { nextTick, ref } from 'vue'
import TemporalInput from '../TemporalInput.vue'
import type { TemporalSpec } from '../temporal'

/**
 * Inline-editable value word of a filter line (Navicat "<?>"): a token that
 * turns into a small input on click. Enter commits and asks to apply, Escape
 * cancels, leaving the input commits.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string
    /** Input placeholder (format hint such as AAAA-MM-DD). */
    hint?: string
    inputmode?: 'decimal' | 'text'
    label: string
    /** Raw SQL token: monospace, wider. */
    sql?: boolean
    invalid?: boolean
    /** Date/time column compared by value: edit with the calendar picker. */
    temporal?: TemporalSpec | null
  }>(),
  { hint: '', inputmode: 'text', sql: false, invalid: false, temporal: null }
)

const emit = defineEmits<{ 'update:modelValue': [value: string]; submit: [] }>()

/** Placeholder for a value not typed yet. */
const EMPTY = '<?>'
const editing = ref(false)
const draft = ref('')
const input = ref<HTMLInputElement | null>(null)

async function start(): Promise<void> {
  draft.value = props.modelValue
  editing.value = true
  if (props.temporal) return // TemporalInput focuses itself
  await nextTick()
  input.value?.focus()
  input.value?.select()
}

function onTemporalCommit(value: string | null): void {
  editing.value = false
  const next = value ?? ''
  if (next !== props.modelValue) emit('update:modelValue', next)
}

function commit(): void {
  if (!editing.value) return
  editing.value = false
  if (draft.value !== props.modelValue) emit('update:modelValue', draft.value)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    event.stopPropagation()
    commit()
    emit('submit')
  } else if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    editing.value = false
  }
}

defineExpose({ start })
</script>

<template>
  <span v-if="editing && temporal" class="ftok-temporal" @click.stop>
    <TemporalInput
      v-model="draft"
      :spec="temporal"
      :label="label"
      autofocus
      @commit="onTemporalCommit"
      @cancel="editing = false"
      @leave="onTemporalCommit(draft)"
    />
  </span>
  <input
    v-else-if="editing"
    ref="input"
    v-model="draft"
    class="ftok-input"
    :class="{ 'is-sql': sql }"
    :size="Math.max(sql ? 28 : 6, draft.length + 1)"
    :placeholder="hint"
    :inputmode="inputmode"
    :aria-label="label"
    data-test="filter-value-input"
    @keydown="onKeydown"
    @blur="commit"
    @click.stop
  />
  <button
    v-else
    type="button"
    class="ftok ftok--value"
    :class="{ 'is-empty': modelValue === '', 'is-sql': sql, 'is-invalid': invalid }"
    :aria-label="`${label}: ${modelValue === '' ? 'sin valor' : modelValue}`"
    :title="hint ? `${label} (${hint})` : label"
    data-test="filter-value-token"
    @click.stop="start"
  >
    {{ modelValue === '' ? EMPTY : modelValue }}
  </button>
</template>

<style scoped src="./filterTokens.css"></style>
