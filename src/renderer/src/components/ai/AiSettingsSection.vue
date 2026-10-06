<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  AI_PRIVACY_LINE,
  AI_PROVIDER_PRESETS,
  type AiEffort,
  type AiProviderView
} from '@shared/ai'
import { api } from '@renderer/api'
import { useConfirm } from '@renderer/composables/useConfirm'
import { useAiStore } from '@renderer/stores/ai'
import AiProviderDialog from './AiProviderDialog.vue'

/**
 * Ajustes › IA. Providers are saved immediately (their own dialog); the master
 * switch, default provider, effort and max tokens are saved with the rest of
 * Ajustes («Guardar»).
 */
const enabled = defineModel<boolean>('enabled', { required: true })
const defaultProviderId = defineModel<string | null>('defaultProviderId', { required: true })
const effort = defineModel<AiEffort>('effort', { required: true })
const maxTokens = defineModel<number>('maxTokens', { required: true })

const ai = useAiStore()
const { ask } = useConfirm()
const dialogOpen = ref(false)
const editing = ref<AiProviderView | null>(null)

const providers = computed(() => ai.providers)
const defaultItems = computed(() =>
  providers.value.map((p) => ({ value: p.id, title: `${p.name} · ${p.model}` }))
)
const EFFORTS: { value: AiEffort; title: string }[] = [
  { value: 'low', title: 'Bajo' },
  { value: 'medium', title: 'Medio' },
  { value: 'high', title: 'Alto' }
]

function add(): void {
  editing.value = null
  dialogOpen.value = true
}

function edit(p: AiProviderView): void {
  editing.value = p
  dialogOpen.value = true
}

async function remove(p: AiProviderView): Promise<void> {
  const ok = await ask({
    title: 'Eliminar proveedor',
    message: `Se eliminará «${p.name}» y su clave guardada.`,
    confirmText: 'Eliminar',
    danger: true
  })
  if (!ok) return
  await api.ai.deleteProvider(p.id)
  if (defaultProviderId.value === p.id) defaultProviderId.value = null
  await ai.loadProviders()
  if (!ai.providers.length) enabled.value = false
}

async function onSaved(p: AiProviderView): Promise<void> {
  await ai.loadProviders()
  if (!defaultProviderId.value) defaultProviderId.value = p.id
}

onMounted(() => void ai.loadProviders())
</script>

<template>
  <section class="settings-section" aria-label="IA" data-test="settings-ai">
    <div class="settings-section__title">
      <v-icon icon="mdi-creation-outline" size="15" aria-hidden="true" />IA
    </div>
    <v-switch
      v-model="enabled"
      color="primary"
      label="Activar asistente de IA"
      :hint="
        providers.length
          ? AI_PRIVACY_LINE
          : 'Añade primero un proveedor con tu propia clave (Claude, OpenAI, Groq, Grok, GLM, Ollama…)'
      "
      persistent-hint
      density="compact"
      :disabled="!providers.length"
      data-test="settings-ai-enabled"
    />

    <div class="ai-settings__providers">
      <div class="ai-settings__head">
        <span>Proveedores</span>
        <v-spacer />
        <v-btn
          size="small"
          variant="tonal"
          prepend-icon="mdi-plus"
          data-test="settings-ai-add"
          @click="add"
          >Añadir proveedor</v-btn
        >
      </div>
      <div v-if="!providers.length" class="ai-settings__empty">Ningún proveedor configurado.</div>
      <div
        v-for="p in providers"
        :key="p.id"
        class="ai-settings__provider"
        :data-test="`settings-ai-provider-${p.type}`"
      >
        <div class="ai-settings__provider-main">
          <div class="ai-settings__provider-name nd-ellipsis">
            {{ p.name }}
            <span v-if="p.id === defaultProviderId" class="ai-settings__default"
              >predeterminado</span
            >
          </div>
          <div class="ai-settings__provider-sub nd-ellipsis">
            {{ AI_PROVIDER_PRESETS[p.type].label }} · <span class="nd-mono">{{ p.model }}</span>
          </div>
        </div>
        <span
          class="ai-settings__key"
          :class="{
            'ai-settings__key--missing': !p.hasKey && AI_PROVIDER_PRESETS[p.type].keyRequired
          }"
        >
          <v-icon :icon="p.hasKey ? 'mdi-key-variant' : 'mdi-key-remove'" size="14" />
          {{
            p.hasKey
              ? 'Clave guardada'
              : AI_PROVIDER_PRESETS[p.type].keyRequired
                ? 'Sin clave'
                : 'Sin clave (no necesaria)'
          }}
        </span>
        <v-btn
          icon="mdi-pencil-outline"
          size="x-small"
          variant="text"
          :aria-label="`Editar ${p.name}`"
          @click="edit(p)"
        />
        <v-btn
          icon="mdi-delete-outline"
          size="x-small"
          variant="text"
          :aria-label="`Eliminar ${p.name}`"
          @click="remove(p)"
        />
      </div>
    </div>

    <div class="ai-settings__grid">
      <v-select
        v-model="defaultProviderId"
        :items="defaultItems"
        label="Proveedor predeterminado"
        density="compact"
        hide-details
        :disabled="!providers.length"
        data-test="settings-ai-default"
      />
      <v-select
        v-model="effort"
        :items="EFFORTS"
        label="Esfuerzo de razonamiento"
        density="compact"
        hint="Claude: más esfuerzo = respuestas más cuidadas, más lentas y más caras"
        persistent-hint
        data-test="settings-ai-effort"
      />
      <v-text-field
        v-model.number="maxTokens"
        type="number"
        min="256"
        max="128000"
        label="Máximo de tokens por respuesta"
        density="compact"
        hide-details
        data-test="settings-ai-max-tokens"
      />
    </div>
    <p class="ai-settings__note">
      Cada pregunta se factura a tu clave según las tarifas del proveedor. Las conversaciones y la
      memoria se guardan solo en este equipo.
    </p>

    <AiProviderDialog v-model="dialogOpen" :editing="editing" @saved="onSaved" />
  </section>
</template>

<style scoped>
.settings-section {
  padding: 12px 14px 14px;
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border);
}
.settings-section__title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: var(--nd-fs-small);
  font-weight: 600;
  color: var(--nd-text-2);
}
.settings-section__title .v-icon {
  color: var(--nd-text-muted);
}
.ai-settings__providers {
  margin: 12px 0;
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-control);
  background: var(--nd-bg-input);
}
.ai-settings__head {
  display: flex;
  align-items: center;
  padding: 6px 8px 6px 12px;
  border-bottom: 1px solid var(--nd-hairline);
  font-size: var(--nd-fs-dense);
  font-weight: 600;
  color: var(--nd-text-2);
}
.ai-settings__empty {
  padding: 10px 12px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-muted);
}
.ai-settings__provider {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 6px 6px 12px;
  border-bottom: 1px solid var(--nd-hairline);
}
.ai-settings__provider:last-child {
  border-bottom: 0;
}
.ai-settings__provider-main {
  flex: 1;
  min-width: 0;
}
.ai-settings__provider-name {
  font-size: var(--nd-fs-small);
  color: var(--nd-text);
}
.ai-settings__default {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 8px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-accent);
  background: var(--nd-accent-gradient-soft);
}
.ai-settings__provider-sub {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.ai-settings__key {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-success);
  white-space: nowrap;
}
.ai-settings__key--missing {
  color: var(--nd-warning);
}
.ai-settings__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-items: start;
  gap: 12px;
}
.ai-settings__grid > :first-child {
  grid-column: 1 / -1;
}
.ai-settings__note {
  margin: 10px 0 0;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-muted);
}
</style>
