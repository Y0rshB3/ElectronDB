import { describe, expect, it, vi } from 'vitest'
import type { AiProviderType } from '@shared/ai'
import type { AdapterRequest } from './adapter'
import { NO_KEY, OpenAiCompatAdapter } from './openaiCompat'
import { fakeFetch, jsonResponse, openAiStream } from './testing'
import { MAX_TOOL_ROUNDS } from './tools'

function request(overrides: Partial<AdapterRequest> = {}): AdapterRequest {
  return {
    model: 'some-model',
    instructions: 'INSTRUCTIONS',
    context: 'CONTEXT',
    history: [],
    userMessage: 'pregunta',
    effort: 'low',
    maxTokens: 4000,
    signal: new AbortController().signal,
    tool: null,
    ...overrides
  }
}

function make(
  type: AiProviderType,
  baseUrl: string,
  responses: Parameters<typeof fakeFetch>[0],
  apiKey: string | null = 'sk-x'
) {
  const net = fakeFetch(responses)
  return {
    adapter: new OpenAiCompatAdapter({ type, baseUrl, apiKey, fetch: net.fetch, maxRetries: 0 }),
    net
  }
}

describe('OpenAI-compatible adapter', () => {
  it('streams text, uses one system message and reports usage (OpenAI)', async () => {
    const { adapter, net } = make('openai', 'https://api.openai.com/v1', [
      openAiStream({
        text: ['Hola', ' mundo'],
        finish: 'stop',
        usage: { prompt: 30, completion: 4 }
      })
    ])
    const deltas: string[] = []
    const result = await adapter.chat(
      request({
        history: [
          { role: 'user', text: 'a' },
          { role: 'assistant', text: 'b' }
        ]
      }),
      {
        onText: (t) => deltas.push(t)
      }
    )
    expect(deltas.join('')).toBe('Hola mundo')
    expect(result).toMatchObject({
      stopReason: 'end_turn',
      usage: { inputTokens: 30, outputTokens: 4 }
    })
    const req = net.requests[0]
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(req.headers.authorization).toBe('Bearer sk-x')
    const body = req.body!
    expect(body.stream).toBe(true)
    expect(body.max_completion_tokens).toBe(4000)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.messages).toEqual([
      { role: 'system', content: 'INSTRUCTIONS\n\nCONTEXT' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'pregunta' }
    ])
    expect(body).not.toHaveProperty('temperature')
  })

  it('uses max_tokens and no stream_options on compatible providers; no key for Ollama', async () => {
    const { adapter, net } = make(
      'ollama',
      'http://localhost:11434/v1',
      [openAiStream({ text: ['ok'], finish: 'stop' })],
      null
    )
    await adapter.chat(request(), { onText: () => undefined })
    const req = net.requests[0]
    expect(req.url).toBe('http://localhost:11434/v1/chat/completions')
    expect(req.headers.authorization).toBe(`Bearer ${NO_KEY}`)
    expect(req.body!.max_tokens).toBe(4000)
    expect(req.body).not.toHaveProperty('stream_options')
  })

  it.each([
    ['groq', 'https://api.groq.com/openai/v1'],
    ['xai', 'https://api.x.ai/v1'],
    ['zhipu', 'https://open.bigmodel.cn/api/paas/v4'],
    ['zai', 'https://api.z.ai/api/paas/v4']
  ] as const)('targets the %s base URL', async (type, base) => {
    const { adapter, net } = make(type, base, [openAiStream({ text: ['ok'], finish: 'stop' })])
    await adapter.chat(request(), { onText: () => undefined })
    expect(net.requests[0].url).toBe(`${base}/chat/completions`)
  })

  it('runs tool calls (streamed in fragments) and continues', async () => {
    const tool = vi.fn(async () => 'orders: id int PK')
    const { adapter, net } = make('openai', 'https://api.openai.com/v1', [
      openAiStream({
        finish: 'tool_calls',
        toolCalls: [
          {
            id: 'call_1',
            name: 'get_table_structure',
            args: JSON.stringify({ schema: 'shop', tables: ['orders'] })
          },
          { id: 'call_2', name: 'get_table_structure', args: '{"schema": 1}' }
        ]
      }),
      openAiStream({ text: ['Hecho'], finish: 'stop' })
    ])
    const result = await adapter.chat(request({ tool }), { onText: () => undefined })
    expect(result.stopReason).toBe('end_turn')
    expect(tool).toHaveBeenCalledWith({ schema: 'shop', tables: ['orders'] })
    const first = net.requests[0].body!
    expect(first.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({ name: 'get_table_structure' })
      })
    ])
    expect(first.tool_choice).toBe('auto')
    const msgs = net.requests[1].body!.messages as Record<string, unknown>[]
    expect(msgs.at(-3)).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call_1' }, { id: 'call_2' }]
    })
    expect(msgs.at(-2)).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'orders: id int PK'
    })
    expect(msgs.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_2' })
    expect(String(msgs.at(-1)!.content)).toMatch(/^Error: invalid input/)
  })

  it('retries once without tools when the provider rejects them', async () => {
    const tool = vi.fn(async () => 'x')
    const { adapter, net } = make('custom', 'https://llm.example.com/v1', [
      jsonResponse(400, {
        error: { message: 'tools not supported', type: 'invalid_request_error' }
      }),
      openAiStream({ text: ['sin herramientas'], finish: 'stop' })
    ])
    const deltas: string[] = []
    const result = await adapter.chat(request({ tool }), { onText: (t) => deltas.push(t) })
    expect(result.stopReason).toBe('end_turn')
    expect(deltas.join('')).toBe('sin herramientas')
    expect(net.requests).toHaveLength(2)
    expect(net.requests[0].body).toHaveProperty('tools')
    expect(net.requests[1].body).not.toHaveProperty('tools')
  })

  it('does not retry a 400 twice', async () => {
    const tool = vi.fn(async () => 'x')
    const { adapter, net } = make('custom', 'https://llm.example.com/v1', [
      jsonResponse(400, { error: { message: 'bad' } }),
      jsonResponse(400, { error: { message: 'still bad' } })
    ])
    const result = await adapter.chat(request({ tool }), { onText: () => undefined })
    expect(result.stopReason).toBe('error')
    expect(result.error).toMatch(/still bad/)
    expect(net.requests).toHaveLength(2)
  })

  it(`stops after ${MAX_TOOL_ROUNDS} tool rounds`, async () => {
    const tool = vi.fn(async () => 'x')
    const turn = () =>
      openAiStream({
        finish: 'tool_calls',
        toolCalls: [{ id: 'c', name: 'get_table_structure', args: '{"schema":"s","tables":["t"]}' }]
      })
    const { adapter, net } = make(
      'openai',
      'https://api.openai.com/v1',
      Array.from({ length: MAX_TOOL_ROUNDS + 1 }, turn)
    )
    const result = await adapter.chat(request({ tool }), { onText: () => undefined })
    expect(result.stopReason).toBe('tool_limit')
    expect(net.requests).toHaveLength(MAX_TOOL_ROUNDS)
  })

  it('maps finish reasons', async () => {
    const { adapter: a1 } = make('openai', 'https://api.openai.com/v1', [
      openAiStream({ text: ['…'], finish: 'length' })
    ])
    expect((await a1.chat(request(), { onText: () => undefined })).stopReason).toBe('max_tokens')
    const { adapter: a2 } = make('openai', 'https://api.openai.com/v1', [
      openAiStream({ finish: 'content_filter' })
    ])
    const r2 = await a2.chat(request(), { onText: () => undefined })
    expect(r2.stopReason).toBe('refusal')
    expect(r2.error).toMatch(/filtro de contenido/)
  })

  it.each([
    [401, /Clave inválida: Groq/],
    [404, /no encuentra el modelo/],
    [429, /429/]
  ])('maps HTTP %i with typed errors', async (status, expected) => {
    const { adapter } = make('groq', 'https://api.groq.com/openai/v1', [
      jsonResponse(status, { error: { message: 'x' } })
    ])
    const result = await adapter.chat(request(), { onText: () => undefined })
    expect(result.error).toMatch(expected)
  })

  it('explains an unreachable Ollama', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const adapter = new OpenAiCompatAdapter({
      type: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: null,
      fetch: failing,
      maxRetries: 0
    })
    const result = await adapter.chat(request(), { onText: () => undefined })
    expect(result.error).toMatch(/ollama serve/)
  })

  it('lists models and handles providers that cannot', async () => {
    const { adapter } = make('groq', 'https://api.groq.com/openai/v1', [
      jsonResponse(200, {
        object: 'list',
        data: [
          { id: 'b-model', object: 'model' },
          { id: 'a-model', object: 'model' }
        ]
      })
    ])
    expect(await adapter.listModels()).toEqual(['a-model', 'b-model'])
    const { adapter: noList } = make('zai', 'https://api.z.ai/api/paas/v4', [
      jsonResponse(404, { error: { message: 'not found' } })
    ])
    await expect(noList.listModels()).rejects.toThrow(/no permite listar modelos/)
  })
})
