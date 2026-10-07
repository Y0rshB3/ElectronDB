/**
 * Bring-your-own-key AI assistant: types shared by main and renderer.
 *
 * Privacy rule (enforced in src/main/ai): only database STRUCTURE is sent to a
 * provider (schema/table/column names, types, keys, indexes, foreign keys,
 * view/routine signatures, row-count estimates), plus the user's own text and
 * SQL. Row values, query results, cell contents and connection hosts, users or
 * passwords are never sent. API keys stay in main (CredentialStore kind 'ai').
 */

/** Provider presets. 'anthropic' uses the official Anthropic SDK, every other one the OpenAI SDK. */
export type AiProviderType =
  'anthropic' | 'openai' | 'groq' | 'xai' | 'zhipu' | 'zai' | 'ollama' | 'custom'

export const AI_PROVIDER_TYPES: readonly AiProviderType[] = [
  'anthropic',
  'openai',
  'groq',
  'xai',
  'zhipu',
  'zai',
  'ollama',
  'custom'
] as const

export interface AiProviderPreset {
  type: AiProviderType
  label: string
  /** Fixed base URL ('' for Anthropic, which uses the SDK default, and for Personalizado). */
  baseUrl: string
  /** The user may change the base URL (Ollama on another port, Personalizado). */
  editableBaseUrl: boolean
  /** False for Ollama: no key needed. Personalizado: optional. */
  keyRequired: boolean
  /** Models offered in the picker (Anthropic only; the others load them or type one). */
  models: string[]
  defaultModel: string
  /** Placeholder for the model field (never a hard-coded default). */
  modelHint: string
}

/** Anthropic models offered in the picker (exact IDs; the user may type another one). */
export const ANTHROPIC_MODELS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-4-5',
  'claude-fable-5-1'
] as const

export const AI_PROVIDER_PRESETS: Record<AiProviderType, AiProviderPreset> = {
  anthropic: {
    type: 'anthropic',
    label: 'Anthropic Claude',
    baseUrl: '',
    editableBaseUrl: false,
    keyRequired: true,
    models: [...ANTHROPIC_MODELS],
    defaultModel: 'claude-opus-5-5',
    modelHint: 'claude-opus-5-5'
  },
  openai: {
    type: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    editableBaseUrl: false,
    keyRequired: true,
    models: [],
    defaultModel: '',
    modelHint: 'ID del modelo (pulsa «Cargar modelos»)'
  },
  groq: {
    type: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    editableBaseUrl: false,
    keyRequired: true,
    models: [],
    defaultModel: '',
    modelHint: 'ID del modelo (pulsa «Cargar modelos»)'
  },
  xai: {
    type: 'xai',
    label: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    editableBaseUrl: false,
    keyRequired: true,
    models: [],
    defaultModel: '',
    modelHint: 'ID del modelo (pulsa «Cargar modelos»)'
  },
  zhipu: {
    type: 'zhipu',
    label: 'Zhipu GLM (open.bigmodel.cn)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    editableBaseUrl: false,
    keyRequired: true,
    models: [],
    defaultModel: '',
    modelHint: 'ID del modelo GLM'
  },
  zai: {
    type: 'zai',
    label: 'Z.ai GLM (internacional)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    editableBaseUrl: false,
    keyRequired: true,
    models: [],
    defaultModel: '',
    modelHint: 'ID del modelo GLM'
  },
  ollama: {
    type: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    editableBaseUrl: true,
    keyRequired: false,
    models: [],
    defaultModel: '',
    modelHint: 'Modelo descargado en Ollama (pulsa «Cargar modelos»)'
  },
  custom: {
    type: 'custom',
    label: 'Personalizado (compatible con OpenAI)',
    baseUrl: '',
    editableBaseUrl: true,
    keyRequired: false,
    models: [],
    defaultModel: '',
    modelHint: 'ID del modelo'
  }
}

/** A configured provider ("perfil"). The key lives in CredentialStore, never here. */
export interface AiProviderProfile {
  id: string
  name: string
  type: AiProviderType
  /** Effective base URL ('' for Anthropic). */
  baseUrl: string
  model: string
  createdAt: string
  updatedAt: string
}

export type AiProviderInput = Omit<AiProviderProfile, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string
}

/** What the renderer sees: the profile and whether a key is stored (never the key). */
export interface AiProviderView extends AiProviderProfile {
  hasKey: boolean
}

export type AiEffort = 'low' | 'medium' | 'high'

/**
 * - chat: free question about the database
 * - generateSql: natural language -> SQL (inserted in the editor, never executed)
 * - explain: explain / optimise the editor SQL (EXPLAIN only for one SELECT)
 * - explainError: explain why a statement failed
 */
export type AiMode = 'chat' | 'generateSql' | 'explain' | 'explainError'

export interface AiMessage {
  role: 'user' | 'assistant'
  text: string
  createdAt?: string
  /** Assistant answers only. */
  usage?: AiUsage
  /** Assistant answers that stopped early (refusal, error, cancelled, max_tokens). */
  stopReason?: AiStopReason
}

export interface AiUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export type AiStopReason =
  'end_turn' | 'max_tokens' | 'refusal' | 'tool_limit' | 'cancelled' | 'error' | 'other'

/** Where the assistant looks: the connection and (optionally) the database. */
export interface AiTarget {
  connectionId: string
  schema: string | null
  /** PostgreSQL: database that holds `schema` (absent/null = the connection's initial one). */
  database?: string | null
}

export interface AiChatRequest extends AiTarget {
  /** Provider profile; null = the default one from Ajustes. */
  providerId: string | null
  mode: AiMode
  /** Earlier turns of the conversation (text only). */
  history: AiMessage[]
  /** The new question / instruction typed by the user ('' allowed for explain modes). */
  input: string
  /** explain / explainError: the SQL (selection or whole editor). */
  sql?: string | null
  /** explainError: the server's error message. */
  error?: string | null
  /** SQL currently in the editor (used to prioritise tables; sent for generateSql). */
  editorSql?: string | null
  /** Table of the open tab, prioritised in the schema context. */
  openTable?: string | null
}

export interface AiChatStart {
  requestId: string
}

export interface AiDeltaEvent {
  requestId: string
  text: string
}

/** Short progress note while the model asks for more structure ("Consultando estructura…"). */
export interface AiStatusEvent {
  requestId: string
  status: string
}

export interface AiDoneEvent {
  requestId: string
  stopReason: AiStopReason
  usage?: AiUsage
  /** Actionable Spanish message when stopReason is 'error' or 'refusal'. */
  error?: string
  /** Model that answered (after a server-side fallback it may differ). */
  model?: string
}

export interface AiConversationSummary {
  id: string
  connectionId: string
  title: string
  schema: string | null
  updatedAt: string
  messageCount: number
}

export interface AiConversation {
  id: string
  connectionId: string
  title: string
  schema: string | null
  createdAt: string
  updatedAt: string
  messages: AiMessage[]
}

export type AiConversationInput = Omit<AiConversation, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string
}

/** Exactly what would be sent as system prompt + context (for «Ver contexto enviado»). */
export interface AiContextPreview {
  instructions: string
  context: string
  /** Characters of instructions + context. */
  chars: number
  /** The schema did not fit: some tables are listed by name only. */
  truncated: boolean
  tableCount: number
}

export interface AiContextRequest extends AiTarget {
  input?: string | null
  editorSql?: string | null
  openTable?: string | null
}

export interface AiTestResult {
  ok: boolean
  message: string
}

/** Privacy line shown in the panel. */
export const AI_PRIVACY_LINE = 'Solo se envía la estructura de la base de datos, nunca tus datos.'
