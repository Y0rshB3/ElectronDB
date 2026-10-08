import type { QueryStatementResult } from '@shared/types'

/** MySQL error numbers that mean the connected account lacks privileges. */
const PRIVILEGE_ERRNOS = ['1044', '1045', '1142', '1143', '1227', '1370', '3530']

export function isPrivilegeError(message: string): boolean {
  return (
    PRIVILEGE_ERRNOS.some((n) => new RegExp(`\\b${n}\\)?$`).test(message.trim())) ||
    /access denied/i.test(message)
  )
}

/** Adds a Spanish hint to raw server errors when they are caused by missing privileges. */
export function friendlyError(message: string): string {
  // Main already put a Spanish explanation before the server's text.
  if (message.includes('. Mensaje del servidor: ')) return message
  if (isPrivilegeError(message)) {
    return `La cuenta conectada no tiene privilegios suficientes para esta operación. Pide a un administrador los permisos necesarios. Detalle: ${message}`
  }
  return message
}

/** First failing statement of a db:execute result, if any. */
export function firstError(results: QueryStatementResult[]): string | null {
  return results.find((r) => r.error)?.error ?? null
}
