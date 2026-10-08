import { describe, expect, it } from 'vitest'
import { describeError, MysqlUserError } from './errors'

const server = (errno: number, code: string, sqlMessage: string) =>
  Object.assign(new Error(sqlMessage), { errno, code, sqlState: 'HY000', sqlMessage })
const socket = (code: string, message: string) => Object.assign(new Error(message), { code })

describe('describeError (MySQL/MariaDB)', () => {
  it.each([
    [1045, 'ER_ACCESS_DENIED_ERROR', "Access denied for user 'u'@'h'", 'Usuario o contraseña incorrectos'],
    [1049, 'ER_BAD_DB_ERROR', "Unknown database 'x'", 'La base de datos no existe'],
    [1062, 'ER_DUP_ENTRY', "Duplicate entry for key 'PRIMARY'", 'Valor duplicado'],
    [1451, 'ER_ROW_IS_REFERENCED_2', 'Cannot delete or update a parent row', 'Otras filas dependen'],
    [1452, 'ER_NO_REFERENCED_ROW_2', 'Cannot add or update a child row', 'El valor no existe en la tabla referenciada'],
    [1142, 'ER_TABLEACCESS_DENIED_ERROR', 'SELECT command denied', 'La cuenta conectada no tiene privilegios suficientes']
  ])('explains errno %i in Spanish, then the marked server text and the code', (errno, code, text, es) => {
    const out = describeError(server(errno, code, text))
    expect(out.startsWith(es)).toBe(true)
    expect(out).toContain(`. Mensaje del servidor: ${text}`)
    expect(out.endsWith(`(${code} ${errno})`)).toBe(true)
  })

  it('marks an unexplained server reply as the server message', () => {
    expect(describeError(server(9999, 'ER_X', 'Something odd'))).toBe(
      'Mensaje del servidor: Something odd (ER_X 9999)'
    )
  })

  it('explains socket errors (refused, timeout) and keeps the driver text as detail', () => {
    expect(describeError(socket('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:1'))).toBe(
      'El servidor rechazó la conexión: comprueba que está arrancado y que escucha en ese host y puerto. Detalle: connect ECONNREFUSED 127.0.0.1:1 (ECONNREFUSED)'
    )
    expect(describeError(socket('ETIMEDOUT', 'connect ETIMEDOUT'))).toMatch(
      /^El servidor no respondió a tiempo.*Detalle: connect ETIMEDOUT \(ETIMEDOUT\)$/
    )
  })

  it('leaves Vortaq and other errors unmarked', () => {
    expect(describeError(new MysqlUserError('Falta algo'))).toBe('Falta algo (E_MYSQL_USER)')
    expect(describeError(socket('ENOENT', 'no such file'))).toBe('no such file (ENOENT)')
  })
})
