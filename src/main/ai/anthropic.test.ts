import { describe, expect, it, vi } from 'vitest'
import type { AdapterRequest } from './adapter'
import { AnthropicAdapter, FALLBACK_BETA, usesAdaptiveThinking, usesFallbacks } from './anthropic'
import { anthropicStream, fakeFetch, jsonResponse } from './testing'
import { MAX_TOOL_ROUNDS } from './tools'

function request(overrides: Partial<AdapterRequest> = {}): AdapterRequest {
  return {
    model: 'claude-opus-5-5',
    instructions: 'INSTRUCTIONS',
    context: 'CONTEXT shot_orders: id int PK',
    history: [
      { role: 'user', text: 'hola' },
      { role: 'assistant', text: 'hola, ¿en qué te ayudo?' }
    ],
    userMessage: '¿Cuántos pedidos hay?',
    effort: 'low',
    maxTokens: 16000,
    signal: new AbortController().signal,
    tool: null,
    ...overrides
  }
}

function adapter(responses: Parameters<typeof fakeFetch>[0]) {
  const net = fakeFetch(responses)
  return {
    adapter: new AnthropicAdapter({ apiKey: 'sk-test', fetch: net.fetch, maxRetries: 0 }),
    net
  }
}

describe('Anthropic request shape', () => {
  it('sends adaptive thinking, effort, cached context block and fallbacks for Opus 5.5', async () => {
    const { adapter: a, net } = adapter([
      anthropicStream({ text: ['Hay ', '42.'], stopReason: 'end_turn' })
    ])
    const deltas: string[] = []
    const result = await a.chat(request(), { onText: (t) => deltas.push(t) })
    expect(result.stopReason).toBe('end_turn')
    expect(deltas.join('')).toBe('Hay 42.')
    const req = net.requests[0]
    expect(req.url).toBe('https://api.anthropic.com/v1/messages?beta=true')
    expect(req.headers['x-api-key']).toBe('sk-test')
    expect(req.headers['anthropic-beta']).toBe(FALLBACK_BETA)
    const body = req.body!
    expect(body.model).toBe('claude-opus-5-5')
    expect(body.stream).toBe(true)
    expect(body.max_tokens).toBe(16000)
    expect(body.thinking).toEqual({ type: 'adaptive' })
    expect(body.output_config).toEqual({ effort: 'low' })
    expect(body.fallbacks).toBe('default')
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('top_p')
    expect(body).not.toHaveProperty('betas')
    expect(body.system).toEqual([
      { type: 'text', text: 'INSTRUCTIONS' },
      { type: 'text', text: 'CONTEXT shot_orders: id int PK', cache_control: { type: 'ephemeral' } }
    ])
    // History then the volatile question; no assistant prefill at the end.
    const messages = body.messages as { role: string; content: unknown }[]
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[2].content).toBe('¿Cuántos pedidos hay?')
    expect(body).not.toHaveProperty('tools')
  })

  it.each(['claude-sonnet-5-5', 'claude-fable-5-1'])(
    'enables fallbacks and adaptive thinking on %s',
    async (model) => {
      const { adapter: a, net } = adapter([
        anthropicStream({ text: ['ok'], stopReason: 'end_turn', model })
      ])
      await a.chat(request({ model, effort: 'high' }), { onText: () => undefined })
      const body = net.requests[0].body!
      expect(body.fallbacks).toBe('default')
      expect(body.thinking).toEqual({ type: 'adaptive' })
      expect(body.output_config).toEqual({ effort: 'high' })
      expect(net.requests[0].headers['anthropic-beta']).toBe(FALLBACK_BETA)
    }
  )

  it('omits thinking, effort and fallbacks for claude-haiku-4-5 (plain messages endpoint)', async () => {
    const model = 'claude-haiku-4-5'
    const { adapter: a, net } = adapter([
      anthropicStream({ text: ['ok'], stopReason: 'end_turn', model })
    ])
    await a.chat(request({ model }), { onText: () => undefined })
    const req = net.requests[0]
    expect(req.url).toBe('https://api.anthropic.com/v1/messages')
    expect(req.headers['anthropic-beta']).toBeUndefined()
    expect(req.body).not.toHaveProperty('thinking')
    expect(req.body).not.toHaveProperty('output_config')
    expect(req.body).not.toHaveProperty('fallbacks')
    expect((req.body!.system as unknown[])[1]).toMatchObject({
      cache_control: { type: 'ephemeral' }
    })
  })

  it('model helpers', () => {
    expect(usesAdaptiveThinking('claude-opus-5-5')).toBe(true)
    expect(usesAdaptiveThinking('claude-haiku-4-5')).toBe(false)
    expect(usesAdaptiveThinking('claude-3-7-sonnet')).toBe(false)
    expect(usesFallbacks('claude-opus-5-5')).toBe(true)
    expect(usesFallbacks('claude-haiku-4-5')).toBe(false)
    expect(usesFallbacks('claude-opus-5')).toBe(false)
  })

  it('reports usage including cache reads and writes', async () => {
    const { adapter: a } = adapter([
      anthropicStream({
        text: ['x'],
        stopReason: 'end_turn',
        usage: { input: 50, output: 7, cacheRead: 900, cacheWrite: 30 }
      })
    ])
    const result = await a.chat(request(), { onText: () => undefined })
    expect(result.usage).toEqual({
      inputTokens: 50,
      outputTokens: 7,
      cacheReadTokens: 900,
      cacheWriteTokens: 30
    })
    expect(result.model).toBe('claude-opus-5-5')
  })
})

describe('Anthropic stop reasons and errors', () => {
  it('turns a refusal into a Spanish message with the category', async () => {
    const { adapter: a } = adapter([
      anthropicStream({
        text: ['Lo sien'],
        stopReason: 'refusal',
        stopDetails: { type: 'refusal', category: 'cyber', explanation: null }
      })
    ])
    const result = await a.chat(request(), { onText: () => undefined })
    expect(result.stopReason).toBe('refusal')
    expect(result.error).toMatch(/Claude ha rechazado responder.*cyber/)
  })

  it('reports max_tokens', async () => {
    const { adapter: a } = adapter([anthropicStream({ text: ['…'], stopReason: 'max_tokens' })])
    expect((await a.chat(request(), { onText: () => undefined })).stopReason).toBe('max_tokens')
  })

  it.each([
    [401, { type: 'authentication_error', message: 'invalid x-api-key' }, /Clave inválida/],
    [403, { type: 'permission_error', message: 'no' }, /no tiene permiso/],
    [404, { type: 'not_found_error', message: 'model' }, /no existe o no está disponible/],
    [429, { type: 'rate_limit_error', message: 'slow down' }, /429/],
    [
      400,
      { type: 'invalid_request_error', message: 'bad field' },
      /rechazado la petición \(400\): .*bad field/
    ],
    [529, { type: 'overloaded_error', message: 'busy' }, /sobrecargado/],
    [500, { type: 'api_error', message: 'boom' }, /Error de Anthropic \(500\)/]
  ])('maps HTTP %i with the typed SDK error', async (status, error, expected) => {
    const { adapter: a } = adapter([jsonResponse(status, { type: 'error', error })])
    const result = await a.chat(request(), { onText: () => undefined })
    expect(result.stopReason).toBe('error')
    expect(result.error).toMatch(expected)
  })

  it('maps connection failures', async () => {
    const net = {
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch
    }
    const a = new AnthropicAdapter({ apiKey: 'k', fetch: net.fetch, maxRetries: 0 })
    const result = await a.chat(request(), { onText: () => undefined })
    expect(result.error).toMatch(/No se pudo conectar con Anthropic/)
  })

  it('reports cancellation when the signal aborts', async () => {
    const controller = new AbortController()
    controller.abort()
    const { adapter: a } = adapter([anthropicStream({ text: ['x'], stopReason: 'end_turn' })])
    const result = await a.chat(request({ signal: controller.signal }), { onText: () => undefined })
    expect(result.stopReason).toBe('cancelled')
  })

  it('test() validates key and model without generating tokens', async () => {
    const { adapter: a, net } = adapter([
      jsonResponse(200, {
        id: 'claude-opus-5-5',
        display_name: 'Claude Opus 5.5',
        type: 'model',
        created_at: '2026-01-01T00:00:00Z'
      })
    ])
    const r = await a.test('claude-opus-5-5')
    expect(r.ok).toBe(true)
    expect(net.requests[0].url).toBe('https://api.anthropic.com/v1/models/claude-opus-5-5')
  })
})

describe('Anthropic tool loop', () => {
  it('sends the strict tool with auto choice, runs it and returns all results in one user message', async () => {
    const tool = vi.fn(
      async (input: { schema: string; tables: string[] }) => `${input.tables.join(',')}: id int PK`
    )
    const { adapter: a, net } = adapter([
      anthropicStream({
        text: ['Miro la estructura.'],
        stopReason: 'tool_use',
        toolUses: [
          {
            id: 'tu_1',
            name: 'get_table_structure',
            input: { schema: 'shop', tables: ['orders'] }
          },
          { id: 'tu_2', name: 'get_table_structure', input: { schema: 'shop', tables: [] } },
          {
            id: 'tu_3',
            name: 'get_table_structure',
            input: { schema: 'shop', tables: ['x'], extra: 1 }
          }
        ]
      }),
      anthropicStream({ text: ['Listo.'], stopReason: 'end_turn' })
    ])
    const statuses: string[] = []
    const deltas: string[] = []
    const result = await a.chat(request({ tool }), {
      onText: (t) => deltas.push(t),
      onStatus: (s) => statuses.push(s)
    })
    expect(result.stopReason).toBe('end_turn')
    expect(deltas.join('')).toBe('Miro la estructura.\n\nListo.')
    expect(tool).toHaveBeenCalledTimes(1)
    expect(tool).toHaveBeenCalledWith({ schema: 'shop', tables: ['orders'] })
    expect(statuses[0]).toMatch(/orders/)

    const first = net.requests[0].body!
    expect(first.tools).toEqual([
      expect.objectContaining({
        name: 'get_table_structure',
        strict: true,
        input_schema: expect.objectContaining({
          additionalProperties: false,
          required: ['schema', 'tables']
        })
      })
    ])
    expect(first.tool_choice).toEqual({ type: 'auto' })

    const second = net.requests[1].body!.messages as { role: string; content: unknown }[]
    // history (2) + question + assistant tool_use turn + ONE user message with all results
    expect(second).toHaveLength(5)
    expect(second[3].role).toBe('assistant')
    expect((second[3].content as { type: string }[]).map((b) => b.type)).toEqual([
      'text',
      'tool_use',
      'tool_use',
      'tool_use'
    ])
    const results = second[4].content as {
      type: string
      tool_use_id: string
      is_error?: boolean
      content: string
    }[]
    expect(second[4].role).toBe('user')
    expect(results.map((r) => [r.tool_use_id, r.is_error ?? false])).toEqual([
      ['tu_1', false],
      ['tu_2', true],
      ['tu_3', true]
    ])
    expect(results[0].content).toBe('orders: id int PK')
    // The cached prefix is byte-identical between rounds.
    expect(net.requests[1].body!.system).toEqual(first.system)
  })

  it('returns is_error when the tool throws', async () => {
    const tool = vi.fn(async () => {
      throw new Error('sin conexión')
    })
    const { adapter: a, net } = adapter([
      anthropicStream({
        stopReason: 'tool_use',
        toolUses: [
          { id: 'tu_1', name: 'get_table_structure', input: { schema: 's', tables: ['t'] } }
        ]
      }),
      anthropicStream({ text: ['ok'], stopReason: 'end_turn' })
    ])
    await a.chat(request({ tool }), { onText: () => undefined })
    const results = (net.requests[1].body!.messages as { content: unknown }[]).at(-1)!.content as {
      is_error: boolean
      content: string
    }[]
    expect(results[0]).toMatchObject({ is_error: true, content: 'Error: sin conexión' })
  })

  it(`stops after ${MAX_TOOL_ROUNDS} rounds`, async () => {
    const tool = vi.fn(async () => 'x')
    const turn = () =>
      anthropicStream({
        stopReason: 'tool_use',
        toolUses: [{ id: 'tu', name: 'get_table_structure', input: { schema: 's', tables: ['t'] } }]
      })
    const { adapter: a, net } = adapter(Array.from({ length: MAX_TOOL_ROUNDS + 2 }, turn))
    const result = await a.chat(request({ tool }), { onText: () => undefined })
    expect(result.stopReason).toBe('tool_limit')
    expect(net.requests).toHaveLength(MAX_TOOL_ROUNDS)
    expect(tool).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS - 1)
  })

  it('never runs tools of a refused turn', async () => {
    const tool = vi.fn(async () => 'x')
    const { adapter: a } = adapter([
      anthropicStream({
        stopReason: 'refusal',
        toolUses: [{ id: 'tu', name: 'get_table_structure', input: { schema: 's', tables: ['t'] } }]
      })
    ])
    const result = await a.chat(request({ tool }), { onText: () => undefined })
    expect(result.stopReason).toBe('refusal')
    expect(tool).not.toHaveBeenCalled()
  })
})
