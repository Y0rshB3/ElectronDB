import type {
  AppInfo,
  AppSettings,
  ApplyRowChangesResult,
  BackupCreateOptions,
  BackupCreateResult,
  BackupFile,
  BackupMeta,
  ColumnInfo,
  ConnectionConfig,
  ConnectionInput,
  ConnectionTestResult,
  DatabaseInfo,
  EventInfo,
  Job,
  JobInput,
  JobLogEvent,
  JobRun,
  KeychainRecoveryResult,
  LogEvent,
  NavicatCandidatesResult,
  NavicatConnectionPreview,
  NavicatDetection,
  NavicatImportRequest,
  NavicatImportResult,
  NavicatJobPreview,
  ObjectType,
  ProgressEvent,
  QueryExecuteOptions,
  QueryStatementResult,
  RestoreOptions,
  RestoreResult,
  RollbackFilesSource,
  RollbackPlan,
  RollbackRequest,
  RoutineInfo,
  RowChange,
  ServerInfo,
  StartupNotice,
  TableDataPage,
  TableDataRequest,
  TableFilter,
  TableFilterProfile,
  TableInfo,
  TableStructure,
  TriggerInfo,
  UpdateCheckResult,
  UpdateInstallState,
  WhatsNewInfo,
  UserInfo,
  ViewInfo,
  WriteOptions
} from './types'
import type {
  AiChatRequest,
  AiChatStart,
  AiContextPreview,
  AiContextRequest,
  AiConversation,
  AiConversationInput,
  AiConversationSummary,
  AiDeltaEvent,
  AiDoneEvent,
  AiProviderInput,
  AiProviderView,
  AiStatusEvent,
  AiTestResult
} from './ai'
import type { TourState } from './tour'

/**
 * Request/response channels (ipcRenderer.invoke / ipcMain.handle).
 * Each key maps to { args, result }. Adding a channel here is enough for
 * preload and renderer typing.
 */
export interface IpcInvokeMap {
  'app:info': { args: []; result: AppInfo }
  'app:openPath': { args: [path: string]; result: void }
  'app:showInFolder': { args: [path: string]; result: void }
  'app:pickDirectory': { args: [title: string]; result: string | null }
  'app:pickFile': {
    args: [title: string, filters?: { name: string; extensions: string[] }[]]
    result: string | null
  }
  /** One-off messages for the user after start (e.g. passwords to type again after the rename). */
  'app:startupNotices': { args: []; result: StartupNotice[] }
  'app:dismissStartupNotice': { args: [id: string]; result: void }
  /**
   * Opens a URL in the default browser. Main only accepts this repository's
   * GitHub release pages and downloads (https://github.com/<owner>/<repo>/releases/...).
   */
  'app:openExternal': { args: [url: string]; result: void }

  /** Looks for a newer GitHub release. Automatic checks (manual=false) use a 6-hour cache. */
  'updates:check': { args: [manual: boolean]; result: UpdateCheckResult }
  /** «Omitir esta versión»: no automatic notice for that version. */
  'updates:dismiss': { args: [version: string]; result: void }
  /** «Más tarde»: no automatic update popup for the next 6 hours. */
  'updates:snooze': { args: []; result: void }
  /** «Novedades» to show once after an update (null: nothing to show). */
  'updates:whatsNew': { args: []; result: WhatsNewInfo | null }
  /** The «novedades» popup of `version` was closed. */
  'updates:markSeen': { args: [version: string]; result: void }
  /** Current in-app download/installation state (also pushed as event:updateInstall). */
  'updates:installState': { args: []; result: UpdateInstallState }
  /**
   * «Descargar y actualizar»: starts downloading `version` (or the newer one the update feed
   * offers) inside the app. Resolves when the download starts; progress arrives as events.
   */
  'updates:download': { args: [version: string]; result: UpdateInstallState }
  /** Cancels the running download (the partial file is discarded). */
  'updates:cancelDownload': { args: []; result: UpdateInstallState }
  /**
   * «Reiniciar y actualizar»: Windows/Linux quit, install silently and start the new version;
   * macOS opens the downloaded .dmg again.
   */
  'updates:install': { args: []; result: void }

  'settings:get': { args: []; result: AppSettings }
  'settings:update': { args: [patch: Partial<AppSettings>]; result: AppSettings }

  'connections:list': { args: []; result: ConnectionConfig[] }
  'connections:get': { args: [id: string]; result: ConnectionConfig | null }
  'connections:save': { args: [input: ConnectionInput]; result: ConnectionConfig }
  'connections:delete': { args: [id: string]; result: void }
  'connections:test': {
    args: [input: ConnectionInput, password: string | null, sshPassword: string | null]
    result: ConnectionTestResult
  }
  'connections:setPassword': { args: [id: string, password: string | null]; result: void }
  'connections:hasPassword': { args: [id: string]; result: boolean }
  'connections:setSshPassword': { args: [id: string, password: string | null]; result: void }
  'connections:hasSshPassword': { args: [id: string]; result: boolean }
  'connections:open': { args: [id: string]; result: ServerInfo }
  'connections:close': { args: [id: string]; result: void }
  'connections:isOpen': { args: [id: string]; result: boolean }

  'db:databases': { args: [connectionId: string]; result: DatabaseInfo[] }
  'db:tables': { args: [connectionId: string, schema: string]; result: TableInfo[] }
  'db:views': { args: [connectionId: string, schema: string]; result: ViewInfo[] }
  'db:routines': { args: [connectionId: string, schema: string]; result: RoutineInfo[] }
  'db:events': { args: [connectionId: string, schema: string]; result: EventInfo[] }
  'db:triggers': { args: [connectionId: string, schema: string]; result: TriggerInfo[] }
  'db:columns': {
    args: [connectionId: string, schema: string, table: string]
    result: ColumnInfo[]
  }
  'db:tableStructure': {
    args: [connectionId: string, schema: string, table: string]
    result: TableStructure
  }
  'db:showCreate': {
    args: [connectionId: string, schema: string, type: ObjectType, name: string]
    result: string
  }
  'db:tableData': { args: [connectionId: string, request: TableDataRequest]; result: TableDataPage }
  /** Saved filter profiles of one table (userData/filter-profiles.json). */
  'filters:list': {
    args: [connectionId: string, schema: string, table: string]
    result: TableFilterProfile[]
  }
  /** Creates or replaces the profile `name`; returns the table's profiles. */
  'filters:save': {
    args: [connectionId: string, schema: string, table: string, name: string, filter: TableFilter]
    result: TableFilterProfile[]
  }
  'filters:delete': {
    args: [connectionId: string, schema: string, table: string, name: string]
    result: TableFilterProfile[]
  }
  /** WHERE text (without the keyword) main would run for a structured filter; '' when empty. */
  'db:tableFilterSql': {
    args: [connectionId: string, schema: string, table: string, filter: TableFilter]
    result: string
  }
  'db:applyRowChanges': {
    args: [
      connectionId: string,
      schema: string,
      table: string,
      changes: RowChange[],
      options?: WriteOptions
    ]
    result: ApplyRowChangesResult
  }
  'db:execute': {
    args: [connectionId: string, sql: string, options?: QueryExecuteOptions]
    result: QueryStatementResult[]
  }
  'db:users': { args: [connectionId: string]; result: UserInfo[] }
  'db:dropObject': {
    args: [
      connectionId: string,
      schema: string,
      type: ObjectType,
      name: string,
      options?: WriteOptions
    ]
    result: void
  }
  'db:createDatabase': {
    args: [
      connectionId: string,
      name: string,
      charset: string,
      collation: string,
      options?: WriteOptions
    ]
    result: void
  }
  'db:dropDatabase': {
    args: [connectionId: string, name: string, options?: WriteOptions]
    result: void
  }
  'db:charsets': {
    args: [connectionId: string]
    result: { charset: string; defaultCollation: string; collations: string[] }[]
  }

  'backups:list': { args: [connectionId: string, schema?: string | null]; result: BackupFile[] }
  'backups:meta': { args: [path: string]; result: BackupMeta }
  'backups:objectDdl': { args: [path: string, uuid: string]; result: string }
  'backups:create': {
    args: [operationId: string, options: BackupCreateOptions]
    result: BackupCreateResult
  }
  'backups:restore': { args: [operationId: string, options: RestoreOptions]; result: RestoreResult }
  'backups:delete': { args: [path: string]; result: void }
  'backups:cancel': { args: [operationId: string]; result: void }

  'jobs:list': { args: []; result: Job[] }
  'jobs:get': { args: [id: string]; result: Job | null }
  'jobs:save': { args: [input: JobInput, options?: WriteOptions]; result: Job }
  'jobs:delete': { args: [id: string]; result: void }
  'jobs:run': { args: [id: string, options?: WriteOptions]; result: JobRun }
  'jobs:cancel': { args: [runId: string]; result: void }
  'jobs:runs': { args: [jobId: string | null, limit?: number]; result: JobRun[] }
  'jobs:runLog': { args: [runId: string]; result: string }
  'jobs:scheduleStatus': {
    args: [id: string]
    result: { inApp: boolean; launchAgent: boolean; nextRun: string | null }
  }
  /**
   * Backups «Restaurar todo» would restore into `targetConnectionId`: those of a
   * finished run (its id) or the given backup files (a package of the backups list).
   */
  'jobs:rollbackPlan': {
    args: [source: string | RollbackFilesSource, targetConnectionId: string | null]
    result: RollbackPlan
  }
  /** Starts the restore of a run's backups (REPLACE semantics); resolves with the new run. */
  'jobs:rollback': { args: [request: RollbackRequest, options?: WriteOptions]; result: JobRun }

  'navicat:detect': { args: [rootPath?: string | null]; result: NavicatDetection }
  'navicat:previewConnections': {
    args: [rootPath?: string | null]
    result: NavicatConnectionPreview[]
  }
  'navicat:previewJobs': { args: [rootPath?: string | null]; result: NavicatJobPreview[] }
  'navicat:import': {
    args: [request: NavicatImportRequest, rootPath?: string | null]
    result: NavicatImportResult
  }
  'navicat:recoverPasswords': { args: []; result: KeychainRecoveryResult }
  /**
   * Looks for Navicat data folders in the usual places of this OS (read-only,
   * no network, nothing cached). Only folders whose Common/conn.plist parses.
   */
  'navicat:findCandidates': { args: []; result: NavicatCandidatesResult }

  /** Onboarding state; decides once per profile whether the welcome tour is due. */
  'tour:state': { args: []; result: TourState }
  /** The welcome tour was finished or skipped (also after a replay). */
  'tour:markWelcomeDone': { args: []; result: TourState }

  /*
   * AI assistant (bring your own key). Keys go renderer -> main only: no channel
   * returns a key. Requests and the model's answers never contain row data.
   */
  'ai:providers': { args: []; result: AiProviderView[] }
  'ai:saveProvider': { args: [input: AiProviderInput]; result: AiProviderView }
  'ai:deleteProvider': { args: [id: string]; result: void }
  /** Minimal request with the stored key, or with `key` when given (not saved). */
  'ai:testProvider': {
    args: [input: AiProviderInput, key: string | null]
    result: AiTestResult
  }
  /** Stores (or with null/'' removes) the provider's API key in CredentialStore. */
  'ai:setKey': { args: [id: string, key: string | null]; result: void }
  'ai:hasKey': { args: [id: string]; result: boolean }
  /** Model IDs reported by the provider (`key` as in test); [] when it cannot list them. */
  'ai:listModels': { args: [input: AiProviderInput, key: string | null]; result: string[] }
  /** Starts a streamed answer; text arrives as event:aiDelta, the end as event:aiDone. */
  'ai:chat': { args: [request: AiChatRequest]; result: AiChatStart }
  'ai:cancel': { args: [requestId: string]; result: void }
  'ai:conversations': { args: [connectionId: string]; result: AiConversationSummary[] }
  'ai:conversation': {
    args: [connectionId: string, id: string]
    result: AiConversation | null
  }
  'ai:saveConversation': { args: [input: AiConversationInput]; result: AiConversation }
  'ai:deleteConversation': { args: [connectionId: string, id: string]; result: void }
  /** «Memoria»: notes of a connection (schema null) or of one of its databases. */
  'ai:memory': { args: [connectionId: string, schema: string | null]; result: string }
  'ai:setMemory': {
    args: [connectionId: string, schema: string | null, text: string]
    result: void
  }
  /** Exact instructions + context that a request would send («Ver contexto enviado»). */
  'ai:contextPreview': { args: [request: AiContextRequest]; result: AiContextPreview }
}

export type IpcChannel = keyof IpcInvokeMap
export type IpcArgs<C extends IpcChannel> = IpcInvokeMap[C]['args']
export type IpcResult<C extends IpcChannel> = IpcInvokeMap[C]['result']

/** Push channels (main -> renderer). */
export interface IpcEventMap {
  'event:progress': ProgressEvent
  'event:jobRun': JobRun
  'event:log': LogEvent
  'event:connectionClosed': { connectionId: string; reason: string }
  'event:jobLog': JobLogEvent
  /** App menu «Buscar actualizaciones…»: the renderer opens its updates dialog. */
  'event:checkUpdates': null
  /** Progress and result of the in-app update download. */
  'event:updateInstall': UpdateInstallState
  /** Streamed text of an AI answer. */
  'event:aiDelta': AiDeltaEvent
  /** Progress note of an AI request (fetching more structure…). */
  'event:aiStatus': AiStatusEvent
  /** End of an AI answer (done, refused, cancelled or failed). */
  'event:aiDone': AiDoneEvent
}

export type IpcEventChannel = keyof IpcEventMap

export const IPC_INVOKE_CHANNELS: readonly IpcChannel[] = [
  'app:info',
  'app:openPath',
  'app:showInFolder',
  'app:pickDirectory',
  'app:pickFile',
  'app:startupNotices',
  'app:dismissStartupNotice',
  'app:openExternal',
  'updates:check',
  'updates:dismiss',
  'updates:snooze',
  'updates:whatsNew',
  'updates:markSeen',
  'updates:installState',
  'updates:download',
  'updates:cancelDownload',
  'updates:install',
  'settings:get',
  'settings:update',
  'connections:list',
  'connections:get',
  'connections:save',
  'connections:delete',
  'connections:test',
  'connections:setPassword',
  'connections:hasPassword',
  'connections:setSshPassword',
  'connections:hasSshPassword',
  'connections:open',
  'connections:close',
  'connections:isOpen',
  'db:databases',
  'db:tables',
  'db:views',
  'db:routines',
  'db:events',
  'db:triggers',
  'db:columns',
  'db:tableStructure',
  'db:showCreate',
  'db:tableData',
  'db:tableFilterSql',
  'filters:list',
  'filters:save',
  'filters:delete',
  'db:applyRowChanges',
  'db:execute',
  'db:users',
  'db:dropObject',
  'db:createDatabase',
  'db:dropDatabase',
  'db:charsets',
  'backups:list',
  'backups:meta',
  'backups:objectDdl',
  'backups:create',
  'backups:restore',
  'backups:delete',
  'backups:cancel',
  'jobs:list',
  'jobs:get',
  'jobs:save',
  'jobs:delete',
  'jobs:run',
  'jobs:cancel',
  'jobs:runs',
  'jobs:runLog',
  'jobs:scheduleStatus',
  'jobs:rollbackPlan',
  'jobs:rollback',
  'navicat:detect',
  'navicat:previewConnections',
  'navicat:previewJobs',
  'navicat:import',
  'navicat:recoverPasswords',
  'navicat:findCandidates',
  'tour:state',
  'tour:markWelcomeDone',
  'ai:providers',
  'ai:saveProvider',
  'ai:deleteProvider',
  'ai:testProvider',
  'ai:setKey',
  'ai:hasKey',
  'ai:listModels',
  'ai:chat',
  'ai:cancel',
  'ai:conversations',
  'ai:conversation',
  'ai:saveConversation',
  'ai:deleteConversation',
  'ai:memory',
  'ai:setMemory',
  'ai:contextPreview'
] as const

export const IPC_EVENT_CHANNELS: readonly IpcEventChannel[] = [
  'event:progress',
  'event:jobRun',
  'event:log',
  'event:connectionClosed',
  'event:jobLog',
  'event:checkUpdates',
  'event:updateInstall',
  'event:aiDelta',
  'event:aiStatus',
  'event:aiDone'
] as const

/** Typed API surface exposed on window.electronDB by the preload script. */
export interface ElectronDBApi {
  /** Host OS (process.platform: 'darwin', 'win32', 'linux'…), for OS-specific UI. */
  readonly platform: string
  invoke<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>>
  on<E extends IpcEventChannel>(channel: E, listener: (payload: IpcEventMap[E]) => void): () => void
}
