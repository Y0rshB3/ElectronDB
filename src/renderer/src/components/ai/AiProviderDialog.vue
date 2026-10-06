<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  AI_PROVIDER_PRESETS,
  AI_PROVIDER_TYPES,
  type AiProviderInput,
  type AiProviderType,
  type AiProviderView,
  type AiTestResult
} from '@shared/ai'
import { api } from '@renderer/api'
import { errorMessage } from '@renderer/composables/useNotify'
import DialogHeader from '@renderer/components/dialogs/DialogHeader.vue'

/**
 * Add / edit an AI provider. The key goes to main (CredentialStore) and is
 * never read back: an existing key only shows as «guardada».
 */
const props = defineProps<{ editing: AiProviderView | null }>()
const emit = defineEmits<{ saved: [provider: AiProviderView] }>()
const open = defineModel<boolean>({ default: false })

const type = ref<AiProviderType>('anthropic')
const name = ref('')
const baseUrl = ref('')
const model = ref('')
const key = ref('')
const removeKey = ref(false)
const models = ref<string[]>([])
const loadingModels = ref(false)
const testing = ref(false)
const saving = ref(false)
const result = ref<AiTestResult | null>(null)
const error = ref('')

const preset = computed(() => AI_PROVIDER_PRESETS[type.value])
const typeItems = AI_PROVIDER_TYPES.map((t) => ({ value: t, title: AI_PROVIDER_PRESETS[t].label }))
const modelItems = computed(() => [...new Set([...preset.value.models, ...models.value])])
const hasStoredKey = computed(() => !!props.editing?.hasKey && props.editing.type === type.value)
const keyHint = computed(() => {
  if (!preset.value.keyRequired)
    return type.value === 'ollama' ? 'Ollama no necesita clave' : 'Opcional, según el servidor'
  return hasStoredKey.value
    ? 'Hay una clave guardada: déjalo vacío para mantenerla'
    : 'Se guarda cifrada en tu equipo y nunca se muestra'
})

watch(open, (value) => {
  if (!value) return
  const e = props.editing
  type.value = e?.type ?? 'anthropic'
  name.value = e?.name ?? ''
  baseUrl.value = e?.baseUrl ?? AI_PROVIDER_PRESETS[type.value].baseUrl
  model.value = e?.model ?? AI_PROVIDER_PRESETS[type.value].defaultModel
  key.value = ''
  removeKey.value = false
  models.value = []
  result.value = null
  error.value = ''
})

function changeType(next: AiProviderType): void {
  const before = AI_PROVIDER_PRESETS[type.value]
  type.value = next
  const p = AI_PROVIDER_PRESETS[next]
  baseUrl.value = p.baseUrl
  model.value = p.defaultModel
  models.value = []
  result.value = null
  if (!name.value || name.value === before.label) name.value = ''
}

function input(): AiProviderInput {
  return {
    id: props.editing?.id,
    name: name.value.trim() || preset.value.label,
    type: type.value,
    baseUrl: preset.value.editableBaseUrl ? baseUrl.value.trim() : preset.value.baseUrl,
    model: model.value.trim()
  }
}

async function test(): Promise<void> {
  testing.value = true
  result.value = null
  try {
    result.value = await api.ai.testProvider(input(), key.value || null)
  } catch (err) {
    result.value = { ok: false, message: errorMessage(err) }
  } finally {
    testing.value = false
  }
}

async function loadModels(): Promise<void> {
  loadingModels.value = true
  error.value = ''
  try {
    models.value = await api.ai.listModels(
      { ...input(), model: model.value || 'x' },
      key.value || null
    )
    if (!models.value.length) error.value = 'El proveedor no ha devuelto ningún modelo.'
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    loadingModels.value = false
  }
}

async function save(): Promise<void> {
  saving.value = true
  error.value = ''
  try {
    const saved = await api.ai.saveProvider(input())
    if (key.value.trim()) await api.ai.setKey(saved.id, key.value.trim())
    else if (removeKey.value) await api.ai.setKey(saved.id, null)
    const hasKey = await api.ai.hasKey(saved.id)
    emit('saved', { ...saved, hasKey })
    open.value = false
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="560" scrollable>
    <v-card data-test="ai-provider-dialog">
      <DialogHeader
        icon="mdi-creation-outline"
        :title="editing ? 'Editar proveedor de IA' : 'Nuevo proveedor de IA'"
        subtitle="Usa tu propia clave: el coste lo factura el proveedor"
      />
      <v-card-text class="ai-provider">
        <v-select
          :model-value="type"
          :items="typeItems"
          label="Proveedor"
          density="compact"
          data-test="ai-provider-type"
          @update:model-value="changeType"
        />
        <v-text-field
          v-model="name"
          :placeholder="preset.label"
          label="Nombre"
          density="compact"
          data-test="ai-provider-name"
        />
        <v-text-field
          v-if="type !== 'anthropic'"
          v-model="baseUrl"
          label="URL base"
          density="compact"
          class="nd-mono-input"
          :readonly="!preset.editableBaseUrl"
          :hint="
            preset.editableBaseUrl
              ? 'https:// obligatorio (http solo para localhost / 127.0.0.1)'
              : 'Fija para este proveedor'
          "
          persistent-hint
          :placeholder="type === 'custom' ? 'https://mi-servidor/v1' : ''"
          data-test="ai-provider-url"
        />
        <div class="ai-provider__model">
          <v-combobox
            v-model="model"
            :items="modelItems"
            label="Modelo"
            :placeholder="preset.modelHint"
            density="compact"
            class="nd-mono-input"
            hide-details="auto"
            data-test="ai-provider-model"
          />
          <v-btn
            v-if="type !== 'anthropic'"
            size="small"
            variant="tonal"
            :loading="loadingModels"
            data-test="ai-provider-load-models"
            @click="loadModels"
            >Cargar modelos</v-btn
          >
        </div>
        <v-text-field
          v-model="key"
          type="password"
          autocomplete="off"
          :label="preset.keyRequired ? 'Clave API' : 'Clave API (opcional)'"
          :placeholder="hasStoredKey ? '•••••••• (guardada)' : ''"
          :hint="keyHint"
          persistent-hint
          density="compact"
          data-test="ai-provider-key"
        />
        <v-checkbox
          v-if="hasStoredKey && !key"
          v-model="removeKey"
          label="Quitar la clave guardada"
          density="compact"
          hide-details
        />
        <v-alert
          v-if="result"
          :type="result.ok ? 'success' : 'error'"
          density="compact"
          variant="tonal"
          data-test="ai-provider-test-result"
          >{{ result.message }}</v-alert
        >
        <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-btn
          prepend-icon="mdi-connection"
          :loading="testing"
          :disabled="!model.trim()"
          data-test="ai-provider-test"
          @click="test"
          >Probar</v-btn
        >
        <v-spacer />
        <v-btn @click="open = false">Cancelar</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :loading="saving"
          :disabled="!model.trim()"
          data-test="ai-provider-save"
          @click="save"
          >Guardar</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.ai-provider {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ai-provider__model {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.ai-provider__model > :first-child {
  flex: 1;
}
.ai-provider__model .v-btn {
  margin-top: 4px;
}
.nd-mono-input :deep(input) {
  font-family: var(--nd-font-mono);
}
</style>
