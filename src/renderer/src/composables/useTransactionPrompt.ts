import { reactive } from 'vue'
import type { TabSessionState, TransactionStatus } from '@shared/types'
import { api } from '@renderer/api'
import { typedTarget, useConfirm } from '@renderer/composables/useConfirm'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'

/**
 * Query tabs with their own session (PostgreSQL, D12): before a tab closes or
 * moves to another database or connection with an open (or failed)
 * transaction, the user chooses «Confirmar» (COMMIT), «Deshacer» (ROLLBACK)
 * or «Cancelar». The three-way dialog is TransactionPromptHost.vue, mounted
 * once next to the tab strip.
 */
export type TransactionChoice = 'commit' | 'rollback' | 'cancel'

export interface TransactionPromptState {
  open: boolean
  title: string
  message: string
  /** A failed transaction can only be rolled back. */
  failed: boolean
  resolve: ((choice: TransactionChoice) => void) | null
}

export const transactionPrompt = reactive<TransactionPromptState>({
  open: false,
  title: '',
  message: '',
  failed: false,
  resolve: null
})

/** Opens the dialog; a pending one is cancelled first. */
export function askTransactionChoice(
  title: string,
  message: string,
  failed = false
): Promise<TransactionChoice> {
  transactionPrompt.resolve?.('cancel')
  return new Promise((resolve) => {
    Object.assign(transactionPrompt, { open: true, title, message, failed, resolve })
  })
}

export function answerTransactionPrompt(choice: TransactionChoice): void {
  const resolve = transactionPrompt.resolve
  Object.assign(transactionPrompt, { open: false, resolve: null })
  resolve?.(choice)
}

export function useTransactionPrompt() {
  const connections = useConnectionsStore()
  const { confirmDestructive } = useConfirm()
  const notify = useNotify()

  /**
   * COMMIT of a tab session. A guarded connection (production, Ajustes ›
   * Seguridad) asks for the typed name first: committing is a write.
   * Resolves the new state, or null when the user cancelled or it failed.
   */
  async function commit(connectionId: string, key: string): Promise<TabSessionState | null> {
    const guarded = connections.needsTypedConfirm(connectionId)
    if (guarded) {
      const ok = await confirmDestructive({
        connectionId,
        title: `Confirmar la transacción en ${typedTarget(connections.get(connectionId))}`,
        message: 'Se ejecutará COMMIT: los cambios de la transacción abierta quedarán guardados.',
        confirmText: 'Confirmar (COMMIT)'
      })
      if (!ok) return null
    }
    try {
      return await api.db.commit(
        connectionId,
        key,
        guarded ? { confirmProduction: true } : undefined
      )
    } catch {
      return null // api.invoke already showed the error
    }
  }

  async function rollback(connectionId: string, key: string): Promise<TabSessionState | null> {
    try {
      return await api.db.rollback(connectionId, key)
    } catch {
      return null
    }
  }

  /**
   * Before leaving a tab session: nothing to do when its transaction is idle;
   * otherwise ask Confirmar / Deshacer / Cancelar and run the choice.
   * `status` skips the db:sessionState round trip when the caller knows it.
   * Resolves false when the user cancelled (or the COMMIT failed).
   */
  async function settleTransaction(
    connectionId: string,
    key: string,
    action: string,
    status?: TransactionStatus
  ): Promise<boolean> {
    let current = status
    if (current === undefined) {
      try {
        current = (await api.db.sessionState(connectionId, key)).transactionStatus
      } catch (err) {
        notify.warning(errorMessage(err))
        return true // the session is gone: nothing left to commit
      }
    }
    if (current === 'idle') return true
    const failed = current === 'failed'
    const choice = await askTransactionChoice(
      failed ? 'Transacción abortada' : 'Transacción abierta',
      failed
        ? `La transacción de esta pestaña falló y solo se puede deshacer. ${action} la deshará (ROLLBACK).`
        : `Esta pestaña tiene una transacción sin confirmar. Antes de ${action.toLowerCase()}, ¿confirmas (COMMIT) o deshaces (ROLLBACK) sus cambios?`,
      failed
    )
    if (choice === 'cancel') return false
    if (choice === 'commit') return (await commit(connectionId, key)) !== null
    await rollback(connectionId, key)
    return true
  }

  return { commit, rollback, settleTransaction }
}
