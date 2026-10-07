import type { IpcArgs, IpcChannel, IpcEventChannel, IpcEventMap, IpcResult } from '@shared/ipc'
import type {
  BackupCreateOptions,
  ConnectionInput,
  JobInput,
  NavicatImportRequest,
  ObjectType,
  QueryExecuteOptions,
  RestoreOptions,
  RollbackFilesSource,
  RollbackRequest,
  RowChange,
  TableDataRequest,
  TableFilter,
  WriteOptions
} from '@shared/types'
import type {
  AiChatRequest,
  AiContextRequest,
  AiConversationInput,
  AiProviderInput
} from '@shared/ai'
import { errorMessage, useNotify } from './composables/useNotify'
import { toPlain } from './utils/toPlain'

export class ApiError extends Error {
  channel: string
  /** True once the error has been shown to the user (see `invoke`). */
  notified = false
  constructor(channel: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.channel = channel
  }
}

function bridge() {
  if (!window.electronDB) throw new Error('El puente IPC no está disponible (window.electronDB)')
  return window.electronDB
}

/** Invoke without reporting errors to the global snackbar. */
export async function invokeSilent<C extends IpcChannel>(
  channel: C,
  ...args: IpcArgs<C>
): Promise<IpcResult<C>> {
  try {
    return await bridge().invoke(channel, ...(args.map((a) => toPlain(a)) as IpcArgs<C>))
  } catch (err) {
    throw new ApiError(channel, errorMessage(err))
  }
}

/** Invoke and surface failures in the global snackbar before rethrowing. */
export async function invoke<C extends IpcChannel>(
  channel: C,
  ...args: IpcArgs<C>
): Promise<IpcResult<C>> {
  try {
    return await invokeSilent(channel, ...args)
  } catch (err) {
    useNotify().error(errorMessage(err))
    if (err instanceof ApiError) err.notified = true
    throw err
  }
}

export function on<E extends IpcEventChannel>(
  channel: E,
  listener: (payload: IpcEventMap[E]) => void
): () => void {
  return bridge().on(channel, listener)
}

export function newOperationId(prefix = 'op'): string {
  const rnd = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : Math.random().toString(36).slice(2)
  return `${prefix}-${rnd}`
}

export const api = {
  invoke,
  invokeSilent,
  on,
  app: {
    info: () => invoke('app:info'),
    openPath: (path: string) => invoke('app:openPath', path),
    showInFolder: (path: string) => invoke('app:showInFolder', path),
    pickDirectory: (title: string) => invoke('app:pickDirectory', title),
    pickFile: (title: string, filters?: { name: string; extensions: string[] }[]) =>
      invoke('app:pickFile', title, filters),
    startupNotices: () => invokeSilent('app:startupNotices'),
    dismissStartupNotice: (id: string) => invokeSilent('app:dismissStartupNotice', id),
    /** Only GitHub release pages/downloads of ElectronDB (main rejects anything else). */
    openExternal: (url: string) => invoke('app:openExternal', url)
  },
  tour: {
    state: () => invokeSilent('tour:state'),
    markWelcomeDone: () => invokeSilent('tour:markWelcomeDone')
  },
  updates: {
    /** Never throws for network problems: they come back as status 'error'. */
    check: (manual: boolean) => invokeSilent('updates:check', manual),
    dismiss: (version: string) => invoke('updates:dismiss', version),
    snooze: () => invokeSilent('updates:snooze'),
    whatsNew: () => invokeSilent('updates:whatsNew'),
    markSeen: (version: string) => invokeSilent('updates:markSeen', version)
  },
  settings: {
    get: () => invoke('settings:get'),
    update: (patch: Parameters<typeof invoke<'settings:update'>>[1]) =>
      invoke('settings:update', patch)
  },
  connections: {
    list: () => invoke('connections:list'),
    get: (id: string) => invoke('connections:get', id),
    save: (input: ConnectionInput) => invoke('connections:save', input),
    delete: (id: string) => invoke('connections:delete', id),
    test: (input: ConnectionInput, password: string | null, sshPassword: string | null) =>
      invoke('connections:test', input, password, sshPassword),
    setPassword: (id: string, password: string | null) =>
      invoke('connections:setPassword', id, password),
    hasPassword: (id: string) => invokeSilent('connections:hasPassword', id),
    setSshPassword: (id: string, password: string | null) =>
      invoke('connections:setSshPassword', id, password),
    hasSshPassword: (id: string) => invokeSilent('connections:hasSshPassword', id),
    open: (id: string) => invoke('connections:open', id),
    close: (id: string) => invoke('connections:close', id),
    isOpen: (id: string) => invokeSilent('connections:isOpen', id)
  },
  db: {
    databases: (c: string) => invokeSilent('db:databases', c),
    tables: (c: string, s: string) => invokeSilent('db:tables', c, s),
    views: (c: string, s: string) => invokeSilent('db:views', c, s),
    routines: (c: string, s: string) => invokeSilent('db:routines', c, s),
    events: (c: string, s: string) => invokeSilent('db:events', c, s),
    triggers: (c: string, s: string) => invokeSilent('db:triggers', c, s),
    columns: (c: string, s: string, t: string) => invoke('db:columns', c, s, t),
    tableStructure: (c: string, s: string, t: string) => invoke('db:tableStructure', c, s, t),
    showCreate: (c: string, s: string, type: ObjectType, name: string) =>
      invoke('db:showCreate', c, s, type, name),
    tableData: (c: string, req: TableDataRequest) => invokeSilent('db:tableData', c, req),
    tableFilterSql: (c: string, s: string, t: string, filter: TableFilter) =>
      invokeSilent('db:tableFilterSql', c, s, t, filter),
    filterProfiles: (c: string, s: string, t: string) => invokeSilent('filters:list', c, s, t),
    saveFilterProfile: (c: string, s: string, t: string, name: string, filter: TableFilter) =>
      invoke('filters:save', c, s, t, name, filter),
    deleteFilterProfile: (c: string, s: string, t: string, name: string) =>
      invoke('filters:delete', c, s, t, name),
    applyRowChanges: (
      c: string,
      s: string,
      t: string,
      changes: RowChange[],
      options?: WriteOptions
    ) => invoke('db:applyRowChanges', c, s, t, changes, options),
    execute: (c: string, sql: string, options?: QueryExecuteOptions) =>
      invoke('db:execute', c, sql, options),
    users: (c: string) => invoke('db:users', c),
    dropObject: (c: string, s: string, type: ObjectType, name: string, options?: WriteOptions) =>
      invoke('db:dropObject', c, s, type, name, options),
    createDatabase: (
      c: string,
      name: string,
      charset: string,
      collation: string,
      options?: WriteOptions
    ) => invoke('db:createDatabase', c, name, charset, collation, options),
    dropDatabase: (c: string, name: string, options?: WriteOptions) =>
      invoke('db:dropDatabase', c, name, options),
    charsets: (c: string) => invoke('db:charsets', c)
  },
  backups: {
    list: (c: string, schema?: string | null) => invokeSilent('backups:list', c, schema),
    meta: (path: string) => invoke('backups:meta', path),
    objectDdl: (path: string, uuid: string) => invoke('backups:objectDdl', path, uuid),
    create: (operationId: string, options: BackupCreateOptions) =>
      invoke('backups:create', operationId, options),
    restore: (operationId: string, options: RestoreOptions) =>
      invoke('backups:restore', operationId, options),
    delete: (path: string) => invoke('backups:delete', path),
    cancel: (operationId: string) => invoke('backups:cancel', operationId)
  },
  jobs: {
    list: () => invoke('jobs:list'),
    get: (id: string) => invoke('jobs:get', id),
    save: (input: JobInput, options?: WriteOptions) => invoke('jobs:save', input, options),
    delete: (id: string) => invoke('jobs:delete', id),
    run: (id: string, options?: WriteOptions) => invoke('jobs:run', id, options),
    cancel: (runId: string) => invoke('jobs:cancel', runId),
    runs: (jobId: string | null, limit?: number) => invoke('jobs:runs', jobId, limit),
    runLog: (runId: string) => invoke('jobs:runLog', runId),
    scheduleStatus: (id: string) => invokeSilent('jobs:scheduleStatus', id),
    /** Plan of a run (its id) or of backup files picked in the backups list. */
    rollbackPlan: (source: string | RollbackFilesSource, targetConnectionId: string | null) =>
      invokeSilent('jobs:rollbackPlan', source, targetConnectionId),
    rollback: (request: RollbackRequest, options?: WriteOptions) =>
      invokeSilent('jobs:rollback', request, options)
  },
  navicat: {
    detect: (rootPath?: string | null) => invoke('navicat:detect', rootPath),
    previewConnections: (rootPath?: string | null) =>
      invoke('navicat:previewConnections', rootPath),
    previewJobs: (rootPath?: string | null) => invoke('navicat:previewJobs', rootPath),
    import: (request: NavicatImportRequest, rootPath?: string | null) =>
      invoke('navicat:import', request, rootPath),
    recoverPasswords: () => invoke('navicat:recoverPasswords'),
    /** Silent: an automatic search must never pop an error snackbar. */
    findCandidates: () => invokeSilent('navicat:findCandidates')
  },
  /** AI assistant. Keys are only ever sent to main (setKey/test/listModels), never read back. */
  ai: {
    providers: () => invoke('ai:providers'),
    saveProvider: (input: AiProviderInput) => invoke('ai:saveProvider', input),
    deleteProvider: (id: string) => invoke('ai:deleteProvider', id),
    testProvider: (input: AiProviderInput, key: string | null) =>
      invokeSilent('ai:testProvider', input, key),
    setKey: (id: string, key: string | null) => invoke('ai:setKey', id, key),
    hasKey: (id: string) => invokeSilent('ai:hasKey', id),
    listModels: (input: AiProviderInput, key: string | null) =>
      invokeSilent('ai:listModels', input, key),
    chat: (request: AiChatRequest) => invokeSilent('ai:chat', request),
    cancel: (requestId: string) => invokeSilent('ai:cancel', requestId),
    conversations: (connectionId: string) => invokeSilent('ai:conversations', connectionId),
    conversation: (connectionId: string, id: string) =>
      invokeSilent('ai:conversation', connectionId, id),
    saveConversation: (input: AiConversationInput) => invoke('ai:saveConversation', input),
    deleteConversation: (connectionId: string, id: string) =>
      invoke('ai:deleteConversation', connectionId, id),
    memory: (connectionId: string, schema: string | null) =>
      invokeSilent('ai:memory', connectionId, schema),
    setMemory: (connectionId: string, schema: string | null, text: string) =>
      invoke('ai:setMemory', connectionId, schema, text),
    contextPreview: (request: AiContextRequest) => invokeSilent('ai:contextPreview', request)
  }
}
