import { describe, expect, it } from 'vitest'
import { describeError } from './errors'

const pg = (code: string, message: string, extra: Record<string, string> = {}) =>
  Object.assign(new Error(message), { code, ...extra })

describe('describeError (PostgreSQL)', () => {
  it.each([
    ['28P01', 'password authentication failed for user "u"', 'Contraseña o usuario incorrectos'],
    ['3D000', 'database "x" does not exist', 'La base de datos no existe'],
    ['23505', 'duplicate key value violates unique constraint "t_pkey"', 'Valor duplicado'],
    ['23503', 'insert or update on table "c" violates foreign key constraint', 'Viola una clave foránea']
  ])('explains %s in Spanish, then the marked server text', (code, text, es) => {
    expect(describeError(pg(code, text))).toBe(`${es}. Mensaje del servidor: ${text} (${code})`)
  })

  it('keeps detail and hint after the server text', () => {
    expect(describeError(pg('23505', 'dup', { detail: 'Key (id)=(1) already exists.' }))).toBe(
      'Valor duplicado. Mensaje del servidor: dup — Key (id)=(1) already exists. (23505)'
    )
  })

  it('marks an unexplained server reply, and explains socket errors', () => {
    expect(describeError(pg('XX000', 'internal'))).toBe('Mensaje del servidor: internal (XX000)')
    expect(describeError(pg('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:1'))).toMatch(
      /^El servidor rechazó la conexión.*\. Detalle: connect ECONNREFUSED 127\.0\.0\.1:1 \(ECONNREFUSED\)$/
    )
    expect(describeError(pg('57014', 'canceling statement due to user request'))).toBe(
      'Consulta cancelada por el usuario (57014)'
    )
  })
})
