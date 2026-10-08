import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type {
  AiChatRequest,
  AiConversationSummary,
  AiDeltaEvent,
  AiDoneEvent,
  AiMessage,
  AiMode,
  AiProviderView,
  AiScope,
  AiStatusEvent,
  AiStopReason,
  AiTarget,
  AiUsage
} from '@shared/ai'
import { api } from '@renderer/api'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { queryEditorFor } from '@renderer/composables/useQueryEditors'
import { useWorkspace } from '@renderer/composables/useWorkspace'
import { useConnectionsStore } from './connections'
import { useSettingsStore } from './settings'
import { useTabsStore } from './tabs'
import { useTreeStore } from './tree'
import { useUiStore } from './ui'

/** Callbacks of one running request (panel chat or «Generar SQL con IA»). */
interface RequestHandlers {
  onDelta(text: string): void
  onStatus(status: string): void
  onDone(event: AiDoneEvent): void
}

export interface ChatExtras {
  sql?: string | null
  error?: string | null
  editorSql?: string | null
  openTable?: string | null
}

type AiEvent =
  | { channel: 'delta'; payload: AiDeltaEvent }
  | { channel: 'status'; payload: AiStatusEvent }
  | { channel: 'done'; payload: AiDoneEvent }

const TITLE_CHARS = 60

/** First ```sql block of an answer, else the whole text when it looks like SQL. */
export function extractSql(text: string): string {
  const m = /```(?:sql|mysql)?[^\n]*\n([\s\S]*?)(?:```|$)/i.exec(text)
  if (m) return m[1].trim()
  return text.trim()
}

/** Text shown in the conversation for a request (the full prompt is built in main). */
export function displayText(mode: AiMode, input: string, extras: ChatExtras): string {
  const fence = (sql: string): string => '```sql\n' + sql.trim() + '\n```'
  switch (mode) {
    case 'explain':
      return [`Explica y optimiza esta consulta:`, fence(extras.sql ?? ''), input.trim()]
        .filter(Boolean)
        .join('\n\n')
    case 'explainError':
      return [
        '¿Por qué falla esta sentencia?',
        fence(extras.sql ?? ''),
        extras.error ? `Error: ${extras.error}` : ''
      ]
        .filter(Boolean)
        .join('\n\n')
    default:
      return input.trim()
  }
}

function titleFrom(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS - 1)}…` : flat) || 'Conversación'
}

const SCOPE_KEY = 'electrondb.ai.scope'

function readScope(): AiScope {
  try {
    return localStorage.getItem(SCOPE_KEY) === 'connection' ? 'connection' : 'database'
  } catch {
    return 'database'
  }
}

export const useAiStore = defineStore('ai', () => {
  const settings = useSettingsStore()
  const tabs = useTabsStore()
  const tree = useTreeStore()
  const connections = useConnectionsStore()
  const notify = useNotify()

  const providers = ref<AiProviderView[]>([])
  const providersLoaded = ref(false)
  /** Provider picked in the panel (null: the default from Ajustes). */
  const providerId = ref<string | null>(null)

  const conversations = ref<AiConversationSummary[]>([])
  const conversationId = ref<string | null>(null)
  const conversationTitle = ref('')
  const messages = ref<AiMessage[]>([])
  /** Connection the open conversation belongs to. */
  const conversationConnectionId = ref<string | null>(null)

  /** Panel request in flight. */
  const requestId = ref<string | null>(null)
  const status = ref('')
  const lastUsage = ref<AiUsage | null>(null)
  /** Model that answered last (after a Claude server-side fallback it may differ). */
  const lastModel = ref<string | null>(null)

  const handlers = new Map<string, RequestHandlers>()
  /** Events that arrived before the request id was known (ordering safety net). */
  const early = new Map<string, AiEvent[]>()

  const enabled = computed(() => settings.settings.aiEnabled)
  const busy = computed(() => requestId.value !== null)

  const activeProvider = computed<AiProviderView | null>(() => {
    const wanted = providerId.value ?? settings.settings.aiDefaultProviderId
    return (
      (wanted ? providers.value.find((p) => p.id === wanted) : undefined) ??
      providers.value[0] ??
      null
    )
  })

  /**
   * Where the assistant looks: the active query tab (its connection and
   * database), else the tree selection, else the only open connection.
   */
  const target = computed<AiTarget | null>(() => {
    const editor = queryEditorFor(tabs.activeId)
    // `database` only exists for PostgreSQL (query tab, tab or tree node); MySQL targets never carry it.
    if (editor && editor.connectionId()) {
      const db = editor.database?.() ?? null
      return {
        connectionId: editor.connectionId(),
        schema: editor.schema(),
        ...(db ? { database: db } : {})
      }
    }
    const active = tabs.active
    if (active?.connectionId && active.kind !== 'objects')
      return {
        connectionId: active.connectionId,
        schema: active.schema ?? null,
        ...(active.database ? { database: active.database } : {})
      }
    const sel = tree.selected as (typeof tree.selected & { database?: string }) | null
    if (sel?.connectionId)
      return {
        connectionId: sel.connectionId,
        schema: sel.schema ?? null,
        ...(sel.database ? { database: sel.database } : {})
      }
    const open = connections.items.filter((c) => connections.isOpen(c.id))
    return open.length === 1 ? { connectionId: open[0].id, schema: null } : null
  })

  /**
   * «Solo esta base de datos» or «Toda la conexión», remembered on this
   * computer. Without a selected database the scope is the whole connection.
   */
  const scope = ref<AiScope>(readScope())
  watch(scope, (value) => {
    try {
      localStorage.setItem(SCOPE_KEY, value)
    } catch {
      /* best effort */
    }
  })
  const effectiveScope = computed<AiScope>(() =>
    target.value?.schema ? scope.value : 'connection'
  )

  /** Table of the open tab (table data / designer), prioritised in the context. */
  const openTable = computed<string | null>(() => {
    const a = tabs.active
    return a && (a.kind === 'tableData' || a.kind === 'tableDesigner')
      ? (a.objectName ?? null)
      : null
  })

  async function loadProviders(): Promise<void> {
    try {
      providers.value = (await api.ai.providers()) ?? []
    } finally {
      providersLoaded.value = true
    }
  }

  async function loadConversations(connectionId: string | null): Promise<void> {
    if (!connectionId) {
      conversations.value = []
      return
    }
    try {
      conversations.value = (await api.ai.conversations(connectionId)) ?? []
    } catch {
      conversations.value = []
    }
  }

  function newConversation(): void {
    if (busy.value) return
    conversationId.value = null
    conversationTitle.value = ''
    messages.value = []
    lastUsage.value = null
    lastModel.value = null
    conversationConnectionId.value = target.value?.connectionId ?? null
  }

  async function openConversation(id: string): Promise<void> {
    const cid = target.value?.connectionId
    if (!cid || busy.value) return
    const c = await api.ai.conversation(cid, id)
    if (!c) {
      notify.warning('No se encontró la conversación')
      await loadConversations(cid)
      return
    }
    conversationId.value = c.id
    conversationTitle.value = c.title
    messages.value = c.messages
    conversationConnectionId.value = c.connectionId
    lastUsage.value = [...c.messages].reverse().find((m) => m.usage)?.usage ?? null
  }

  async function renameConversation(id: string, title: string): Promise<void> {
    const cid = target.value?.connectionId
    const name = title.trim()
    if (!cid || !name) return
    const c = await api.ai.conversation(cid, id)
    if (!c) return
    await api.ai.saveConversation({ ...c, title: name })
    if (conversationId.value === id) conversationTitle.value = name
    await loadConversations(cid)
  }

  async function deleteConversation(id: string): Promise<void> {
    const cid = target.value?.connectionId
    if (!cid) return
    await api.ai.deleteConversation(cid, id)
    if (conversationId.value === id) newConversation()
    await loadConversations(cid)
  }

  async function persist(): Promise<void> {
    const cid = conversationConnectionId.value
    if (!cid || !messages.value.length) return
    try {
      const saved = await api.ai.saveConversation({
        id: conversationId.value ?? undefined,
        connectionId: cid,
        title: conversationTitle.value || titleFrom(messages.value[0]?.text ?? ''),
        schema: target.value?.connectionId === cid ? (target.value?.schema ?? null) : null,
        messages: messages.value
      })
      conversationId.value = saved.id
      conversationTitle.value = saved.title
      await loadConversations(cid)
    } catch {
      /* already reported by api.invoke */
    }
  }

  function handle(event: AiEvent): void {
    const id = event.payload.requestId
    const h = handlers.get(id)
    if (!h) {
      const list = early.get(id) ?? []
      list.push(event)
      early.set(id, list.slice(-500))
      return
    }
    if (event.channel === 'delta') h.onDelta(event.payload.text)
    else if (event.channel === 'status') h.onStatus(event.payload.status)
    else {
      handlers.delete(id)
      h.onDone(event.payload)
    }
  }

  function attach(id: string, h: RequestHandlers): void {
    handlers.set(id, h)
    const pending = early.get(id)
    early.delete(id)
    for (const e of pending ?? []) handle(e)
  }

  /** Subscribes to main's AI events; returns the disposer. */
  function listen(): () => void {
    const off = [
      api.on('event:aiDelta', (payload) => handle({ channel: 'delta', payload })),
      api.on('event:aiStatus', (payload) => handle({ channel: 'status', payload })),
      api.on('event:aiDone', (payload) => handle({ channel: 'done', payload }))
    ]
    return () => off.forEach((f) => f())
  }

  function requestBase(
    mode: AiMode,
    input: string,
    extras: ChatExtras
  ): Omit<AiChatRequest, 'history'> | null {
    const t = target.value
    if (!t) {
      notify.warning('Abre una conexión (o una consulta) para usar el asistente')
      return null
    }
    return {
      providerId: activeProvider.value?.id ?? null,
      connectionId: t.connectionId,
      schema: t.schema,
      ...(t.database ? { database: t.database } : {}),
      scope: effectiveScope.value,
      mode,
      input,
      sql: extras.sql ?? null,
      error: extras.error ?? null,
      editorSql: extras.editorSql ?? null,
      openTable: extras.openTable ?? openTable.value
    }
  }

  /** Panel conversation: question, «Explicar / optimizar» or «Explicar error». */
  async function send(mode: AiMode, input: string, extras: ChatExtras = {}): Promise<void> {
    if (busy.value) return
    if (!enabled.value) {
      notify.warning('Activa el asistente de IA en Ajustes › IA')
      return
    }
    const base = requestBase(mode, input, extras)
    if (!base) return
    // A conversation belongs to one connection: switching starts a new one.
    if (conversationConnectionId.value && conversationConnectionId.value !== base.connectionId)
      newConversation()
    conversationConnectionId.value = base.connectionId
    const history = messages.value.filter((m) => !m.stopReason || m.stopReason === 'end_turn')
    const userMessage: AiMessage = {
      role: 'user',
      text: displayText(mode, input, extras),
      createdAt: new Date().toISOString()
    }
    const answer: AiMessage = { role: 'assistant', text: '', createdAt: new Date().toISOString() }
    messages.value = [...messages.value, userMessage, answer]
    const index = messages.value.length - 1
    const update = (patch: Partial<AiMessage>): void => {
      const next = [...messages.value]
      next[index] = { ...next[index], ...patch }
      messages.value = next
    }
    status.value = 'Enviando…'
    requestId.value = 'pending'
    try {
      const { requestId: id } = await api.ai.chat({ ...base, history })
      requestId.value = id
      attach(id, {
        onDelta: (text) => {
          status.value = ''
          update({ text: messages.value[index].text + text })
        },
        onStatus: (s) => {
          status.value = s
        },
        onDone: (e) => {
          requestId.value = null
          status.value = ''
          if (e.usage) lastUsage.value = e.usage
          lastModel.value = e.model ?? null
          finishAnswer(update, messages.value[index].text, e)
          void persist()
        }
      })
    } catch (err) {
      requestId.value = null
      status.value = ''
      update({ text: errorMessage(err), stopReason: 'error' })
    }
  }

  function finishAnswer(
    update: (p: Partial<AiMessage>) => void,
    partial: string,
    e: AiDoneEvent
  ): void {
    const stopReason: AiStopReason = e.stopReason
    if (stopReason === 'refusal') {
      // A refused answer is discarded, even if part of it was streamed.
      update({ text: e.error ?? 'El modelo ha rechazado responder.', stopReason, usage: e.usage })
    } else if (stopReason === 'error') {
      update({
        text: partial ? `${partial}\n\n> ${e.error ?? 'Error'}` : (e.error ?? 'Error desconocido'),
        stopReason,
        usage: e.usage
      })
    } else if (stopReason === 'cancelled') {
      update({
        text: partial ? `${partial}\n\n> Respuesta detenida.` : 'Respuesta detenida.',
        stopReason
      })
    } else if (stopReason === 'max_tokens') {
      update({
        text: `${partial}\n\n> La respuesta se cortó al llegar al máximo de tokens (Ajustes › IA).`,
        stopReason,
        usage: e.usage
      })
    } else if (stopReason === 'tool_limit') {
      update({
        text: `${partial}\n\n> El modelo pidió demasiadas veces más estructura; pregunta de forma más concreta.`,
        stopReason,
        usage: e.usage
      })
    } else update({ usage: e.usage, ...(stopReason !== 'end_turn' ? { stopReason } : {}) })
  }

  /**
   * «Generar SQL con IA»: one-shot request outside the conversation. Streams
   * into `onText`; resolves with the final text and stop reason.
   */
  async function generate(
    input: string,
    extras: ChatExtras,
    onText: (full: string) => void,
    onStatus: (s: string) => void = () => undefined
  ): Promise<{ id: string; done: Promise<{ text: string; event: AiDoneEvent }> } | null> {
    if (!enabled.value) {
      notify.warning('Activa el asistente de IA en Ajustes › IA')
      return null
    }
    const base = requestBase('generateSql', input, extras)
    if (!base) return null
    const { requestId: id } = await api.ai.chat({ ...base, history: [] })
    let text = ''
    const done = new Promise<{ text: string; event: AiDoneEvent }>((resolve) => {
      attach(id, {
        onDelta: (t) => {
          text += t
          onText(text)
        },
        onStatus,
        onDone: (event) => resolve({ text, event })
      })
    })
    return { id, done }
  }

  async function cancel(id: string | null = requestId.value): Promise<void> {
    if (!id || id === 'pending') return
    await api.ai.cancel(id).catch(() => undefined)
  }

  /**
   * Inserts SQL into the active query editor at the cursor (or a new query tab
   * of the target connection). Never runs it.
   */
  function insertSql(sql: string): void {
    const text = sql.trim()
    if (!text) return
    const editor = queryEditorFor(tabs.activeId)
    if (editor) editor.insertAtCursor(text)
    else {
      const t = target.value
      if (!t) {
        notify.warning('Abre una conexión para insertar el SQL en una consulta')
        return
      }
      useWorkspace().openQuery(t.connectionId, t.schema, { sql: text })
    }
    notify.success('SQL insertado en el editor (no se ha ejecutado)')
  }

  /** Opens the panel (replacing Información) and asks the question. */
  async function ask(mode: AiMode, input: string, extras: ChatExtras = {}): Promise<void> {
    useUiStore().toggleAiPanel(true)
    await send(mode, input, extras)
  }

  // The conversation list follows the target connection.
  watch(
    () => target.value?.connectionId ?? null,
    (cid) => {
      void loadConversations(cid)
      if (!busy.value && conversationConnectionId.value && conversationConnectionId.value !== cid)
        newConversation()
    }
  )

  return {
    providers,
    providersLoaded,
    providerId,
    activeProvider,
    conversations,
    conversationId,
    conversationTitle,
    messages,
    requestId,
    status,
    lastUsage,
    lastModel,
    enabled,
    busy,
    target,
    scope,
    effectiveScope,
    openTable,
    loadProviders,
    loadConversations,
    newConversation,
    openConversation,
    renameConversation,
    deleteConversation,
    listen,
    send,
    ask,
    generate,
    cancel,
    insertSql
  }
})
