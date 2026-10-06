import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AiProviderView } from '@shared/ai'
import type { QueryStatementResult } from '@shared/types'
import { registerQueryEditor } from '@renderer/composables/useQueryEditors'
import { displayText, extractSql, useAiStore } from '@renderer/stores/ai'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useSettingsStore } from '@renderer/stores/settings'
import { useTabsStore } from '@renderer/stores/tabs'
import QueryMessages from '@renderer/components/query/QueryMessages.vue'
import { calls, freshPinia, makeConnection, mountWith, settle } from '../dialogs/testing'
import AiPanel from './AiPanel.vue'

const PROVIDER: AiProviderView = {
  id: 'p1',
  name: 'Claude',
  type: 'anthropic',
  baseUrl: '',
  model: 'claude-opus-5-5',
  createdAt: '',
  updatedAt: '',
  hasKey: true
}

type Listener = (payload: unknown) => void

function installBridge(handlers: Record<string, (...args: unknown[]) => unknown>): {
  invoke: Mock
  emit: (channel: string, payload: unknown) => void
} {
  const listeners: Record<string, Listener[]> = {}
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => handlers[channel]?.(...args))
  window.electronDB = {
    platform: 'darwin',
    invoke,
    on: (channel: string, l: Listener) => {
      ;(listeners[channel] ??= []).push(l)
      return () => undefined
    }
  } as never
  return { invoke, emit: (channel, payload) => listeners[channel]?.forEach((l) => l(payload)) }
}

describe('ai store helpers', () => {
  it('extracts the SQL of an answer', () => {
    expect(extractSql('Aquí tienes:\n```sql\nSELECT 1;\n```\nListo')).toBe('SELECT 1;')
    expect(extractSql('SELECT 2')).toBe('SELECT 2')
    expect(extractSql('```\nSELECT 3\n')).toBe('SELECT 3')
  })

  it('shows the explain prompts with the SQL', () => {
    expect(displayText('explainError', '', { sql: 'SELEC 1', error: 'syntax' })).toBe(
      '¿Por qué falla esta sentencia?\n\n```sql\nSELEC 1\n```\n\nError: syntax'
    )
  })
})

describe('AiPanel', () => {
  let bridge: ReturnType<typeof installBridge>
  let wrapper: ReturnType<typeof mountWith> | null = null
  let unregister: (() => void) | null = null
  const insertAtCursor = vi.fn()
  let nextId = 0
  let pinia: ReturnType<typeof freshPinia>

  beforeEach(async () => {
    nextId = 0
    insertAtCursor.mockClear()
    bridge = installBridge({
      'ai:providers': () => [PROVIDER],
      'ai:conversations': () => [],
      'ai:chat': () => ({ requestId: `r${++nextId}` }),
      'ai:cancel': () => undefined,
      'ai:saveConversation': (input: unknown) => ({
        ...(input as object),
        id: 'conv1',
        createdAt: 'x',
        updatedAt: 'x'
      })
    })
    pinia = freshPinia()
    useSettingsStore().settings = { ...useSettingsStore().settings, aiEnabled: true }
    useConnectionsStore().items = [
      makeConnection({ id: 'c1', name: 'Local Test', environment: 'production' })
    ]
    useTabsStore().open({ kind: 'query', id: 'q1', title: 'Consulta', connectionId: 'c1' })
    unregister = registerQueryEditor({
      tabId: 'q1',
      connectionId: () => 'c1',
      schema: () => 'app',
      sql: () => 'SELECT 1',
      selection: () => '',
      insertAtCursor
    })
    useAiStore().listen()
    wrapper = mountWith(AiPanel, pinia)
    await settle()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    unregister?.()
  })

  async function ask(text: string): Promise<void> {
    const input = wrapper!.find('[data-test="ai-input"] textarea')
    await input.setValue(text)
    await input.trigger('keydown', { key: 'Enter' })
    await settle()
  }

  it('shows the target with its environment pill and the privacy line', () => {
    expect(wrapper!.find('[data-test="ai-target"]').text()).toContain('Producción')
    expect(wrapper!.find('[data-test="ai-target"]').text()).toContain('app')
    expect(wrapper!.find('[data-test="ai-privacy"]').text()).toContain(
      'Solo se envía la estructura de la base de datos, nunca tus datos.'
    )
  })

  it('sends with Enter, streams the answer and inserts SQL into the editor without executing it', async () => {
    await ask('¿pedidos pendientes?')
    const [request] = calls(bridge.invoke, 'ai:chat')[0] as [Record<string, unknown>]
    expect(request).toMatchObject({
      mode: 'chat',
      input: '¿pedidos pendientes?',
      connectionId: 'c1',
      schema: 'app',
      providerId: 'p1',
      history: []
    })
    expect(wrapper!.find('[data-test="ai-stop"]').exists()).toBe(true)

    bridge.emit('event:aiDelta', { requestId: 'r1', text: 'Prueba:\n```sql\nSELECT * FROM ' })
    bridge.emit('event:aiDelta', { requestId: 'r1', text: "orders WHERE status = 'pending'\n```" })
    bridge.emit('event:aiDone', {
      requestId: 'r1',
      stopReason: 'end_turn',
      usage: { inputTokens: 1200, outputTokens: 40, cacheReadTokens: 1000 }
    })
    await settle()

    expect(wrapper!.find('[data-test="ai-code-block"]').text()).toContain('SELECT * FROM orders')
    expect(wrapper!.find('[data-test="ai-usage"]').text()).toMatch(/1[.,]?000 de caché/)
    await wrapper!.find('[data-test="ai-insert-sql"]').trigger('click')
    expect(insertAtCursor).toHaveBeenCalledWith("SELECT * FROM orders WHERE status = 'pending'")
    // Never executed: no db:execute, no EXPLAIN from the renderer.
    expect(calls(bridge.invoke, 'db:execute')).toEqual([])
    // The exchange is saved locally.
    const [saved] = calls(bridge.invoke, 'ai:saveConversation').at(-1) as [{ messages: unknown[] }]
    expect(saved.messages).toHaveLength(2)
  })

  it('Shift+Enter does not send', async () => {
    const input = wrapper!.find('[data-test="ai-input"] textarea')
    await input.setValue('hola')
    await input.trigger('keydown', { key: 'Enter', shiftKey: true })
    await settle()
    expect(calls(bridge.invoke, 'ai:chat')).toEqual([])
  })

  it('cancels a running answer with Detener', async () => {
    await ask('larga')
    bridge.emit('event:aiDelta', { requestId: 'r1', text: 'Empiezo…' })
    await settle()
    await wrapper!.find('[data-test="ai-stop"]').trigger('click')
    await settle()
    expect(calls(bridge.invoke, 'ai:cancel')).toEqual([['r1']])
    bridge.emit('event:aiDone', { requestId: 'r1', stopReason: 'cancelled' })
    await settle()
    expect(wrapper!.text()).toContain('Respuesta detenida.')
    expect(wrapper!.find('[data-test="ai-send"]').exists()).toBe(true)
  })

  it('replaces a refused answer with the Spanish message', async () => {
    await ask('algo')
    bridge.emit('event:aiDelta', { requestId: 'r1', text: 'texto parcial' })
    bridge.emit('event:aiDone', {
      requestId: 'r1',
      stopReason: 'refusal',
      error: 'Claude ha rechazado responder a esta petición.'
    })
    await settle()
    expect(wrapper!.text()).toContain('Claude ha rechazado responder')
    expect(wrapper!.text()).not.toContain('texto parcial')
  })

  it('sends the earlier turns as history', async () => {
    await ask('primera')
    bridge.emit('event:aiDelta', { requestId: 'r1', text: 'respuesta 1' })
    bridge.emit('event:aiDone', { requestId: 'r1', stopReason: 'end_turn' })
    await settle()
    await ask('segunda')
    const [request] = calls(bridge.invoke, 'ai:chat')[1] as [
      { history: { role: string; text: string }[] }
    ]
    expect(request.history.map((m) => [m.role, m.text])).toEqual([
      ['user', 'primera'],
      ['assistant', 'respuesta 1']
    ])
  })

  it('explains a failed statement from Mensajes', async () => {
    const results: QueryStatementResult[] = [
      {
        sql: 'SELECT nope FROM orders',
        error: "Unknown column 'nope'",
        durationMs: 3
      } as QueryStatementResult
    ]
    const messages = mountWith(QueryMessages, pinia, { props: { results, canExplain: true } })
    await messages.find('[data-test="explain-error-0"]').trigger('click')
    expect(messages.emitted('explain-error')?.[0]).toEqual([results[0]])
    const hidden = mountWith(QueryMessages, pinia, { props: { results, canExplain: false } })
    expect(hidden.find('[data-test="explain-error-0"]').exists()).toBe(false)
    messages.unmount()
    hidden.unmount()

    await useAiStore().ask('explainError', '', { sql: results[0].sql, error: results[0].error })
    const [request] = calls(bridge.invoke, 'ai:chat')[0] as [Record<string, unknown>]
    expect(request).toMatchObject({
      mode: 'explainError',
      sql: 'SELECT nope FROM orders',
      error: "Unknown column 'nope'"
    })
  })
})
