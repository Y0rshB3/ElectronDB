/**
 * Lets the first 'before-quit' listener veto a quit for the other listeners
 * (Electron calls every listener even after preventDefault): services that
 * stop work on quit check `quitVetoed(event)` first.
 */

const vetoed = new WeakSet<object>()

export function vetoQuit(event: { preventDefault(): void }): void {
  event.preventDefault()
  vetoed.add(event)
}

export function quitVetoed(event: object): boolean {
  return vetoed.has(event)
}

/** Text of the «a restore is running» quit prompt (kept here so it is unit tested). */
export function restoreQuitPrompt(jobNames: string[]): { message: string; detail: string } {
  const names = [...new Set(jobNames)].map((n) => `«${n}»`).join(', ')
  return {
    message: 'Hay una restauración en curso',
    detail:
      `${names} está reemplazando bases de datos. Si sales ahora se cancela y la base de datos ` +
      'que se está restaurando puede quedar borrada o incompleta. Para volver al estado anterior ' +
      'tendrías que restaurar su copia previa desde Copias de seguridad con «Reemplazar la base de datos completa».'
  }
}
