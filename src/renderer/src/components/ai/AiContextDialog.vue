<script setup lang="ts">
import { ref, watch } from 'vue'
import { AI_PRIVACY_LINE, type AiContextPreview, type AiContextRequest } from '@shared/ai'
import { api } from '@renderer/api'
import { errorMessage } from '@renderer/composables/useNotify'
import { formatNumber } from '@renderer/utils/format'
import DialogHeader from '@renderer/components/dialogs/DialogHeader.vue'

/** «Ver contexto enviado»: the exact instructions + context a question would send. */
const props = defineProps<{ request: AiContextRequest | null }>()
const open = defineModel<boolean>({ default: false })

const preview = ref<AiContextPreview | null>(null)
const loading = ref(false)
const error = ref('')

async function load(): Promise<void> {
  if (!props.request) return
  loading.value = true
  error.value = ''
  try {
    preview.value = await api.ai.contextPreview(props.request)
  } catch (err) {
    preview.value = null
    error.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}

watch(open, (value) => {
  if (value) void load()
})
</script>

<template>
  <v-dialog v-model="open" max-width="860" scrollable>
    <v-card data-test="ai-context-dialog">
      <DialogHeader
        icon="mdi-text-box-search-outline"
        title="Contexto enviado al modelo"
        :subtitle="AI_PRIVACY_LINE"
      />
      <v-card-text class="ai-context">
        <v-progress-linear v-if="loading" indeterminate height="2" />
        <v-alert v-if="error" type="error" density="compact">{{ error }}</v-alert>
        <template v-if="preview">
          <div class="ai-context__meta" data-test="ai-context-meta">
            <span>{{ formatNumber(preview.chars) }} caracteres</span>
            <span v-if="preview.tableCount">· {{ preview.tableCount }} tablas y vistas</span>
            <span v-if="preview.truncated" class="ai-context__warn"
              >· El esquema no cabe entero: algunas tablas van solo con el nombre y el modelo puede
              pedir su estructura.</span
            >
          </div>
          <div class="ai-context__label">Instrucciones (fijas)</div>
          <pre class="ai-context__pre ai-context__pre--short">{{ preview.instructions }}</pre>
          <div class="ai-context__label">Estructura y memoria</div>
          <pre class="ai-context__pre" data-test="ai-context-text">{{ preview.context }}</pre>
          <p class="ai-context__note">
            Además se envían tu pregunta, el historial de la conversación y, al explicar una
            consulta o un error, el SQL del editor y el mensaje de error. Nunca se envían filas,
            resultados ni los datos de conexión (servidor, usuario o contraseña).
          </p>
        </template>
      </v-card-text>
      <v-card-actions>
        <v-btn prepend-icon="mdi-refresh" :loading="loading" @click="load">Actualizar</v-btn>
        <v-spacer />
        <v-btn @click="open = false">Cerrar</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.ai-context {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ai-context__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.ai-context__warn {
  color: var(--nd-warning);
}
.ai-context__label {
  margin-top: 4px;
  font-size: var(--nd-fs-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--nd-text-muted);
}
.ai-context__pre {
  margin: 0;
  max-height: 46vh;
  overflow: auto;
  padding: 10px 12px;
  border-radius: var(--nd-radius-control);
  border: 1px solid var(--nd-border);
  background: var(--nd-bg-input);
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.ai-context__pre--short {
  max-height: 22vh;
}
.ai-context__note {
  margin: 4px 0 0;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-muted);
}
</style>
