import type { AppContext } from '../context'
import { checkBackupPassword } from '../backup/create'

/**
 * Passwords of jobs' encrypted .vqb backups. One per job, kept in the
 * credential store (`backupKey:<jobId>`, encrypted with the OS key like the
 * connection passwords) so scheduled and launchd runs can encrypt without
 * anyone typing it. Never written to jobs.json, the run log or the renderer.
 */

type KeyContext = Pick<AppContext, 'credentials'>

export const BACKUP_KEY = 'backupKey' as const

export const MISSING_JOB_PASSWORD =
  'El paso cifra la copia pero la tarea no tiene contraseña de cifrado guardada: edita la tarea y escríbela.'

export function jobBackupPassword(ctx: KeyContext, jobId: string): string | null {
  if (!jobId) return null
  try {
    return ctx.credentials.get(BACKUP_KEY, jobId)
  } catch {
    // An unreadable entry (profile copied from another machine) is the same as none.
    return null
  }
}

export function hasJobBackupPassword(ctx: KeyContext, jobId: string): boolean {
  return !!jobId && ctx.credentials.has(BACKUP_KEY, jobId)
}

/** Stores (or with null, deletes) a job's backup password. */
export function setJobBackupPassword(
  ctx: KeyContext,
  jobId: string,
  password: string | null
): void {
  const value = checkBackupPassword(password)
  ctx.credentials.set(BACKUP_KEY, jobId, value)
}
