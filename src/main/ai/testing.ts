/**
 * Test helpers: fake network for the real SDKs (no provider is ever called).
 * Not imported by app code.
 */
import type { FetchFn } from './adapter'

export interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown> | null
}

/** A fetch that records requests and answers with the next queued Response. */
export function fakeFetch(responses: (Response | ((req: RecordedRequest) => Response))[]): {
  fetch: FetchFn
  requests: RecordedRequest[]
} {
  const requests: RecordedRequest[] = []
  const queue = [...responses]
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as Request).url)
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
    let body: Record<string, unknown> | null = null
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = null
      }
    }
    const req: RecordedRequest = { url, method: init?.method ?? 'GET', headers, body }
    requests.push(req)
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const next = queue.shift()
    if (!next) throw new Error(`unexpected request ${req.method} ${url}`)
    return typeof next === 'function' ? next(req) : next
  }) as FetchFn
  return { fetch: fetchFn, requests }
}

export function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function sseResponse(chunks: string[]): Response {
  return new Response(chunks.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

export interface FakeAnthropicTurn {
  text?: string[]
  toolUses?: { id: string; name: string; input: unknown }[]
  stopReason: string
  stopDetails?: Record<string, unknown> | null
  model?: string
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
}

/** Server-sent events of one Anthropic Messages streaming response. */
export function anthropicStream(turn: FakeAnthropicTurn): Response {
  const ev = (event: string, data: unknown): string =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const u = turn.usage ?? { input: 100, output: 20 }
  const out: string[] = [
    ev('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: turn.model ?? 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: u.input,
          output_tokens: 0,
          cache_read_input_tokens: u.cacheRead ?? 0,
          cache_creation_input_tokens: u.cacheWrite ?? 0
        }
      }
    })
  ]
  let index = 0
  if (turn.text?.length) {
    out.push(
      ev('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' }
      })
    )
    for (const t of turn.text)
      out.push(
        ev('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: t }
        })
      )
    out.push(ev('content_block_stop', { type: 'content_block_stop', index }))
    index++
  }
  for (const tu of turn.toolUses ?? []) {
    out.push(
      ev('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: tu.id, name: tu.name, input: {} }
      })
    )
    out.push(
      ev('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(tu.input) }
      })
    )
    out.push(ev('content_block_stop', { type: 'content_block_stop', index }))
    index++
  }
  out.push(
    ev('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: turn.stopReason,
        stop_sequence: null,
        stop_details: turn.stopDetails ?? null
      },
      usage: { output_tokens: u.output }
    })
  )
  out.push(ev('message_stop', { type: 'message_stop' }))
  return sseResponse(out)
}

export interface FakeOpenAiTurn {
  text?: string[]
  toolCalls?: { id: string; name: string; args: string }[]
  finish: string
  usage?: { prompt: number; completion: number }
  model?: string
}

/** Server-sent events of one OpenAI chat.completions streaming response. */
export function openAiStream(turn: FakeOpenAiTurn): Response {
  const chunk = (
    delta: unknown,
    finish: string | null = null,
    extra: Record<string, unknown> = {}
  ): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1,
      model: turn.model ?? 'test-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra
    })}\n\n`
  const out: string[] = [chunk({ role: 'assistant', content: '' })]
  for (const t of turn.text ?? []) out.push(chunk({ content: t }))
  ;(turn.toolCalls ?? []).forEach((tc, i) => {
    out.push(
      chunk({
        tool_calls: [
          { index: i, id: tc.id, type: 'function', function: { name: tc.name, arguments: '' } }
        ]
      })
    )
    // arguments split in two fragments, like real streams
    const half = Math.floor(tc.args.length / 2)
    out.push(chunk({ tool_calls: [{ index: i, function: { arguments: tc.args.slice(0, half) } }] }))
    out.push(chunk({ tool_calls: [{ index: i, function: { arguments: tc.args.slice(half) } }] }))
  })
  out.push(chunk({}, turn.finish))
  if (turn.usage)
    out.push(
      `data: ${JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: turn.model ?? 'test-model',
        choices: [],
        usage: {
          prompt_tokens: turn.usage.prompt,
          completion_tokens: turn.usage.completion,
          total_tokens: turn.usage.prompt + turn.usage.completion
        }
      })}\n\n`
    )
  out.push('data: [DONE]\n\n')
  return sseResponse(out)
}
