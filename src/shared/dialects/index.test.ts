import { describe, expect, it } from 'vitest'
import type { EngineId } from '../types'
import { dialectForEngine, getDialect, mysqlDialect } from './index'
import { MYSQL_LEX } from './mysql'

describe('dialect registry', () => {
  it('ships the MySQL dialect', () => {
    expect(getDialect('mysql')).toBe(mysqlDialect)
    expect(mysqlDialect.id).toBe('mysql')
    expect(mysqlDialect.lex).toBe(MYSQL_LEX)
    expect(dialectForEngine('mysql')).toBe(mysqlDialect)
  })

  it('has no SQL dialect for MongoDB', () => {
    expect(dialectForEngine('mongodb')).toBeNull()
  })

  it('refuses dialects that are not in this build yet', () => {
    expect(() => getDialect('postgresql')).toThrow(
      'El dialecto SQL «postgresql» todavía no está disponible en esta versión.'
    )
    expect(() => dialectForEngine('mariadb')).toThrow('«mariadb»')
    expect(() => dialectForEngine('sqlite')).toThrow('«sqlite»')
  })

  it('refuses an unknown engine with the engines.ts message', () => {
    expect(() => dialectForEngine('oracle' as EngineId)).toThrow(
      'Motor de base de datos desconocido: "oracle".'
    )
  })
})
