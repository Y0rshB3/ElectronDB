import type { AiEffort, AiMessage, AiStopReason, AiTestResult, AiUsage } from '@shared/ai'
import type { ToolExecutor } from './tools'

/** Network function handed to the SDKs (Electron's net.fetch in the app, a fake in tests). */
export type FetchFn = typeof fetch

export interface AdapterRequest {
  model: string
  /** Frozen instructions (first system block). */
  instructions: string
  /** Schema + memory context (second system block, cached). */
  context: string
  /** Earlier turns (text only, already trimmed). */
  history: AiMessage[]
  /** The new user turn. */
  userMessage: string
  effort: AiEffort
  maxTokens: number
  signal: AbortSignal
  /** get_table_structure executor; null disables the tool. */
  tool: ToolExecutor | null
}

export interface AdapterCallbacks {
  onText(delta: string): void
  onStatus?(status: string): void
}

export interface AdapterResult {
  stopReason: AiStopReason
  usage?: AiUsage
  model?: string
  /** Spanish, actionable; set for 'error' and 'refusal'. */
  error?: string
}

export interface ChatAdapter {
  chat(request: AdapterRequest, callbacks: AdapterCallbacks): Promise<AdapterResult>
  /** Minimal request that proves the key / URL / model work. */
  test(model: string, signal?: AbortSignal): Promise<AiTestResult>
  /** Model IDs the provider reports. Throws a Spanish message when it cannot list them. */
  listModels(signal?: AbortSignal): Promise<string[]>
}

export function addUsage(a: AiUsage | undefined, b: Partial<AiUsage> | undefined): AiUsage {
  const base: AiUsage = a ?? { inputTokens: 0, outputTokens: 0 }
  if (!b) return base
  const out: AiUsage = {
    inputTokens: base.inputTokens + (b.inputTokens ?? 0),
    outputTokens: base.outputTokens + (b.outputTokens ?? 0)
  }
  if (base.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined)
    out.cacheReadTokens = (base.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0)
  if (base.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined)
    out.cacheWriteTokens = (base.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0)
  return out
}

/** Short status shown while the model fetches structure. */
export function toolStatus(tables: string[]): string {
  const shown = tables.slice(0, 4).join(', ')
  return `Consultando la estructura de ${shown}${tables.length > 4 ? ` y ${tables.length - 4} más` : ''}…`
}
