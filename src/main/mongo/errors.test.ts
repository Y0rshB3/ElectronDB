import { describe, expect, it } from 'vitest'
import { describeError, toServerError } from './errors'

const mongo = (name: string, code: number | undefined, message: string, codeName?: string) =>
  Object.assign(new Error(message), { name, code, codeName })

describe('describeError (MongoDB)', () => {
  it('explains common codes, then marks the server text', () => {
    expect(describeError(mongo('MongoServerError', 18, 'Authentication failed.', 'AuthenticationFailed'))).toBe(
      'Usuario o contraseña incorrectos. Mensaje del servidor: Authentication failed. (AuthenticationFailed 18)'
    )
    expect(describeError(mongo('MongoServerError', 11000, 'E11000 duplicate key error', 'DuplicateKey'))).toBe(
      'Clave duplicada en un índice único. Mensaje del servidor: E11000 duplicate key error (DuplicateKey 11000)'
    )
  })

  it('marks an unexplained server code and keeps driver errors as detail', () => {
    expect(describeError(mongo('MongoServerError', 9999, 'odd'))).toBe(
      'Mensaje del servidor: odd (9999)'
    )
    expect(
      describeError(toServerError(mongo('MongoServerSelectionError', undefined, 'connect ECONNREFUSED')))
    ).toMatch(/^No se pudo contactar con el servidor MongoDB a tiempo.*Detalle: connect ECONNREFUSED$/)
  })
})
