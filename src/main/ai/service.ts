import {
  AI_PROVIDER_PRESETS,
  type AiChatRequest,
  type AiChatStart,
  type AiContextPreview,
  type AiContextRequest,
  type AiDoneEvent,
  type AiMode,
  type AiProviderInput,
  type AiProviderProfile,
  type AiProviderView,
  type AiTestResult
} from '@shared/ai'
import type { AppSettings, Environment } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { CredentialStore } from '../credentials/store'
import { newId } from '../storage/ids'
import type { ChatAdapter, FetchFn } from './adapter'
import { AnthropicAdapter } from './anthropic'
import { buildMemoryBlock, buildSchemaContext, formatTable } from './context'
import { explainSelect, isSingleSelect } from './explain'
import {
  PgMetadataQueryable,
  explainPgSelect,
  isSinglePgSelect,
  readPgSchemaNames,
  readPgSchemaSnapshot
} from './pgMetadata'
import {
  SqliteMetadataQueryable,
  explainSqliteSelect,
  isSingleSqliteSelect,
  readSqliteDatabaseNames,
  readSqliteSchemaSnapshot
} from './sqliteMetadata'
import {
  MetadataQueryable,
  readSchemaSnapshot,
  type Queryable,
  type SchemaSnapshot
} from './metadata'
import { OpenAiCompatAdapter } from './openaiCompat'
import { buildUserMessage, SYSTEM_INSTRUCTIONS, trimHistory } from './prompts'
import { AiProvidersRepo, normalizeProviderInput } from './providers'
import { AiConversationsRepo, AiMemoryRepo } from './store'
import type { TableStructureInput, ToolExecutor } from './tools'

/** A database session borrowed for one operation. */
export interface BorrowedSession extends Queryable {
  release(): Promise<void>
}

export interface AiLogger {
  info(message: string): void
  warn(message: string): void
}

export interface AiServiceDeps {
  userDataPath: string
  credentials: CredentialStore
  settings: { get(): AppSettings }
  /** Environment of a connection (shown to the model so it is careful with production). */
  environmentOf(connectionId: string): Environment | null
  acquire(connectionId: string, schema: string | null): Promise<BorrowedSession>
  /** True for PostgreSQL connections (structure comes from pg_catalog, see pgMetadata.ts). */
  isPostgres?(connectionId: string): boolean
  /** A pooled PostgreSQL session of `database` (null = the initial database). */
  acquirePg?(connectionId: string, database: string | null): Promise<BorrowedSession>
  /** True for SQLite connections (structure comes from sqlite_schema, see sqliteMetadata.ts). */
  isSqlite?(connectionId: string): boolean
  /** A session on the SQLite connection's shared handle. */
  acquireSqlite?(connectionId: string): Promise<BorrowedSession>
  emit<E extends IpcEventChannel>(channel: E, payload: IpcEventMap[E]): void
  log: AiLogger
  fetch?: FetchFn
  /** Replaces the real adapters (tests, VORTAQ_AI_FIXTURE). */
  adapterFactory?: (profile: AiProviderProfile, key: string | null) => ChatAdapter
  /** Snapshot cache lifetime (ms). */
  snapshotTtlMs?: number
  /** SDK retries on 429/5xx/connection errors. */
  maxRetries?: number
}

const ENV_LABEL: Record<Environment, string> = {
  local: 'Local',
  staging: 'Staging',
  production: 'Producción',
  other: 'Otro'
}

const MODES: readonly AiMode[] = ['chat', 'generateSql', 'explain', 'explainError']
const MAX_INPUT_CHARS = 20_000
const MAX_SQL_CHARS = 100_000

function requireString(value: unknown, what: string, max = 200): string {
  if (typeof value !== 'string' || !value || value.length > max)
    throw new Error(`${what} no válido.`)
  return value
}

function optionalText(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return null
  return value.slice(0, max)
}

export class AiService {
  readonly providers: AiProvidersRepo
  readonly conversations: AiConversationsRepo
  readonly memory: AiMemoryRepo
  private readonly active = new Map<string, AbortController>()
  private readonly snapshots = new Map<string, { at: number; snap: SchemaSnapshot }>()

  constructor(private readonly deps: AiServiceDeps) {
    this.providers = new AiProvidersRepo(deps.userDataPath)
    this.conversations = new AiConversationsRepo(deps.userDataPath)
    this.memory = new AiMemoryRepo(deps.userDataPath)
  }

  /* ---------- providers & keys (keys never leave main) ---------- */

  listProviders(): AiProviderView[] {
    return this.providers
      .list()
      .map((p) => ({ ...p, hasKey: this.deps.credentials.has('ai', p.id) }))
  }

  saveProvider(input: AiProviderInput): AiProviderView {
    const saved = this.providers.save(input)
    return { ...saved, hasKey: this.deps.credentials.has('ai', saved.id) }
  }

  deleteProvider(id: string): void {
    requireString(id, 'Proveedor')
    this.providers.delete(id)
    this.deps.credentials.set('ai', id, null)
  }

  setKey(id: string, key: string | null): void {
    requireString(id, 'Proveedor')
    if (!this.providers.get(id)) throw new Error('El proveedor no existe.')
    const value = typeof key === 'string' ? key.trim() : ''
    if (value.length > 1000) throw new Error('La clave es demasiado larga.')
    this.deps.credentials.set('ai', id, value || null)
  }

  hasKey(id: string): boolean {
    return this.deps.credentials.has('ai', id)
  }

  private adapterFor(profile: AiProviderProfile, key: string | null): ChatAdapter {
    if (this.deps.adapterFactory) return this.deps.adapterFactory(profile, key)
    if (profile.type === 'anthropic')
      return new AnthropicAdapter({
        apiKey: key ?? '',
        fetch: this.deps.fetch,
        maxRetries: this.deps.maxRetries
      })
    return new OpenAiCompatAdapter({
      type: profile.type,
      baseUrl: profile.baseUrl,
      apiKey: key,
      fetch: this.deps.fetch,
      maxRetries: this.deps.maxRetries
    })
  }

  /** Profile + key for test / listModels: the unsaved form, with the typed key or the stored one. */
  private draft(
    input: AiProviderInput,
    key: string | null
  ): { profile: AiProviderProfile; key: string | null } {
    const clean = normalizeProviderInput(input)
    const stored = clean.id ? this.deps.credentials.get('ai', clean.id) : null
    const typed = typeof key === 'string' && key.trim() ? key.trim() : null
    const profile: AiProviderProfile = {
      id: clean.id ?? 'draft',
      name: clean.name,
      type: clean.type,
      baseUrl: clean.baseUrl,
      model: clean.model,
      createdAt: '',
      updatedAt: ''
    }
    return { profile, key: typed ?? stored }
  }

  async testProvider(input: AiProviderInput, key: string | null): Promise<AiTestResult> {
    const { profile, key: secret } = this.draft(input, key)
    if (AI_PROVIDER_PRESETS[profile.type].keyRequired && !secret && !this.deps.adapterFactory)
      return { ok: false, message: 'Escribe la clave API antes de probar.' }
    const result = await this.adapterFor(profile, secret).test(profile.model)
    this.deps.log.info(`ai: provider test (${profile.type}) ${result.ok ? 'ok' : 'failed'}`)
    return result
  }

  async listModels(input: AiProviderInput, key: string | null): Promise<string[]> {
    const { profile, key: secret } = this.draft({ ...input, model: input.model || 'list' }, key)
    if (AI_PROVIDER_PRESETS[profile.type].keyRequired && !secret && !this.deps.adapterFactory)
      throw new Error('Escribe la clave API para cargar los modelos.')
    return this.adapterFor(profile, secret).listModels()
  }

  /* ---------- context ---------- */

  private isPg(connectionId: string): boolean {
    return this.deps.isPostgres?.(connectionId) === true && !!this.deps.acquirePg
  }

  private isLite(connectionId: string): boolean {
    return this.deps.isSqlite?.(connectionId) === true && !!this.deps.acquireSqlite
  }

  /** SQLite: the same structure-only rule over sqlite_schema (SqliteMetadataQueryable). */
  private async withSqliteMetadata<T>(
    connectionId: string,
    fn: (q: SqliteMetadataQueryable) => Promise<T>
  ): Promise<T> {
    const session = await this.deps.acquireSqlite!(connectionId)
    try {
      return await fn(new SqliteMetadataQueryable(session))
    } finally {
      await session.release().catch(() => undefined)
    }
  }

  /** PostgreSQL: the same structure-only rule over pg_catalog (PgMetadataQueryable). */
  private async withPgMetadata<T>(
    connectionId: string,
    database: string | null,
    fn: (q: PgMetadataQueryable) => Promise<T>
  ): Promise<T> {
    const session = await this.deps.acquirePg!(connectionId, database)
    try {
      return await fn(new PgMetadataQueryable(session))
    } finally {
      await session.release().catch(() => undefined)
    }
  }

  private async withMetadata<T>(
    connectionId: string,
    fn: (q: MetadataQueryable) => Promise<T>
  ): Promise<T> {
    const session = await this.deps.acquire(connectionId, null)
    try {
      // Structure only: the wrapper refuses anything but information_schema.
      return await fn(new MetadataQueryable(session))
    } finally {
      await session.release().catch(() => undefined)
    }
  }

  private async snapshot(
    connectionId: string,
    schema: string,
    fresh = false,
    database: string | null = null
  ): Promise<SchemaSnapshot> {
    const key = `${connectionId}\u0000${database ?? ''}\u0000${schema}`
    const ttl = this.deps.snapshotTtlMs ?? 5 * 60_000
    const hit = this.snapshots.get(key)
    if (!fresh && hit && Date.now() - hit.at < ttl) return hit.snap
    const snap = this.isPg(connectionId)
      ? await this.withPgMetadata(connectionId, database, (q) => readPgSchemaSnapshot(q, schema))
      : this.isLite(connectionId)
        ? await this.withSqliteMetadata(connectionId, (q) => readSqliteSchemaSnapshot(q, schema))
        : await this.withMetadata(connectionId, (q) => readSchemaSnapshot(q, schema))
    this.snapshots.set(key, { at: Date.now(), snap })
    return snap
  }

  /** Instructions + context text of a request. Deterministic for the same structure and notes. */
  async buildContext(
    request: AiContextRequest,
    options: { fresh?: boolean } = {}
  ): Promise<AiContextPreview> {
    const connectionId = requireString(request.connectionId, 'Conexión')
    const schema = typeof request.schema === 'string' && request.schema ? request.schema : null
    const database =
      typeof request.database === 'string' && request.database ? request.database : null
    const env = this.deps.environmentOf(connectionId)
    const parts: string[] = []
    if (env) parts.push(`Entorno de la conexión: ${ENV_LABEL[env]}.`)
    const memory = buildMemoryBlock(
      this.memory.get(connectionId, null),
      schema ? this.memory.get(connectionId, schema) : '',
      schema
    )
    if (memory) parts.push(memory)
    let truncated = false
    let tableCount = 0
    if (schema) {
      const snap = await this.snapshot(connectionId, schema, options.fresh, database)
      const built = buildSchemaContext(snap, {
        hints: [request.input, request.editorSql],
        openTable: request.openTable
      })
      truncated = built.truncated
      tableCount = built.tableCount
      parts.push(built.text)
    } else {
      if (this.isLite(connectionId)) {
        const names = await this.withSqliteMetadata(connectionId, (q) => readSqliteDatabaseNames(q))
        parts.push(
          `No hay ninguna base de datos seleccionada (SQLite). Bases de datos adjuntas: ${names.join(', ') || '(ninguna)'}.`
        )
      } else if (this.isPg(connectionId)) {
        const names = await this.withPgMetadata(connectionId, database, (q) => readPgSchemaNames(q))
        parts.push(
          `No hay ningún esquema seleccionado (PostgreSQL${database ? `, base de datos ${database}` : ''}). Esquemas: ${names.join(', ') || '(ninguno)'}.`
        )
      } else {
        const names = await this.withMetadata(connectionId, async (q) =>
          (
            await q.query<{ name: string }>(
              'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME'
            )
          ).map((r) => String(r.name))
        )
        parts.push(
          `No hay ninguna base de datos seleccionada. Bases de datos de la conexión: ${names.join(', ') || '(ninguna)'}.`
        )
      }
    }
    const context = parts.join('\n\n')
    return {
      instructions: SYSTEM_INSTRUCTIONS,
      context,
      chars: SYSTEM_INSTRUCTIONS.length + context.length,
      truncated,
      tableCount
    }
  }

  /** get_table_structure: structure of the requested tables, read on demand (never rows). */
  private toolFor(connectionId: string, database: string | null = null): ToolExecutor {
    return async (input: TableStructureInput) => {
      const snap = this.isPg(connectionId)
        ? await this.withPgMetadata(connectionId, database, (q) =>
            readPgSchemaSnapshot(q, input.schema, input.tables)
          )
        : this.isLite(connectionId)
          ? await this.withSqliteMetadata(connectionId, (q) =>
              readSqliteSchemaSnapshot(q, input.schema, input.tables)
            )
          : await this.withMetadata(connectionId, (q) =>
              readSchemaSnapshot(q, input.schema, input.tables)
            )
      const found = new Set(snap.tables.map((t) => t.name))
      const lines = snap.tables.map((t) => formatTable(t, input.schema))
      const missing = input.tables.filter((t) => !found.has(t))
      if (missing.length) lines.push(`No existen en ${input.schema}: ${missing.join(', ')}`)
      return lines.join('\n') || `No se encontraron tablas en ${input.schema}.`
    }
  }

  /* ---------- chat ---------- */

  private resolveProvider(providerId: string | null): AiProviderProfile {
    const settings = this.deps.settings.get()
    if (!settings.aiEnabled)
      throw new Error('El asistente de IA está desactivado. Actívalo en Ajustes › IA.')
    const list = this.providers.list()
    const wanted = providerId ?? settings.aiDefaultProviderId
    const profile = (wanted ? list.find((p) => p.id === wanted) : null) ?? list[0]
    if (!profile) throw new Error('Configura un proveedor de IA en Ajustes › IA.')
    return profile
  }

  private validate(raw: AiChatRequest): AiChatRequest {
    if (!raw || typeof raw !== 'object') throw new Error('Petición de IA no válida.')
    if (!MODES.includes(raw.mode)) throw new Error('Modo de IA no válido.')
    const input = typeof raw.input === 'string' ? raw.input : ''
    if (input.length > MAX_INPUT_CHARS)
      throw new Error(`La pregunta es demasiado larga (máx. ${MAX_INPUT_CHARS} caracteres).`)
    const sql = optionalText(raw.sql, MAX_SQL_CHARS + 1)
    if (sql && sql.length > MAX_SQL_CHARS)
      throw new Error('El SQL es demasiado largo para enviarlo al asistente.')
    if (raw.mode === 'chat' || raw.mode === 'generateSql') {
      if (!input.trim()) throw new Error('Escribe una pregunta.')
    } else if (!sql?.trim()) throw new Error('No hay SQL que explicar.')
    return {
      providerId: typeof raw.providerId === 'string' && raw.providerId ? raw.providerId : null,
      connectionId: requireString(raw.connectionId, 'Conexión'),
      schema: typeof raw.schema === 'string' && raw.schema ? raw.schema : null,
      database: typeof raw.database === 'string' && raw.database ? raw.database : null,
      mode: raw.mode,
      history: Array.isArray(raw.history) ? raw.history : [],
      input,
      sql,
      error: optionalText(raw.error, 10_000),
      editorSql: optionalText(raw.editorSql, MAX_SQL_CHARS),
      openTable: optionalText(raw.openTable, 64)
    }
  }

  /** Starts a streamed answer. Validation problems throw; later failures arrive as event:aiDone. */
  startChat(raw: AiChatRequest): AiChatStart {
    const request = this.validate(raw)
    const profile = this.resolveProvider(request.providerId)
    const key = this.deps.credentials.get('ai', profile.id)
    if (AI_PROVIDER_PRESETS[profile.type].keyRequired && !key && !this.deps.adapterFactory)
      throw new Error(`Falta la clave API de «${profile.name}». Añádela en Ajustes › IA.`)
    const requestId = newId()
    const controller = new AbortController()
    this.active.set(requestId, controller)
    // Starts after the IPC reply so the renderer knows the id before the first event.
    setTimeout(() => {
      void this.run(requestId, request, profile, key, controller).finally(() =>
        this.active.delete(requestId)
      )
    }, 0)
    return { requestId }
  }

  cancel(requestId: string): void {
    this.active.get(requestId)?.abort()
  }

  /** Aborts every running request (app quit). */
  cancelAll(): void {
    for (const c of this.active.values()) c.abort()
  }

  private done(event: AiDoneEvent): void {
    this.deps.emit('event:aiDone', event)
  }

  private async run(
    requestId: string,
    request: AiChatRequest,
    profile: AiProviderProfile,
    key: string | null,
    controller: AbortController
  ): Promise<void> {
    const { log } = this.deps
    const settings = this.deps.settings.get()
    log.info(`ai: request ${requestId} (${profile.type}, ${profile.model}, ${request.mode})`)
    try {
      this.deps.emit('event:aiStatus', { requestId, status: 'Leyendo la estructura…' })
      const preview = await this.buildContext({
        connectionId: request.connectionId,
        schema: request.schema,
        database: request.database ?? null,
        input: request.input,
        editorSql: request.mode === 'chat' ? request.editorSql : (request.sql ?? request.editorSql),
        openTable: request.openTable
      })
      let plan: string | null = null
      if (this.isPg(request.connectionId)) {
        if (request.mode === 'explain' && isSinglePgSelect(request.sql)) {
          // EXPLAIN (plan only, never ANALYZE) of one read-only SELECT; nothing else is executed.
          this.deps.emit('event:aiStatus', { requestId, status: 'Obteniendo el plan (EXPLAIN)…' })
          const session = await this.deps.acquirePg!(request.connectionId, request.database ?? null)
          try {
            if (request.schema)
              await session.query('SELECT pg_catalog.set_config($1, $2, false)', [
                'search_path',
                `"${request.schema.replace(/"/g, '""')}", public`
              ])
            plan = await explainPgSelect(session, request.sql ?? '')
          } finally {
            await session.release().catch(() => undefined)
          }
        }
      } else if (this.isLite(request.connectionId)) {
        if (request.mode === 'explain' && isSingleSqliteSelect(request.sql)) {
          // EXPLAIN QUERY PLAN (never plain EXPLAIN) of one read-only SELECT; nothing else runs.
          this.deps.emit('event:aiStatus', {
            requestId,
            status: 'Obteniendo el plan (EXPLAIN QUERY PLAN)…'
          })
          const session = await this.deps.acquireSqlite!(request.connectionId)
          try {
            plan = await explainSqliteSelect(session, request.sql ?? '')
          } finally {
            await session.release().catch(() => undefined)
          }
        }
      } else if (request.mode === 'explain' && isSingleSelect(request.sql)) {
        // EXPLAIN only for one SELECT (explainSelect checks it); nothing else is executed.
        this.deps.emit('event:aiStatus', { requestId, status: 'Obteniendo el plan (EXPLAIN)…' })
        const session = await this.deps.acquire(request.connectionId, request.schema)
        try {
          plan = await explainSelect(session, request.sql ?? '')
        } finally {
          await session.release().catch(() => undefined)
        }
      }
      if (controller.signal.aborted) {
        this.done({ requestId, stopReason: 'cancelled' })
        return
      }
      this.deps.emit('event:aiStatus', { requestId, status: '' })
      const adapter = this.adapterFor(profile, key)
      const result = await adapter.chat(
        {
          model: profile.model,
          instructions: preview.instructions,
          context: preview.context,
          history: trimHistory(request.history),
          userMessage: buildUserMessage(request, plan),
          effort: settings.aiEffort,
          maxTokens: settings.aiMaxTokens,
          signal: controller.signal,
          tool: this.toolFor(request.connectionId, request.database ?? null)
        },
        {
          onText: (text) => this.deps.emit('event:aiDelta', { requestId, text }),
          onStatus: (status) => this.deps.emit('event:aiStatus', { requestId, status })
        }
      )
      if (result.stopReason === 'error') log.warn(`ai: request ${requestId} failed`)
      this.done({
        requestId,
        stopReason: result.stopReason,
        usage: result.usage,
        error: result.error,
        model: result.model
      })
    } catch (err) {
      log.warn(`ai: request ${requestId} could not start`)
      this.done({
        requestId,
        stopReason: controller.signal.aborted ? 'cancelled' : 'error',
        error: controller.signal.aborted
          ? undefined
          : `No se pudo preparar la petición: ${err instanceof Error ? err.message : String(err)}`
      })
    }
  }
}
