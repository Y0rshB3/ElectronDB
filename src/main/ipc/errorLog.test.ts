import { describe, expect, it } from 'vitest'
import { MysqlUserError } from '../mysql/errors'
import { describeForLog, IpcError } from './errorLog'

describe('describeForLog', () => {
  it('keeps the message of our own user-facing errors', () => {
    expect(describeForLog(new MysqlUserError('Falta la contraseña'))).toBe('Falta la contraseña')
    expect(describeForLog(new IpcError('Ruta no válida'))).toBe('Ruta no válida')
  })

  it('drops server messages that may quote row data', () => {
    const err = Object.assign(new Error("Duplicate entry 'ana@example.com' for key 'email'"), {
      code: 'ER_DUP_ENTRY',
      errno: 1062
    })
    const text = describeForLog(err)
    expect(text).toBe('Error ER_DUP_ENTRY errno 1062')
    expect(text).not.toContain('ana@example.com')
  })

  it('handles non-error values', () => {
    expect(describeForLog('secret text')).toBe('string')
    expect(describeForLog(null)).toBe('object')
  })
})
