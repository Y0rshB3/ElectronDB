import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages'
import type { AiTestResult } from '@shared/ai'
import {
  addUsage,
  toolStatus,
  type AdapterCallbacks,
  type AdapterRequest,
  type AdapterResult,
  type ChatAdapter,
  type FetchFn
} from './adapter'
import {
  MAX_TOOL_ROUNDS,
  TOOL_DESCRIPTION,
  TOOL_INPUT_SCHEMA,
  TOOL_NAME,
  validateToolInput,
  type ToolExecutor
} from './tools'

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/** Models where server-side refusal fallbacks (`fallbacks: "default"`) are enabled. */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5'])

/**
 * Models whose thinking is always adaptive (Opus 5.5, Sonnet 5.5, Fable 5.1 and
 * their families). `disabled` / `budget_tokens` would be a 400 there. Other
 * models (Haiku 4.5, older or unknown IDs) get no `thinking` and no `effort`.
 */
export function usesAdaptiveThinking(model: string): boolean {
  return /^claude-(opus|sonnet|fable|mythos)-5(-|$)/.test(model)
}

export function usesFallbacks(model: string): boolean {
  return FALLBACK_MODELS.has(model)
}

const TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  input_schema: TOOL_INPUT_SCHEMA,
  strict: true
}

/** Request body of one round (exported for tests). */
export function buildParams(
  req: AdapterRequest,
  messages: Anthropic.MessageParam[]
): Anthropic.MessageStreamParams {
  const adaptive = usesAdaptiveThinking(req.model)
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    // Frozen instructions, then the schema + memory block marked for caching.
    // Both are byte-stable; the question and SQL go in `messages`.
    system: [
      { type: 'text', text: req.instructions },
      { type: 'text', text: req.context, cache_control: { type: 'ephemeral' } }
    ],
    messages,
    ...(adaptive
      ? { thinking: { type: 'adaptive' as const }, output_config: { effort: req.effort } }
      : {}),
    ...(req.tool ? { tools: [TOOL], tool_choice: { type: 'auto' as const } } : {})
  }
}

/** Same request on the beta endpoint, with server-side refusal fallbacks (exported for tests). */
export function buildBetaParams(
  req: AdapterRequest,
  messages: Anthropic.Beta.BetaMessageParam[]
): BetaMessageStreamParams {
  const adaptive = usesAdaptiveThinking(req.model)
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    system: [
      { type: 'text', text: req.instructions },
      { type: 'text', text: req.context, cache_control: { type: 'ephemeral' } }
    ],
    messages,
    ...(adaptive
      ? { thinking: { type: 'adaptive' as const }, output_config: { effort: req.effort } }
      : {}),
    ...(req.tool ? { tools: [TOOL], tool_choice: { type: 'auto' as const } } : {}),
    betas: [FALLBACK_BETA],
    fallbacks: 'default'
  }
}

/** Spanish message for an SDK error (typed classes, never string matching). */
export function describeAnthropicError(err: unknown, model: string): AdapterResult {
  if (err instanceof Anthropic.APIUserAbortError) return { stopReason: 'cancelled' }
  if (err instanceof Anthropic.AuthenticationError)
    return {
      stopReason: 'error',
      error: 'Clave inválida: Anthropic ha rechazado la clave API. Revísala en Ajustes › IA.'
    }
  if (err instanceof Anthropic.PermissionDeniedError)
    return {
      stopReason: 'error',
      error: `Tu clave no tiene permiso para usar ${model}. Revisa tu cuenta de Anthropic o elige otro modelo.`
    }
  if (err instanceof Anthropic.NotFoundError)
    return {
      stopReason: 'error',
      error: `El modelo «${model}» no existe o no está disponible para tu cuenta. Elige otro en Ajustes › IA.`
    }
  if (err instanceof Anthropic.RateLimitError)
    return {
      stopReason: 'error',
      error:
        'Anthropic ha limitado las peticiones de tu clave (429). Espera un momento y vuelve a intentarlo.'
    }
  if (err instanceof Anthropic.BadRequestError)
    return {
      stopReason: 'error',
      error: `Anthropic ha rechazado la petición (400): ${err.message}`
    }
  if (err instanceof Anthropic.APIConnectionError)
    return {
      stopReason: 'error',
      error: 'No se pudo conectar con Anthropic. Revisa tu conexión a internet o el proxy.'
    }
  if (err instanceof Anthropic.APIError) {
    if (err.status === 529)
      return {
        stopReason: 'error',
        error:
          'Anthropic está sobrecargado en este momento (529). Vuelve a intentarlo en unos minutos.'
      }
    return {
      stopReason: 'error',
      error: `Error de Anthropic (${err.status ?? '?'}): ${err.message}`
    }
  }
  return {
    stopReason: 'error',
    error: `Error inesperado al hablar con Anthropic: ${err instanceof Error ? err.message : String(err)}`
  }
}

function refusalMessage(category: string | null | undefined): string {
  return (
    'Claude ha rechazado responder a esta petición' +
    (category ? ` (categoría: ${category})` : '') +
    '. Reformula la pregunta o prueba con otro modelo.'
  )
}

async function runTools(
  blocks: (Anthropic.ToolUseBlock | Anthropic.Beta.BetaToolUseBlock)[],
  tool: ToolExecutor,
  callbacks: AdapterCallbacks
): Promise<Anthropic.ToolResultBlockParam[]> {
  const results: Anthropic.ToolResultBlockParam[] = []
  for (const block of blocks) {
    if (block.name !== TOOL_NAME) {
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Unknown tool ${block.name}`,
        is_error: true
      })
      continue
    }
    const parsed = validateToolInput(block.input)
    if (!parsed.ok) {
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Invalid input: ${parsed.error}`,
        is_error: true
      })
      continue
    }
    callbacks.onStatus?.(toolStatus(parsed.value.tables))
    try {
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: await tool(parsed.value)
      })
    } catch (err) {
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        is_error: true
      })
    }
  }
  return results
}

export interface AnthropicAdapterOptions {
  apiKey: string
  fetch?: FetchFn
  maxRetries?: number
}

export function createAnthropicClient(options: AnthropicAdapterOptions): Anthropic {
  // Everything explicit: no ANTHROPIC_* environment variable may change the
  // key, the endpoint or turn on request logging.
  return new Anthropic({
    apiKey: options.apiKey,
    authToken: null,
    baseURL: ANTHROPIC_BASE_URL,
    logLevel: 'off',
    maxRetries: options.maxRetries ?? 2,
    ...(options.fetch ? { fetch: options.fetch } : {})
  })
}

export class AnthropicAdapter implements ChatAdapter {
  private readonly client: Anthropic
  constructor(options: AnthropicAdapterOptions) {
    this.client = createAnthropicClient(options)
  }

  /**
   * One streamed round. Claude Opus 5.5 / Sonnet 5.5 / Fable 5.1 go through
   * the beta endpoint with server-side refusal fallbacks (on a policy decline
   * the API re-runs the request on Anthropic's recommended model for that
   * category); every other model uses `client.messages.stream`.
   */
  private async round(
    req: AdapterRequest,
    messages: Anthropic.Beta.BetaMessageParam[],
    onText: (delta: string) => void
  ): Promise<Anthropic.Message | Anthropic.Beta.BetaMessage> {
    if (usesFallbacks(req.model)) {
      const stream = this.client.beta.messages.stream(buildBetaParams(req, messages), {
        signal: req.signal
      })
      stream.on('text', onText)
      return stream.finalMessage()
    }
    // Only plain (non-beta) content is ever appended on this path.
    const stream = this.client.messages.stream(
      buildParams(req, messages as Anthropic.MessageParam[]),
      { signal: req.signal }
    )
    stream.on('text', onText)
    return stream.finalMessage()
  }

  async chat(req: AdapterRequest, callbacks: AdapterCallbacks): Promise<AdapterResult> {
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      ...req.history.map((m) => ({ role: m.role, content: m.text })),
      { role: 'user', content: req.userMessage }
    ]
    let usage: AdapterResult['usage']
    let model: string | undefined
    let wroteText = false
    try {
      for (let round = 0; ; round++) {
        let separated = !wroteText
        const message = await this.round(req, messages, (delta) => {
          if (!delta) return
          if (!separated) {
            callbacks.onText('\n\n')
            separated = true
          }
          wroteText = true
          callbacks.onText(delta)
        })
        model = message.model
        usage = addUsage(usage, {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0
        })
        // Stop reason first: a refusal can cut a tool_use off mid-input.
        if (message.stop_reason === 'refusal')
          return {
            stopReason: 'refusal',
            usage,
            model,
            error: refusalMessage(message.stop_details?.category)
          }
        if (message.stop_reason === 'max_tokens') return { stopReason: 'max_tokens', usage, model }
        const blocks: (Anthropic.ContentBlock | Anthropic.Beta.BetaContentBlock)[] = [
          ...message.content
        ]
        const toolUses = blocks.filter(
          (b): b is Anthropic.ToolUseBlock | Anthropic.Beta.BetaToolUseBlock =>
            b.type === 'tool_use'
        )
        if (message.stop_reason !== 'tool_use' || !toolUses.length || !req.tool)
          return {
            stopReason:
              message.stop_reason === 'end_turn' || message.stop_reason === 'stop_sequence'
                ? 'end_turn'
                : 'other',
            usage,
            model
          }
        if (round + 1 >= MAX_TOOL_ROUNDS) return { stopReason: 'tool_limit', usage, model }
        // Append-only: the assistant turn unchanged (thinking blocks included),
        // then every tool_result of this turn in a single user message.
        messages.push({ role: 'assistant', content: message.content })
        messages.push({ role: 'user', content: await runTools(toolUses, req.tool, callbacks) })
      }
    } catch (err) {
      return { ...describeAnthropicError(err, req.model), usage, model }
    }
  }

  async test(model: string, signal?: AbortSignal): Promise<AiTestResult> {
    try {
      // Validates the key and the model without generating tokens.
      const info = await this.client.models.retrieve(model, {}, { signal })
      return { ok: true, message: `Conexión correcta: ${info.display_name || info.id} disponible.` }
    } catch (err) {
      const r = describeAnthropicError(err, model)
      return { ok: false, message: r.error ?? 'Prueba cancelada.' }
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    try {
      const ids: string[] = []
      for await (const m of this.client.models.list({ limit: 100 }, { signal })) ids.push(m.id)
      return ids.sort()
    } catch (err) {
      throw new Error(describeAnthropicError(err, '').error ?? 'Operación cancelada.')
    }
  }
}
