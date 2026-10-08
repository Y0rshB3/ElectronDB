<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { AI_PRIVACY_LINE, type AiUsage } from '@shared/ai'
import { api } from '@renderer/api'
import { useNotify, errorMessage } from '@renderer/composables/useNotify'
import { useAiStore } from '@renderer/stores/ai'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useUiStore } from '@renderer/stores/ui'
import { descriptorOf } from '@renderer/engines/capabilities'
import { environmentLabel, environmentPillClass } from '@renderer/components/backups/backupHelpers'
import EmptyState from '@renderer/components/common/EmptyState.vue'
import { formatNumber } from '@renderer/utils/format'
import ChatMarkdown from './ChatMarkdown.vue'
import AiContextDialog from './AiContextDialog.vue'

/**
 * «IA» side panel: provider picker, conversations, streamed chat with
 * markdown answers, «Memoria» notes and «Ver contexto enviado». Generated SQL
 * is only inserted into the editor, never executed.
 */
const ai = useAiStore()
const ui = useUiStore()
const connections = useConnectionsStore()
const notify = useNotify()

const tab = ref<'chat' | 'memory'>('chat')
const input = ref('')
const scroller = ref<HTMLElement | null>(null)
const contextOpen = ref(false)
const renameTarget = ref<{ id: string; title: string } | null>(null)

const connection = computed(() => (ai.target ? connections.get(ai.target.connectionId) : undefined))
const ready = computed(() => ai.enabled && ai.providers.length > 0)
const providerItems = computed(() =>
  ai.providers.map((p) => ({ value: p.id, title: p.name, subtitle: p.model }))
)
const selectedProvider = computed({
  get: () => ai.activeProvider?.id ?? null,
  set: (id: string | null) => {
    ai.providerId = id
  }
})
const contextRequest = computed(() =>
  ai.target
    ? {
        connectionId: ai.target.connectionId,
        schema: ai.target.schema,
        ...(ai.target.database ? { database: ai.target.database } : {}),
        scope: ai.effectiveScope,
        input: input.value,
        openTable: ai.openTable
      }
    : null
)

/**
 * Words of the scope menu for the connection's engine: «Toda la conexión» is
 * every database of the server, every schema of the current PostgreSQL
 * database, or SQLite main plus its attachments.
 */
const scopeWords = computed(() => {
  const unit = descriptorOf(connection.value)?.capabilities.ai.scope ?? 'databases'
  const schema = ai.target?.schema ?? ''
  if (unit === 'schemas') {
    const db = ai.target?.database || connection.value?.postgres?.initialDatabase || 'postgres'
    return {
      single: `Solo el esquema ${schema}`,
      singleHint: 'Los demás esquemas se nombran y el asistente puede pedir su estructura',
      wholeHint: `En PostgreSQL: todos los esquemas de la base de datos ${db} (las demás bases de datos de la conexión no se incluyen)`,
      wholeLabel: 'todos los esquemas',
      wholeTitle: `El asistente ve todos los esquemas de la base de datos ${db}`
    }
  }
  if (unit === 'attached')
    return {
      single: `Solo ${schema}`,
      singleHint: 'Las demás bases de datos del archivo se nombran',
      wholeHint: 'main y todas sus bases de datos adjuntas',
      wholeLabel: 'toda la conexión',
      wholeTitle: 'El asistente ve main y todas las bases de datos adjuntas'
    }
  const mongo = connection.value?.engine === 'mongodb'
  return {
    single: `Solo ${schema}`,
    singleHint: 'Las demás bases de datos se nombran y el asistente puede pedir su estructura',
    wholeHint: mongo
      ? 'Estructura muestreada de todas las bases de datos (sin valores), para relaciones entre ellas'
      : 'Estructura de todas las bases de datos, para relaciones entre ellas',
    wholeLabel: 'toda la conexión',
    wholeTitle: 'El asistente ve todas las bases de datos de la conexión'
  }
})

const SUGGESTIONS = [
  '¿Qué tablas hay y cómo se relacionan?',
  'Escribe una consulta con los 10 últimos registros de la tabla principal',
  '¿Qué índices faltan para las consultas más habituales?'
]

function usageText(u: AiUsage | null | undefined): string {
  if (!u) return ''
  const model = ai.lastModel ? `${ai.lastModel} · ` : ''
  const parts = [`${formatNumber(u.inputTokens)} entrada`, `${formatNumber(u.outputTokens)} salida`]
  if (u.cacheReadTokens) parts.push(`${formatNumber(u.cacheReadTokens)} de caché`)
  return `${model}Tokens: ${parts.join(' · ')}`
}

async function send(): Promise<void> {
  const text = input.value.trim()
  if (!text || ai.busy) return
  input.value = ''
  await ai.send('chat', text, {})
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void send()
  }
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    notify.success('Copiado al portapapeles')
  } catch (err) {
    notify.error(`No se pudo copiar: ${errorMessage(err)}`)
  }
}

function scrollToEnd(): void {
  void nextTick(() => {
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

watch(
  () => ai.messages.map((m) => m.text.length).join(','),
  () => scrollToEnd()
)

async function confirmRename(): Promise<void> {
  const r = renameTarget.value
  renameTarget.value = null
  if (r) await ai.renameConversation(r.id, r.title)
}

/* ---------- Memoria ---------- */

const memoryConnection = ref('')
const memoryDatabase = ref('')
const memoryLoaded = ref<string | null>(null)
const savingMemory = ref(false)

async function loadMemory(): Promise<void> {
  const t = ai.target
  if (!t) return
  const key = `${t.connectionId}\u0000${t.schema ?? ''}`
  try {
    const [c, d] = await Promise.all([
      api.ai.memory(t.connectionId, null),
      t.schema ? api.ai.memory(t.connectionId, t.schema) : Promise.resolve('')
    ])
    memoryConnection.value = c
    memoryDatabase.value = d
    memoryLoaded.value = key
  } catch {
    memoryLoaded.value = null
  }
}

async function saveMemory(): Promise<void> {
  const t = ai.target
  if (!t) return
  savingMemory.value = true
  try {
    await api.ai.setMemory(t.connectionId, null, memoryConnection.value)
    if (t.schema) await api.ai.setMemory(t.connectionId, t.schema, memoryDatabase.value)
    notify.success('Memoria guardada')
  } finally {
    savingMemory.value = false
  }
}

watch(
  () => [tab.value, ai.target?.connectionId, ai.target?.schema],
  () => {
    if (tab.value === 'memory') void loadMemory()
  }
)

onMounted(() => {
  if (!ai.providersLoaded) void ai.loadProviders()
  void ai.loadConversations(ai.target?.connectionId ?? null)
  scrollToEnd()
})
</script>

<template>
  <aside class="ai-panel" aria-label="Asistente de IA" data-test="ai-panel">
    <div class="ai-panel__header">
      <v-icon icon="mdi-creation-outline" size="18" class="ai-panel__logo" aria-hidden="true" />
      <span class="ai-panel__heading">Asistente IA</span>
      <v-spacer />
      <v-btn
        icon="mdi-dock-right"
        size="x-small"
        variant="text"
        aria-label="Ocultar el asistente"
        title="Ocultar panel"
        @click="ui.toggleAiPanel(false)"
      />
    </div>

    <EmptyState
      v-if="!ai.enabled || (ai.providersLoaded && !ai.providers.length)"
      size="compact"
      icon="mdi-creation-outline"
      :title="ai.enabled ? 'Ningún proveedor configurado' : 'Asistente desactivado'"
      :description="
        ai.enabled
          ? 'Añade un proveedor (Claude, OpenAI, Groq, Grok, GLM, Ollama…) con tu propia clave.'
          : 'Actívalo en Ajustes › IA y configura un proveedor con tu propia clave.'
      "
      data-test="ai-disabled"
    >
      <v-btn size="small" color="primary" variant="tonal" @click="ui.openSettingsDialog()"
        >Abrir Ajustes</v-btn
      >
    </EmptyState>

    <template v-else>
      <div class="ai-panel__target" data-test="ai-target">
        <template v-if="connection">
          <span class="nd-pill" :class="environmentPillClass(connection.environment)">{{
            environmentLabel(connection.environment)
          }}</span>
          <span class="ai-panel__conn nd-ellipsis" :title="connection.name">{{
            connection.name
          }}</span>
          <v-menu v-if="ai.target?.schema" location="bottom start">
            <template #activator="{ props: sp }">
              <button
                v-bind="sp"
                type="button"
                class="ai-panel__scope"
                :title="
                  ai.scope === 'connection'
                    ? scopeWords.wholeTitle
                    : `El asistente ve solo ${ai.target.schema}`
                "
                aria-label="Qué ve el asistente"
                data-test="ai-scope"
              >
                <v-icon
                  :icon="
                    ai.scope === 'connection'
                      ? 'mdi-database-search-outline'
                      : 'mdi-database-outline'
                  "
                  size="13"
                />
                <span class="nd-ellipsis">{{
                  ai.scope === 'connection' ? scopeWords.wholeLabel : ai.target.schema
                }}</span>
                <v-icon icon="mdi-chevron-down" size="13" />
              </button>
            </template>
            <v-list density="compact" max-width="340" aria-label="Qué ve el asistente">
              <v-list-item
                :active="ai.scope === 'database'"
                prepend-icon="mdi-database-outline"
                :title="scopeWords.single"
                :subtitle="scopeWords.singleHint"
                lines="two"
                data-test="ai-scope-database"
                @click="ai.scope = 'database'"
              />
              <v-list-item
                :active="ai.scope === 'connection'"
                prepend-icon="mdi-database-search-outline"
                title="Toda la conexión"
                :subtitle="scopeWords.wholeHint"
                lines="three"
                data-test="ai-scope-connection"
                @click="ai.scope = 'connection'"
              />
            </v-list>
          </v-menu>
          <span
            v-else
            class="ai-panel__schema ai-panel__schema--none"
            :title="scopeWords.wholeTitle"
            data-test="ai-scope-whole"
            >{{ scopeWords.wholeLabel }}</span
          >
        </template>
        <span v-else class="ai-panel__schema--none">Abre una conexión o una consulta</span>
      </div>

      <div class="ai-panel__toolbar">
        <v-select
          v-model="selectedProvider"
          :items="providerItems"
          item-title="title"
          item-value="value"
          density="compact"
          hide-details
          variant="outlined"
          class="ai-panel__provider"
          aria-label="Proveedor de IA"
          data-test="ai-provider"
          :disabled="ai.busy"
        >
          <template #selection="{ item }">
            <span class="nd-ellipsis"
              >{{ item.raw.title }}
              <span class="ai-panel__model">{{ item.raw.subtitle }}</span></span
            >
          </template>
          <template #item="{ props: itemProps, item }">
            <v-list-item v-bind="itemProps" :subtitle="item.raw.subtitle" />
          </template>
        </v-select>
        <v-menu location="bottom end">
          <template #activator="{ props: mp }">
            <v-btn
              v-bind="mp"
              icon="mdi-history"
              size="small"
              variant="text"
              aria-label="Conversaciones"
              title="Conversaciones"
              data-test="ai-conversations"
            />
          </template>
          <v-list density="compact" min-width="280" max-height="360" aria-label="Conversaciones">
            <v-list-item
              v-if="!ai.conversations.length"
              title="Sin conversaciones guardadas"
              disabled
            />
            <v-list-item
              v-for="c in ai.conversations"
              :key="c.id"
              :title="c.title"
              :subtitle="`${c.messageCount} mensajes${c.schema ? ` · ${c.schema}` : ''}`"
              :active="c.id === ai.conversationId"
              :disabled="ai.busy"
              @click="ai.openConversation(c.id)"
            >
              <template #append>
                <v-btn
                  icon="mdi-pencil-outline"
                  size="x-small"
                  variant="text"
                  :aria-label="`Renombrar ${c.title}`"
                  @click.stop="renameTarget = { id: c.id, title: c.title }"
                />
                <v-btn
                  icon="mdi-delete-outline"
                  size="x-small"
                  variant="text"
                  :aria-label="`Eliminar ${c.title}`"
                  @click.stop="ai.deleteConversation(c.id)"
                />
              </template>
            </v-list-item>
          </v-list>
        </v-menu>
        <v-btn
          icon="mdi-plus"
          size="small"
          variant="text"
          aria-label="Nueva conversación"
          title="Nueva conversación"
          :disabled="ai.busy"
          data-test="ai-new"
          @click="ai.newConversation()"
        />
        <v-btn
          icon="mdi-text-box-search-outline"
          size="small"
          variant="text"
          aria-label="Ver contexto enviado"
          title="Ver contexto enviado"
          :disabled="!ai.target"
          data-test="ai-context"
          @click="contextOpen = true"
        />
      </div>

      <v-tabs v-model="tab" density="compact" class="ai-panel__tabs" hide-slider>
        <v-tab value="chat" size="small" data-test="ai-tab-chat">Chat</v-tab>
        <v-tab value="memory" size="small" data-test="ai-tab-memory">Memoria</v-tab>
      </v-tabs>

      <template v-if="tab === 'chat'">
        <div ref="scroller" class="ai-panel__messages" role="log" aria-live="polite">
          <div v-if="!ai.messages.length" class="ai-panel__welcome">
            <p>Pregunta sobre la estructura de tu base de datos o pide una consulta SQL.</p>
            <button
              v-for="s in SUGGESTIONS"
              :key="s"
              type="button"
              class="ai-panel__suggestion"
              :disabled="!ai.target"
              @click="ai.send('chat', s)"
            >
              {{ s }}
            </button>
          </div>
          <div
            v-for="(m, i) in ai.messages"
            :key="i"
            class="ai-msg"
            :class="[`ai-msg--${m.role}`, m.stopReason ? `ai-msg--${m.stopReason}` : '']"
            :data-test="`ai-msg-${m.role}`"
          >
            <ChatMarkdown
              v-if="m.role === 'assistant'"
              :source="m.text"
              :streaming="ai.busy && i === ai.messages.length - 1"
              @insert="ai.insertSql"
              @copy="copy"
            />
            <div v-else class="ai-msg__user">{{ m.text }}</div>
            <div
              v-if="m.role === 'assistant' && ai.busy && i === ai.messages.length - 1"
              class="ai-msg__status"
              data-test="ai-status"
            >
              <span class="ai-msg__pulse" aria-hidden="true" />{{ ai.status || 'Escribiendo…' }}
            </div>
          </div>
        </div>

        <div class="ai-panel__composer">
          <v-textarea
            v-model="input"
            rows="2"
            max-rows="8"
            auto-grow
            hide-details
            variant="outlined"
            density="compact"
            placeholder="Pregunta sobre tu base de datos… (Enter envía, Mayús+Enter nueva línea)"
            aria-label="Pregunta para el asistente"
            class="nd-ui-font"
            data-test="ai-input"
            :disabled="!ai.target"
            @keydown="onKeydown"
          />
          <div class="ai-panel__actions">
            <span class="ai-panel__usage" :title="usageText(ai.lastUsage)" data-test="ai-usage">{{
              usageText(ai.lastUsage)
            }}</span>
            <v-spacer />
            <v-btn
              v-if="ai.busy"
              size="small"
              color="error"
              variant="tonal"
              prepend-icon="mdi-stop"
              data-test="ai-stop"
              @click="ai.cancel()"
              >Detener</v-btn
            >
            <v-btn
              v-else
              size="small"
              color="primary"
              variant="flat"
              prepend-icon="mdi-send"
              :disabled="!input.trim() || !ai.target || !ready"
              data-test="ai-send"
              @click="send"
              >Enviar</v-btn
            >
          </div>
        </div>
      </template>

      <div v-else class="ai-panel__memory" data-test="ai-memory">
        <p class="ai-panel__hint">
          Notas que el asistente recibe con la estructura: reglas de negocio, significado de los
          estados, convenciones… No escribas aquí datos sensibles.
        </p>
        <v-textarea
          v-model="memoryConnection"
          label="Memoria de esta conexión"
          rows="4"
          auto-grow
          max-rows="10"
          variant="outlined"
          density="compact"
          hide-details
          :disabled="!ai.target"
          class="nd-ui-font"
          data-test="ai-memory-connection"
        />
        <v-textarea
          v-if="ai.target?.schema"
          v-model="memoryDatabase"
          :label="`Memoria de la base de datos ${ai.target.schema}`"
          rows="4"
          auto-grow
          max-rows="10"
          variant="outlined"
          density="compact"
          hide-details
          class="nd-ui-font"
          data-test="ai-memory-database"
        />
        <div class="ai-panel__actions">
          <v-spacer />
          <v-btn
            size="small"
            color="primary"
            variant="flat"
            :loading="savingMemory"
            :disabled="!ai.target || memoryLoaded === null"
            data-test="ai-memory-save"
            @click="saveMemory"
            >Guardar memoria</v-btn
          >
        </div>
      </div>

      <div class="ai-panel__privacy" data-test="ai-privacy">
        <v-icon icon="mdi-shield-lock-outline" size="14" aria-hidden="true" />
        <span>{{ AI_PRIVACY_LINE }}</span>
        <v-tooltip activator="parent" location="top" max-width="320">
          Se envían nombres de tablas y columnas, tipos, claves, índices y estimaciones de filas,
          además de tus preguntas, tus notas de «Memoria» y, al explicar una consulta o un error, el
          SQL del editor (es tu texto, no datos de tus tablas). El coste lo factura el proveedor a
          tu clave.
        </v-tooltip>
      </div>
    </template>

    <AiContextDialog v-model="contextOpen" :request="contextRequest" />

    <v-dialog
      :model-value="!!renameTarget"
      max-width="420"
      @update:model-value="renameTarget = null"
    >
      <v-card v-if="renameTarget">
        <v-card-title>Renombrar conversación</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="renameTarget.title"
            label="Título"
            autofocus
            @keydown.enter="confirmRename"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="renameTarget = null">Cancelar</v-btn>
          <v-btn color="primary" variant="flat" @click="confirmRename">Guardar</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </aside>
</template>

<style scoped>
.ai-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
}
.ai-panel__header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 42px;
  flex: none;
  padding: 0 6px 0 14px;
  border-bottom: 1px solid var(--nd-hairline);
}
.ai-panel__logo {
  color: var(--nd-accent);
}
.ai-panel__heading {
  font-size: var(--nd-fs-small);
  font-weight: 600;
  color: var(--nd-text);
}
.ai-panel__target {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 8px 12px 2px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.ai-panel__conn {
  min-width: 0;
  color: var(--nd-text);
  font-weight: 500;
}
.ai-panel__schema {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
}
.ai-panel__scope {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  padding: 1px 6px;
  border-radius: 6px;
  color: var(--nd-text-muted);
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  cursor: pointer;
}
.ai-panel__scope:hover,
.ai-panel__scope:focus-visible {
  background: var(--nd-hover);
  color: var(--nd-text);
}
.ai-panel__schema--none {
  color: var(--nd-text-muted);
  font-size: var(--nd-fs-xs);
}
.ai-panel__toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 8px 4px 12px;
}
.ai-panel__provider {
  flex: 1;
  min-width: 0;
}
.ai-panel__model {
  margin-left: 4px;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.ai-panel__tabs {
  flex: none;
  padding: 0 8px;
  border-bottom: 1px solid var(--nd-hairline);
}
.ai-panel__messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ai-panel__welcome {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--nd-text-2);
  font-size: var(--nd-fs-small);
}
.ai-panel__welcome p {
  margin: 0 0 4px;
}
.ai-panel__suggestion {
  text-align: left;
  padding: 7px 10px;
  border-radius: var(--nd-radius-control);
  border: 1px solid var(--nd-border);
  background: var(--nd-bg-raised);
  color: var(--nd-text);
  font-size: var(--nd-fs-dense);
  cursor: pointer;
}
.ai-panel__suggestion:hover:not(:disabled) {
  border-color: var(--nd-border-strong);
}
.ai-panel__suggestion:disabled {
  opacity: 0.5;
  cursor: default;
}
.ai-msg {
  max-width: 100%;
}
.ai-msg--user {
  align-self: flex-end;
  max-width: 88%;
}
.ai-msg__user {
  padding: 7px 11px;
  border-radius: 12px 12px 4px 12px;
  background: var(--nd-accent-gradient-soft);
  border: 1px solid rgba(var(--nd-accent-rgb), 0.18);
  font-size: var(--nd-fs-small);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--nd-text);
}
.ai-msg--assistant {
  padding: 2px 2px 0;
}
.ai-msg--refusal :deep(.chat-md),
.ai-msg--error :deep(.chat-md) {
  color: var(--nd-error);
}
.ai-msg__status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.ai-msg__pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--nd-accent);
  animation: ai-pulse 1s ease-in-out infinite;
}
@keyframes ai-pulse {
  50% {
    opacity: 0.25;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ai-msg__pulse {
    animation: none;
  }
}
.ai-panel__composer {
  flex: none;
  padding: 8px 10px 6px;
  border-top: 1px solid var(--nd-hairline);
}
.ai-panel__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.ai-panel__usage {
  min-width: 0;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  line-height: 1.35;
  color: var(--nd-text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ai-panel__memory {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
}
.ai-panel__hint {
  margin: 0;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-muted);
}
.ai-panel__privacy {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 6px 12px 8px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
  cursor: help;
}
</style>
