import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { BackupFile, ConnectionConfig } from '@shared/types'

export interface ConfirmRequest {
  title: string
  message: string
  /** Extra emphasised details such as SQL or object names. */
  details?: string
  confirmText?: string
  color?: string
  /** When set, the user must type this text to enable the confirm button. */
  requireTyped?: string
  production?: boolean
  /** Information only: a single acknowledge button, no "Cancelar". */
  notice?: boolean
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

  const connectionDialog = ref<{ open: boolean; editing: ConnectionConfig | null }>({
    open: false,
    editing: null
  })
  const importDialog = ref(false)
  const settingsDialog = ref(false)
  const newDatabaseDialog = ref<{ open: boolean; connectionId: string | null }>({
    open: false,
    connectionId: null
  })
  const backupDialog = ref<{ open: boolean; connectionId: string | null; schema: string | null }>({
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

  function openConnectionDialog(editing: ConnectionConfig | null = null): void {
    connectionDialog.value = { open: true, editing }
  }
  function openNewDatabaseDialog(connectionId: string): void {
    newDatabaseDialog.value = { open: true, connectionId }
  }
  function openBackupDialog(connectionId: string, schema: string | null = null): void {
    backupDialog.value = { open: true, connectionId, schema }
  }
  function openRestoreDialog(
    backup: BackupFile,
    connectionId: string | null,
    options: { replace?: boolean } = {}
  ): void {
    restoreDialog.value = { open: true, backup, connectionId, replace: options.replace === true }
  }

  function openImportDialog(): void {
    importDialog.value = true
  }
  function openSettingsDialog(): void {
    settingsDialog.value = true
  }
  function toggleLogDrawer(value?: boolean): void {
    logDrawerVisible.value = value ?? !logDrawerVisible.value
  }
  function toggleInfoPanel(value?: boolean): void {
    infoPanelVisible.value = value ?? !infoPanelVisible.value
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
    connectionDialog,
    importDialog,
    settingsDialog,
    newDatabaseDialog,
    backupDialog,
    restoreDialog,
    confirm,
    objectsViewMode,
    openConnectionDialog,
    openImportDialog,
    openSettingsDialog,
    toggleLogDrawer,
    toggleInfoPanel,
    openNewDatabaseDialog,
    openBackupDialog,
    openRestoreDialog,
    ask,
    answer
  }
})
