<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { AI_PRIVACY_LINE } from '@shared/ai'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { extractSql, useAiStore } from '@renderer/stores/ai'
import DialogHeader from '@renderer/components/dialogs/DialogHeader.vue'

/**
 * «Generar SQL con IA»: describe what you need, the answer streams in and its
 * SQL is inserted at the editor's cursor. It is never executed: the user runs
 * it with the normal guards.
 */
const props = defineProps<{ editorSql: string }>()
const emit = defineEmits<{ insert: [sql: string] }>()
const open = defineModel<boolean>({ default: false })

const ai = useAiStore()
const notify = useNotify()
const prompt = ref('')
const preview = ref('')
const status = ref('')
const running = ref<string | null>(null)
const error = ref('')

const sql = computed(() => extractSql(preview.value))

watch(open, (value) => {
  if (value) {
    preview.value = ''
    error.value = ''
    status.value = ''
  } else if (running.value) void ai.cancel(running.value)
})

async function generate(): Promise<void> {
  const text = prompt.value.trim()
  if (!text || running.value) return
  preview.value = ''
  error.value = ''
  try {
    const started = await ai.generate(
      text,
      { editorSql: props.editorSql },
      (full) => {
        status.value = ''
        preview.value = full
      },
      (s) => {
        status.value = s
      }
    )
    if (!started) return
    running.value = started.id
    status.value = 'Enviando…'
    const { text: answer, event } = await started.done
    running.value = null
    status.value = ''
    if (event.stopReason === 'end_turn') {
      const generated = extractSql(answer)
      if (!generated) {
        error.value = 'El modelo no ha devuelto SQL. Reformula la petición.'
        return
      }
      emit('insert', generated)
      open.value = false
      prompt.value = ''
    } else if (event.stopReason === 'max_tokens') {
      error.value =
        'La respuesta se cortó al llegar al máximo de tokens (Ajustes › IA). No se ha insertado nada.'
    } else if (event.stopReason === 'cancelled') {
      error.value = 'Generación detenida.'
    } else {
      error.value = event.error ?? 'No se pudo generar el SQL.'
    }
  } catch (err) {
    running.value = null
    status.value = ''
    error.value = errorMessage(err)
    notify.error(error.value)
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void generate()
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="640" scrollable>
    <v-card data-test="ai-generate-dialog">
      <DialogHeader
        icon="mdi-creation-outline"
        title="Generar SQL con IA"
        subtitle="El SQL se inserta en el editor; no se ejecuta"
      />
      <v-card-text class="ai-gen">
        <v-textarea
          v-model="prompt"
          label="¿Qué necesitas?"
          placeholder="Ej.: pedidos pendientes de los últimos 7 días con el nombre del cliente"
          rows="3"
          auto-grow
          max-rows="8"
          variant="outlined"
          hide-details
          autofocus
          :disabled="!!running"
          class="nd-ui-font"
          data-test="ai-generate-input"
          @keydown="onKeydown"
        />
        <div v-if="running || preview" class="ai-gen__preview" data-test="ai-generate-preview">
          <div class="ai-gen__status">
            <span v-if="running" class="ai-gen__pulse" aria-hidden="true" />
            {{ running ? status || 'Generando…' : 'Vista previa' }}
          </div>
          <pre class="ai-gen__sql">{{ sql || preview }}</pre>
        </div>
        <v-alert v-if="error" type="warning" density="compact" variant="tonal">{{ error }}</v-alert>
        <div class="ai-gen__privacy">
          <v-icon icon="mdi-shield-lock-outline" size="14" aria-hidden="true" />{{
            AI_PRIVACY_LINE
          }}
        </div>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn v-if="running" color="error" prepend-icon="mdi-stop" @click="ai.cancel(running)"
          >Detener</v-btn
        >
        <v-btn v-else @click="open = false">Cancelar</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-creation-outline"
          :disabled="!prompt.trim() || !!running"
          data-test="ai-generate-run"
          @click="generate"
          >Generar e insertar</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.ai-gen {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ai-gen__preview {
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-control);
  background: var(--nd-bg-input);
  overflow: hidden;
}
.ai-gen__status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--nd-hairline);
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
  background: var(--nd-bg-raised);
}
.ai-gen__pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--nd-accent);
  animation: ai-gen-pulse 1s ease-in-out infinite;
}
@keyframes ai-gen-pulse {
  50% {
    opacity: 0.25;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ai-gen__pulse {
    animation: none;
  }
}
.ai-gen__sql {
  margin: 0;
  max-height: 260px;
  overflow: auto;
  padding: 8px 10px;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
  white-space: pre-wrap;
}
.ai-gen__privacy {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
</style>
