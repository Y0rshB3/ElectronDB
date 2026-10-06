import OpenAI from 'openai'
import { AI_PROVIDER_PRESETS, type AiProviderType, type AiTestResult } from '@shared/ai'
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
  parseToolArguments,
  validateToolInput,
  type ToolExecutor
} from './tools'

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool

/** Key sent to servers that need none (Ollama, keyless compatible servers). */
export const NO_KEY = 'no-key'

export interface OpenAiCompatOptions {
  type: AiProviderType
  baseUrl: string
  apiKey: string | null
  fetch?: FetchFn
  maxRetries?: number
}

function providerLabel(type: AiProviderType): string {
  return AI_PROVIDER_PRESETS[type]?.label ?? 'el proveedor'
}

/** Spanish message for an OpenAI SDK error (typed classes only). */
export function describeOpenAiError(
  err: unknown,
  type: AiProviderType,
  model: string
): AdapterResult {
  const who = providerLabel(type)
  if (err instanceof OpenAI.APIUserAbortError) return { stopReason: 'cancelled' }
  if (err instanceof OpenAI.AuthenticationError)
    return {
      stopReason: 'error',
      error: `Clave inválida: ${who} ha rechazado la clave API. Revísala en Ajustes › IA.`
    }
  if (err instanceof OpenAI.PermissionDeniedError)
    return {
      stopReason: 'error',
      error: `Tu clave no tiene permiso para usar ${model || 'este modelo'} en ${who}.`
    }
  if (err instanceof OpenAI.NotFoundError)
    return {
      stopReason: 'error',
      error: `${who} no encuentra el modelo «${model}» o la URL base no es correcta (404).`
    }
  if (err instanceof OpenAI.RateLimitError)
    return {
      stopReason: 'error',
      error: `${who} ha limitado las peticiones de tu clave (429). Espera un momento o revisa tu saldo.`
    }
  if (err instanceof OpenAI.BadRequestError || err instanceof OpenAI.UnprocessableEntityError)
    return {
      stopReason: 'error',
      error: `${who} ha rechazado la petición (${err.status}): ${err.message}`
    }
  if (err instanceof OpenAI.APIConnectionError)
    return {
      stopReason: 'error',
      error:
        type === 'ollama'
          ? 'No se pudo conectar con Ollama. Comprueba que está en marcha (ollama serve) y la URL base.'
          : `No se pudo conectar con ${who}. Revisa tu conexión a internet, el proxy o la URL base.`
    }
  if (err instanceof OpenAI.APIError)
    return { stopReason: 'error', error: `Error de ${who} (${err.status ?? '?'}): ${err.message}` }
  return {
    stopReason: 'error',
    error: `Error inesperado al hablar con ${who}: ${err instanceof Error ? err.message : String(err)}`
  }
}

const TOOL: ChatTool = {
  type: 'function',
  function: { name: TOOL_NAME, description: TOOL_DESCRIPTION, parameters: TOOL_INPUT_SCHEMA }
}

interface PendingCall {
  id: string
  name: string
  args: string
}

/** Request body of one round (exported for tests). */
export function buildChatBody(
  type: AiProviderType,
  req: AdapterRequest,
  messages: ChatMessage[],
  withTools: boolean
): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
  return {
    model: req.model,
    messages,
    stream: true,
    // OpenAI's newer models only take max_completion_tokens; the compatible APIs take max_tokens.
    ...(type === 'openai'
      ? { max_completion_tokens: req.maxTokens }
      : { max_tokens: req.maxTokens }),
    ...(type === 'openai' ? { stream_options: { include_usage: true } } : {}),
    ...(withTools ? { tools: [TOOL], tool_choice: 'auto' as const } : {})
  }
}

async function runTools(
  calls: PendingCall[],
  tool: ToolExecutor,
  callbacks: AdapterCallbacks
): Promise<ChatMessage[]> {
  const out: ChatMessage[] = []
  for (const call of calls) {
    let content: string
    if (call.name !== TOOL_NAME) content = `Error: unknown tool ${call.name}`
    else {
      const parsed = validateToolInput(parseToolArguments(call.args))
      if (!parsed.ok) content = `Error: invalid input: ${parsed.error}`
      else {
        callbacks.onStatus?.(toolStatus(parsed.value.tables))
        try {
          content = await tool(parsed.value)
        } catch (err) {
          content = `Error: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }
    out.push({ role: 'tool', tool_call_id: call.id, content })
  }
  return out
}

export class OpenAiCompatAdapter implements ChatAdapter {
  private readonly client: OpenAI
  constructor(private readonly options: OpenAiCompatOptions) {
    // Explicit options only: OPENAI_* environment variables never change the
    // key, the endpoint or the organisation, and request logging stays off.
    this.client = new OpenAI({
      apiKey: options.apiKey || NO_KEY,
      baseURL: options.baseUrl,
      organization: null,
      project: null,
      logLevel: 'off',
      maxRetries: options.maxRetries ?? 2,
      ...(options.fetch ? { fetch: options.fetch } : {})
    })
  }

  async chat(req: AdapterRequest, callbacks: AdapterCallbacks): Promise<AdapterResult> {
    const type = this.options.type
    const messages: ChatMessage[] = [
      // One system message: some compatible servers reject several.
      { role: 'system', content: `${req.instructions}\n\n${req.context}` },
      ...req.history.map((m) => ({ role: m.role, content: m.text }) as ChatMessage),
      { role: 'user', content: req.userMessage }
    ]
    let withTools = !!req.tool
    let retriedWithoutTools = false
    let usage: AdapterResult['usage']
    let model: string | undefined
    let wroteText = false

    for (let round = 0; ; round++) {
      let text = ''
      const calls: PendingCall[] = []
      let finish: string | null = null
      try {
        const stream = await this.client.chat.completions.create(
          buildChatBody(type, req, messages, withTools),
          { signal: req.signal }
        )
        let separated = !wroteText
        for await (const chunk of stream) {
          if (chunk.model) model = chunk.model
          if (chunk.usage)
            usage = addUsage(usage, {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
              ...(chunk.usage.prompt_tokens_details?.cached_tokens !== undefined
                ? { cacheReadTokens: chunk.usage.prompt_tokens_details.cached_tokens ?? 0 }
                : {})
            })
          const choice = chunk.choices?.[0]
          if (!choice) continue
          const delta = choice.delta
          if (delta?.content) {
            if (!separated) {
              callbacks.onText('\n\n')
              separated = true
            }
            wroteText = true
            text += delta.content
            callbacks.onText(delta.content)
          }
          for (const tc of delta?.tool_calls ?? []) {
            const slot = (calls[tc.index ?? 0] ??= { id: '', name: '', args: '' })
            if (tc.id) slot.id = tc.id
            if (tc.function?.name && !slot.name) slot.name = tc.function.name
            if (tc.function?.arguments) slot.args += tc.function.arguments
          }
          if (choice.finish_reason) finish = choice.finish_reason
        }
      } catch (err) {
        // Some compatible servers reject `tools`: retry once without them.
        if (
          withTools &&
          !retriedWithoutTools &&
          round === 0 &&
          !wroteText &&
          (err instanceof OpenAI.BadRequestError || err instanceof OpenAI.UnprocessableEntityError)
        ) {
          withTools = false
          retriedWithoutTools = true
          round = -1
          continue
        }
        return { ...describeOpenAiError(err, type, req.model), usage, model }
      }

      const pending = calls.filter((c) => c && c.name)
      if (finish === 'content_filter')
        return {
          stopReason: 'refusal',
          usage,
          model,
          error: `${providerLabel(type)} ha bloqueado la respuesta (filtro de contenido). Reformula la pregunta.`
        }
      if (finish === 'length') return { stopReason: 'max_tokens', usage, model }
      if (!pending.length || !req.tool || !withTools)
        return {
          stopReason: finish === 'stop' || finish === null ? 'end_turn' : 'other',
          usage,
          model
        }
      if (round + 1 >= MAX_TOOL_ROUNDS) return { stopReason: 'tool_limit', usage, model }
      pending.forEach((c, i) => {
        if (!c.id) c.id = `call_${round}_${i}`
      })
      messages.push({
        role: 'assistant',
        content: text || null,
        tool_calls: pending.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.args || '{}' }
        }))
      })
      messages.push(...(await runTools(pending, req.tool, callbacks)))
    }
  }

  async test(model: string, signal?: AbortSignal): Promise<AiTestResult> {
    try {
      const stream = await this.client.chat.completions.create(
        { model, messages: [{ role: 'user', content: 'ping' }], stream: true },
        { signal }
      )
      for await (const chunk of stream) {
        if (chunk.choices?.[0]?.delta?.content) break
      }
      return { ok: true, message: `Conexión correcta: ${model} responde.` }
    } catch (err) {
      return {
        ok: false,
        message: describeOpenAiError(err, this.options.type, model).error ?? 'Prueba cancelada.'
      }
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    try {
      const ids: string[] = []
      for await (const m of this.client.models.list({ signal })) ids.push(m.id)
      return [...new Set(ids)].sort()
    } catch (err) {
      if (err instanceof OpenAI.NotFoundError)
        throw new Error(
          `${providerLabel(this.options.type)} no permite listar modelos: escribe el ID del modelo a mano.`
        )
      throw new Error(
        describeOpenAiError(err, this.options.type, '').error ?? 'Operación cancelada.'
      )
    }
  }
}
