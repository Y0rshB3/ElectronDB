import { describe, expect, it } from 'vitest'
import { quitVetoed, restoreQuitPrompt, vetoQuit } from './quitGuard'

describe('quit guard', () => {
  it('a vetoed quit event is seen by the other listeners and its default is prevented', () => {
    let prevented = false
    const event = { preventDefault: () => (prevented = true) }
    expect(quitVetoed(event)).toBe(false)
    vetoQuit(event)
    expect(prevented).toBe(true)
    expect(quitVetoed(event)).toBe(true)
    expect(quitVetoed({})).toBe(false)
  })

  it('explains what quitting during a restore does and how to undo', () => {
    const prompt = restoreQuitPrompt(['Rollback a Local · Backup', 'Rollback a Local · Backup'])
    expect(prompt.message).toBe('Hay una restauración en curso')
    expect(prompt.detail).toMatch(/^«Rollback a Local · Backup» está reemplazando/)
    expect(prompt.detail).toContain('puede quedar borrada o incompleta')
    expect(prompt.detail).toContain('«Reemplazar la base de datos completa»')
  })
})
