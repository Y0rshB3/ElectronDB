import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { BackupFile, ConnectionConfig, EngineId, Environment } from '@shared/types'

/** One affected object or statement listed in a confirmation. */
export interface ConfirmItem {
  /** Object name or SQL statement (already truncated), shown in monospace. */
  text: string
  /** Short tag such as "DROP TABLE" or "Fila". */
  tag?: string
  /** Highlighted warning such as "sin WHERE: afecta a todas las filas". */
  warning?: string
}

export interface ConfirmRequest {
  title: string
  message: string
  /** Extra emphasised details such as SQL or object names. */
  details?: string
  confirmText?: string
  color?: string
  /** When set, the user must type this text to enable the confirm button. */
  requireTyped?: string
  /**
   * Typed-name confirmation of a guarded connection (production or an
   * environment chosen in Ajustes › Seguridad): red, persistent, with a banner.
   */
  production?: boolean
  /** Environment named in that banner (defaults to production). */
  typedEnvironment?: Environment
  /** Information only: a single acknowledge button, no "Cancelar". */
  notice?: boolean
  /** Destructive operation: red confirm button and "Cancelar" focused by default. */
  danger?: boolean
  /** Connection the operation runs on, shown with its environment pill. */
  connection?: { name: string; environment: Environment }
  /** Exact objects or statements affected, listed in a scrollable box. */
  items?: ConfirmItem[]
}

/** How the Navicat import dialog should open (set by the welcome tour). */
export interface ImportDialogRequest {
  /** Folder already confirmed by the user: detect it and jump to «Seleccionar». */
  rootPath?: string
  /** «No es esta carpeta»: stay on step 1, skip the automatic proposal, offer the folder picker. */
  chooseFolder?: boolean
  /** Opened from the «Importar…» wizard: the dialog offers «Otros orígenes» to go back. */
  fromWizard?: boolean
}

export interface ConfirmState extends ConfirmRequest {
  open: boolean
  resolve: ((value: boolean) => void) | null
}

export const useUiStore = defineStore('ui', () => {
  const infoPanelVisible = ref(true)
  const logDrawerVisible = ref(false)
  const treeWidth = ref(260)
  const infoWidth = ref(280)
  /** AI assistant panel: right side, alternating with Información. */
  const aiPanelVisible = ref(false)
  const aiWidth = ref(400)

  const connectionDialog = ref<{
    open: boolean
    editing: ConnectionConfig | null
    /** Engine preselected for a new connection (absent = MySQL). */
    engine?: EngineId
  }>({
    open: false,
    editing: null
  })
  /** «Importar…» wizard (every source); the Navicat folder flow is `importDialog`. */
  const importWizard = ref(false)
  /** Navicat folder import (connections, jobs and .nb3 copies). */
  const importDialog = ref(false)
  /** Options of the last openImportDialog() call, read once by the dialog when it opens. */
  const importDialogRequest = ref<ImportDialogRequest | null>(null)
  /** A guided tour is on screen: queued popups wait for it like for any modal. */
  const tourActive = ref(false)
  const settingsDialog = ref(false)
  /** «Acerca de Vortaq». */
  const aboutDialog = ref(false)
  const newDatabaseDialog = ref<{ open: boolean; connectionId: string | null }>({
    open: false,
    connectionId: null
  })
  const backupDialog = ref<{
    open: boolean
    connectionId: string | null
    schema: string | null
    /** «Exportar a .sql…» opens the dialog on the .sql format; absent = .nb3. */
    format?: 'nb3' | 'sql'
  }>({
    open: false,
    connectionId: null,
    schema: null
  })
  const restoreDialog = ref<{
    open: boolean
    backup: BackupFile | null
    connectionId: string | null
    /** Open in «Reemplazar la base de datos completa» mode (undo of a rollback). */
    replace?: boolean
  }>({ open: false, backup: null, connectionId: null })

  /** Objects list presentation, shared so the choice survives tab switches. */
  const objectsViewMode = ref<'list' | 'grid'>('list')

  const confirm = ref<ConfirmState>({ open: false, title: '', message: '', resolve: null })

  function openConnectionDialog(editing: ConnectionConfig | null = null, engine?: EngineId): void {
    connectionDialog.value = engine ? { open: true, editing, engine } : { open: true, editing }
  }
  function openNewDatabaseDialog(connectionId: string): void {
    newDatabaseDialog.value = { open: true, connectionId }
  }
  function openBackupDialog(
    connectionId: string,
    schema: string | null = null,
    options: { format?: 'nb3' | 'sql' } = {}
  ): void {
    backupDialog.value = { open: true, connectionId, schema, format: options.format ?? 'nb3' }
  }
  function openRestoreDialog(
    backup: BackupFile,
    connectionId: string | null,
    options: { replace?: boolean } = {}
  ): void {
    restoreDialog.value = { open: true, backup, connectionId, replace: options.replace === true }
  }

  /** «Importar…»: the source list of the import wizard. */
  function openImportWizard(): void {
    importWizard.value = true
  }

  /** Navicat folder import (the welcome tour opens it with a confirmed folder). */
  function openImportDialog(request: ImportDialogRequest | null = null): void {
    importDialogRequest.value = request
    importDialog.value = true
  }
  function openSettingsDialog(): void {
    settingsDialog.value = true
  }
  function openAboutDialog(): void {
    aboutDialog.value = true
  }
  function toggleLogDrawer(value?: boolean): void {
    logDrawerVisible.value = value ?? !logDrawerVisible.value
  }
  function toggleInfoPanel(value?: boolean): void {
    infoPanelVisible.value = value ?? !infoPanelVisible.value
    if (infoPanelVisible.value) aiPanelVisible.value = false
  }
  function toggleAiPanel(value?: boolean): void {
    aiPanelVisible.value = value ?? !aiPanelVisible.value
    if (aiPanelVisible.value) infoPanelVisible.value = false
  }

  function ask(request: ConfirmRequest): Promise<boolean> {
    if (confirm.value.resolve) confirm.value.resolve(false)
    return new Promise((resolve) => {
      confirm.value = { ...request, open: true, resolve }
    })
  }

  function answer(value: boolean): void {
    const resolve = confirm.value.resolve
    confirm.value = { ...confirm.value, open: false, resolve: null }
    resolve?.(value)
  }

  return {
    infoPanelVisible,
    logDrawerVisible,
    treeWidth,
    infoWidth,
    aiPanelVisible,
    aiWidth,
    connectionDialog,
    importWizard,
    importDialog,
    importDialogRequest,
    tourActive,
    settingsDialog,
    aboutDialog,
    newDatabaseDialog,
    backupDialog,
    restoreDialog,
    confirm,
    objectsViewMode,
    openConnectionDialog,
    openImportDialog,
    openImportWizard,
    openSettingsDialog,
    openAboutDialog,
    toggleLogDrawer,
    toggleInfoPanel,
    toggleAiPanel,
    openNewDatabaseDialog,
    openBackupDialog,
    openRestoreDialog,
    ask,
    answer
  }
})
