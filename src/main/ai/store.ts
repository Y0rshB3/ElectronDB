import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AiConversation,
  AiConversationInput,
  AiConversationSummary,
  AiMessage,
  AiStopReason
} from '@shared/ai'
import { JsonStore } from '../storage/jsonStore'
import { newId, nowIso } from '../storage/ids'

/** Limits that keep the profile JSON small (the history sent to a model is capped further). */
export const MAX_CONVERSATIONS_PER_CONNECTION = 200
export const MAX_MESSAGES_PER_CONVERSATION = 400
export const MAX_MESSAGE_CHARS = 200_000
export const MAX_TITLE_CHARS = 120
export const MAX_MEMORY_CHARS = 20_000

const STOP_REASONS: readonly AiStopReason[] = [
  'end_turn',
  'max_tokens',
  'refusal',
  'tool_limit',
  'cancelled',
  'error',
  'other'
]

function requireId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value || value.length > 200)
    throw new Error(`${what} no válido.`)
  return value
}

function cleanMessage(raw: AiMessage): AiMessage | null {
  if (!raw || (raw.role !== 'user' && raw.role !== 'assistant')) return null
  const text = typeof raw.text === 'string' ? raw.text.slice(0, MAX_MESSAGE_CHARS) : ''
  const msg: AiMessage = { role: raw.role, text }
  if (typeof raw.createdAt === 'string') msg.createdAt = raw.createdAt
  if (raw.stopReason && STOP_REASONS.includes(raw.stopReason)) msg.stopReason = raw.stopReason
  const u = raw.usage
  if (u && typeof u === 'object') {
    const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0)
    msg.usage = {
      inputTokens: n(u.inputTokens),
      outputTokens: n(u.outputTokens),
      ...(u.cacheReadTokens !== undefined ? { cacheReadTokens: n(u.cacheReadTokens) } : {}),
      ...(u.cacheWriteTokens !== undefined ? { cacheWriteTokens: n(u.cacheWriteTokens) } : {})
    }
  }
  return msg
}

interface ConversationsDoc {
  version: number
  items: AiConversation[]
}

/**
 * Conversation history, one file per connection under userData/ai/
 * (`conversations-<hash>.json`). Local only: never synced or sent anywhere
 * except as history of the next question to the provider the user picked.
 */
export class AiConversationsRepo {
  private readonly cache = new Map<string, JsonStore<ConversationsDoc>>()
  constructor(private readonly dir: string) {}

  private fileOf(connectionId: string): string {
    const hash = createHash('sha256').update(connectionId).digest('hex').slice(0, 24)
    return join(this.dir, 'ai', `conversations-${hash}.json`)
  }

  private store(connectionId: string): JsonStore<ConversationsDoc> {
    const id = requireId(connectionId, 'Conexión')
    let s = this.cache.get(id)
    if (!s) {
      s = new JsonStore<ConversationsDoc>(this.fileOf(id), () => ({ version: 1, items: [] }))
      this.cache.set(id, s)
    }
    return s
  }

  list(connectionId: string): AiConversationSummary[] {
    return this.store(connectionId)
      .get()
      .items.filter((c) => c.connectionId === connectionId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => ({
        id: c.id,
        connectionId: c.connectionId,
        title: c.title,
        schema: c.schema,
        updatedAt: c.updatedAt,
        messageCount: c.messages.length
      }))
  }

  get(connectionId: string, id: string): AiConversation | null {
    return (
      this.store(connectionId)
        .get()
        .items.find((c) => c.id === id) ?? null
    )
  }

  save(input: AiConversationInput): AiConversation {
    if (!input || typeof input !== 'object') throw new Error('Conversación no válida.')
    const connectionId = requireId(input.connectionId, 'Conexión')
    const store = this.store(connectionId)
    const existing = input.id ? this.get(connectionId, input.id) : null
    const now = nowIso()
    const messages = (Array.isArray(input.messages) ? input.messages : [])
      .map(cleanMessage)
      .filter((m): m is AiMessage => m !== null)
      .slice(-MAX_MESSAGES_PER_CONVERSATION)
    const title =
      String(input.title ?? '')
        .trim()
        .slice(0, MAX_TITLE_CHARS) || 'Conversación'
    const record: AiConversation = {
      id: existing?.id ?? newId(),
      connectionId,
      title,
      schema: typeof input.schema === 'string' && input.schema ? input.schema : null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      messages
    }
    store.update((d) => {
      const idx = d.items.findIndex((c) => c.id === record.id)
      if (idx >= 0) d.items[idx] = record
      else d.items.push(record)
      if (d.items.length > MAX_CONVERSATIONS_PER_CONNECTION) {
        d.items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        d.items.length = MAX_CONVERSATIONS_PER_CONNECTION
      }
    })
    return record
  }

  delete(connectionId: string, id: string): void {
    this.store(connectionId).update((d) => {
      d.items = d.items.filter((c) => c.id !== id)
    })
  }

  /** Drops every conversation of a deleted connection. */
  deleteConnection(connectionId: string): void {
    this.cache.delete(connectionId)
    const file = this.fileOf(connectionId)
    if (existsSync(file)) rmSync(file, { force: true })
  }
}

interface MemoryDoc {
  version: number
  connections: Record<string, { notes: string; databases: Record<string, string> }>
}

/**
 * «Memoria»: free-text notes per connection and per database (business rules,
 * meaning of statuses, conventions), sent with the schema context.
 * userData/ai-memory.json.
 */
export class AiMemoryRepo {
  private store: JsonStore<MemoryDoc>
  constructor(dir: string) {
    this.store = new JsonStore<MemoryDoc>(join(dir, 'ai-memory.json'), () => ({
      version: 1,
      connections: {}
    }))
  }

  get(connectionId: string, schema: string | null): string {
    const entry = this.store.get().connections[requireId(connectionId, 'Conexión')]
    if (!entry) return ''
    return (schema ? entry.databases?.[schema] : entry.notes) ?? ''
  }

  set(connectionId: string, schema: string | null, text: string): void {
    const id = requireId(connectionId, 'Conexión')
    const value = String(text ?? '')
    if (value.length > MAX_MEMORY_CHARS)
      throw new Error(`La memoria es demasiado larga (máx. ${MAX_MEMORY_CHARS} caracteres).`)
    this.store.update((d) => {
      const entry = (d.connections[id] ??= { notes: '', databases: {} })
      entry.databases ??= {}
      if (schema) {
        if (value.trim()) entry.databases[schema] = value
        else delete entry.databases[schema]
      } else entry.notes = value
      if (!entry.notes && !Object.keys(entry.databases).length) delete d.connections[id]
    })
  }

  deleteConnection(connectionId: string): void {
    this.store.update((d) => {
      delete d.connections[connectionId]
    })
  }
}
